/**
 * Probe: kimi 会话 wire.jsonl 无 usage.record 时，终态卡片不得展示伪造的全 0 token 块
 *
 * 攻击点（T6 嫌疑）：src/session/kimi/sessions.ts:259-263 把 totalUsage 初始化成
 *   { inputTokens: 0, outputTokens: 0, contextLength: 0 }，且无论 wire.jsonl 里有没有
 *   usage.record 都原样返回（return { ..., usage: totalUsage }，sessions.ts:356-361）。
 *   reader 无法区分「session 真实消耗为 0」（完成的 LLM run 不可能为 0）与
 *   「jsonl 里根本没有 usage 数据」。下游链路把这个合成零值对象当作真实数据：
 *     - bridge resolveFinalUsage 透传 inputTokens:0 / outputTokens:0 / contextLength:0
 *       （src/bridge/index.ts:1249-1259 → 1061-1062 live ?? jsonl 兜底命中 0 值）；
 *     - formatUsageStats 走真实值路径（realInput/realOutput 均 defined，
 *       src/router/index.ts:3878-3899），终态卡片渲染出：
 *         Context - 0 / Input token - 0 / Output token - 0 /
 *         Cached token - 0 (0%) / Total token - 0
 *   这五行是 reader 累加器初值，不是 jsonl 里存在的任何数字——卡片在断言
 *   「本 session 消耗 0 token、上下文占用 0」，对任何真实跑过的 session 都是假话。
 *   用户无法区分「本次免费」与「usage 追踪缺失/不可用」。
 *
 * 假设来源 = spec 精神外推（spec 未明说无数据时如何显示——spec 缺口）：
 *   spec 要求 jsonl 作为数据源、对齐 ccusage 范式。jsonl 是数据源；
 *   当 jsonl 对 usage 一无所述时，如实显示 = 不显示 token 块（formatUsageStats
 *   估算路径本就有「全空则不输出任何 token 行」的护栏，src/router/index.ts:3904-3905
 *   inputRef>0||cacheRead>0||cacheCreation>0 才输出），而不是展示合成零值。
 *   注意与 R5 probe 的区别：R5 是「存在 record 但字段残缺 → 缺失字段按 0 计」；
 *   本条是「一条 record 都没有 → 整个 usage 对象不应存在」。部分缺失按 0 是
 *   聚合语义，整体缺失按 0 是凭空造数。
 *   现实触发形态：kimi 协议演进（sessions.ts:64-66 注释自述旧版本/截断的
 *   wire.jsonl 可能整条缺 usage 对象）、LLM 调用未发出即结束的 turn、
 *   手改/损坏的 wire.jsonl。
 *
 * 期望行为（当前 RED）：终态卡片（及同 run 的任何卡片）不出现伪造零值行；
 *   run 本身正常完成，卡片仍应有 ✅ 已完成。
 *   修复落点建议（绿 agent 参考，非强制）：reader 在无 usage.record 时返回
 *   usage: undefined，下游 bridge/renderer 现有 undefined 护栏自然省略 token 块。
 *
 * fixture：真实 KimiSessionReader + tmp wire.jsonl（turn.prompt + 文本 + step.end，
 *   零条 usage.record）→ 真实 registry → 真实 Bridge → 真实卡片渲染（同
 *   tests/anchor/kimi/kimi-usage-e2e-card.test.ts 的全链路结构）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';
import { KimiSessionReader } from '../../src/session/kimi/sessions.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { AgentEvent, AgentRunner, Runner } from '../../src/runner/index.js';

import { createStubAgentRegistry } from '../lib/bridge-stubs.js';
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// --- 边界测试替身（仅 runner/connector；同 tests/anchor/kimi/kimi-usage-e2e-card.test.ts 模式） ---

function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  const cards: object[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async (chatId: string, filePath: string) => {
      sent.push({ chatId, input: { file: filePath }, opts: undefined });
      return 'file-msg-id';
    },
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async (
      chatId: string,
      initial: object,
      producer: (controller: {
        messageId: string;
        current: object;
        update(next: object | ((current: object) => object)): Promise<void>;
      }) => Promise<void>,
      opts?: unknown,
    ) => {
      sent.push({ chatId, input: { card: initial }, opts });
      cards.push(initial);
      let current = initial;
      await producer({
        messageId: 'stream-msg-id',
        get current() {
          return current;
        },
        update: async (next) => {
          current = typeof next === 'function' ? next(current) : next;
          cards.push(current);
        },
      });
      return 'stream-msg-id';
    },
    updateCard: async (_messageId: string, card: object) => {
      cards.push(card);
    },
    connected: true,
    _sent: sent,
    _cards: cards,
  };
}

function createStreamingRunner(events: AgentEvent[]): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      for (const e of events) yield e;
    },
  };
}

/** Wrap a stub Runner with AgentRunner fields。 */
function asKimiRunner(r: Runner): AgentRunner {
  return {
    ...r,
    kind: 'kimi',
    sessionReader: {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    },
    getStatusInfo: () => ({ kind: 'kimi', model: 'kimi-test' }),
  };
}

const SESSION_ID = 'session_no_usage_x';

describe('kimi done card must not fabricate an all-zero token block when jsonl has no usage.record (probe)', () => {
  let kimiDir: string;
  let workDir: string;
  let config: AppConfig;

  beforeEach(() => {
    kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-norecord-kimi-'));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-norecord-cwd-'));

    const sessionDir = path.join(kimiDir, SESSION_ID);
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });

    // reader 校验 state.workDir === fs.realpathSync(cwd)（src/session/kimi/sessions.ts:234）
    const realWorkDir = fs.realpathSync(workDir);

    fs.writeFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: SESSION_ID, sessionDir, workDir: realWorkDir }) + '\n',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T01:00:00.000Z',
        title: 't',
        isCustomTitle: false,
        workDir: realWorkDir,
      }),
    );
    // wire.jsonl：有真实的 turn/上下文事件，但零条 usage.record。
    // 末行 step.end 使 isSessionActive=false（排除后台运行干扰）。
    const wireLines = [
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'hello' }],
        origin: { kind: 'user' },
        time: 1784380436258,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', step: 1, part: { type: 'text', text: 'kimi reply' } },
        time: 1784380436259,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', step: 1 },
        time: 1784380436260,
      },
    ];
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      wireLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );

    config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
      defaultAgent: 'kimi',
      output: {
        showThinking: true,
        showToolUse: false,
        showToolResult: false,
      },
    });
  });

  afterEach(() => {
    fs.rmSync(kimiDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

  it('test_probe_kimi_done_card_shows_no_token_block_when_jsonl_has_no_usage_record', async () => {
    // 真实依赖链：真实 KimiSessionReader（读上面的无 usage.record fixture）+ 真实 registry。
    const registry = new SessionReaderRegistry();
    registry.register('kimi', new KimiSessionReader(kimiDir));

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const bridgeRunner = asKimiRunner(
      createStreamingRunner([
        {
          type: 'system',
          subtype: 'init',
          session_id: SESSION_ID,
          cwd: workDir,
          model: 'kimi-code/k3',
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'kimi reply' }] } },
        { type: 'result', subtype: 'success', session_id: SESSION_ID },
      ]),
    );
    const bridge = new Bridge({
      // kimi 实时事件流：system.init → assistant 文本 → result(success, 无 usage)。
      agentRegistry: createStubAgentRegistry(bridgeRunner),
      connector,
      sessionStore,
      config,
      sessionReaderRegistry: registry,
    });
    sessionStore.setCwd(ctx.userId, workDir);

    await bridge.forwardToClaude('hello', ctx);

    // run 正常完成：终态卡片应有 ✅ 已完成（formatUsageStats 恒输出该行，
    // src/router/index.ts:3855；无论走哪条 usage 分支都在）。
    const finalCard = JSON.stringify(connector._cards.at(-1));
    expect(finalCard).toContain('✅ 已完成');

    // 核心断言：jsonl 对 usage 一无所述时，任何卡片（终态 run 卡片 / 完成通知卡片）
    // 都不得展示 reader 累加器初值合成的零值行。这些数字不在 jsonl 里，是伪造数据。
    // 当前实现 RED：reader 返回 {inputTokens:0, outputTokens:0, contextLength:0} →
    // 终态卡片出现 Context - 0 / Input token - 0 / Output token - 0 /
    // Cached token - 0 (0%) / Total token - 0。
    const allCards = connector._cards.map((c) => JSON.stringify(c));
    for (const [i, cardJson] of allCards.entries()) {
      expect(
        cardJson.includes('Input token - 0'),
        `卡片#${i} 不应展示伪造的 "Input token - 0"（jsonl 无 usage.record，0 是累加器初值而非真实值）`,
      ).toBe(false);
      expect(
        cardJson.includes('Output token - 0'),
        `卡片#${i} 不应展示伪造的 "Output token - 0"`,
      ).toBe(false);
      expect(
        cardJson.includes('Total token - 0'),
        `卡片#${i} 不应展示伪造的 "Total token - 0"`,
      ).toBe(false);
      expect(
        cardJson.includes('Cached token - 0'),
        `卡片#${i} 不应展示伪造的 "Cached token - 0 (0%)"`,
      ).toBe(false);
      expect(
        cardJson.includes('Context - 0'),
        `卡片#${i} 不应展示伪造的 "Context - 0"（session 上下文非空，jsonl 只是没记录）`,
      ).toBe(false);
    }
  });
});
