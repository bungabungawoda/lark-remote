/**
 * kimi 终态卡片 usage 链路：真实 KimiSessionReader → 真实 registry → 真实
 * Bridge → 卡片渲染。覆盖「有 usage.record 时展示真实聚合」与「一条都没有时
 * 不伪造全零 token 块」。
 *
 * 合并自 kimi-usage-e2e-card / kimi-usage-no-record-no-fake-zero。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { KimiSessionReader } from '../../../src/session/kimi/sessions.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentRunner, Runner } from '../../../src/runner/index.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
} from '../../lib/bridge-stubs.js';
import { asAgentRunner as wrapAgentRunner } from '../../lib/agent-runner.js';

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

// 故意给一个永不命中的 runner 内建 reader——bridge 必须走 registry 里的真实
// reader，而不是 runner 自带的。
function asAgentRunner(r: Runner): AgentRunner {
  return wrapAgentRunner(r, 'kimi', { model: 'kimi-test' });
}

let kimiDir: string;
let workDir: string;
let config: AppConfig;

beforeEach(() => {
  kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-bridge-usage-kimi-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-bridge-usage-cwd-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'kimi',
  });
});

afterEach(() => {
  fs.rmSync(kimiDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

/** 写真实 kimi session fixture（index + state + wire.jsonl）。 */
function setupSession(sessionId: string, wireLines: unknown[]): void {
  const sessionDir = path.join(kimiDir, sessionId);
  fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
  const realWorkDir = fs.realpathSync(workDir);

  fs.writeFileSync(
    path.join(kimiDir, 'session_index.jsonl'),
    JSON.stringify({ sessionId, sessionDir, workDir: realWorkDir }) + '\n',
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
  fs.writeFileSync(
    path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
    wireLines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  );
}

/** 真实依赖链：KimiSessionReader + registry + Bridge，返回终态卡片。 */
async function runBridge(sessionId: string): Promise<ReturnType<typeof createStubConnector>> {
  const registry = new SessionReaderRegistry();
  registry.register('kimi', new KimiSessionReader(kimiDir));

  const connector = createStubConnector();
  const sessionStore = new SessionStore();
  const kimiRunner = asAgentRunner(
    createStubRunner({
      mode: 'streaming',
      events: [
        {
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          cwd: workDir,
          model: 'kimi-code/k3',
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'kimi reply' }] } },
        { type: 'result', subtype: 'success', session_id: sessionId },
      ],
    }),
  );
  const bridge = new Bridge({
    agentRegistry: createStubAgentRegistry(kimiRunner),
    connector,
    sessionStore,
    config,
    sessionReaderRegistry: registry,
  });
  sessionStore.setCwd(ctx.userId, workDir);

  await bridge.forwardToClaude('hello', ctx);
  return connector;
}

function usageRecordLine(
  usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number },
  time: number,
): string {
  return JSON.stringify({
    type: 'usage.record',
    model: 'kimi-code/k3',
    usage,
    usageScope: 'turn',
    time,
  });
}

describe('kimi bridge usage', () => {
  it('test_anchor_kimi_done_card_shows_session_wide_real_usage_end_to_end', async () => {
    const sessionId = 'session_e2e_x';
    const records = [
      { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
      { inputOther: 2000, output: 200, inputCacheRead: 6000, inputCacheCreation: 300 },
      { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
    ];
    setupSession(
      sessionId,
      records.map((usage, i) => usageRecordLine(usage, 1784380436258 + i)),
    );

    const connector = await runBridge(sessionId);
    const finalCard = JSON.stringify(connector._cards.at(-1));

    // 真实聚合值（Σ 3 条 record）必须出现在终态卡片 usage 文本行。
    expect(finalCard).toContain('Input token - 6K');
    expect(finalCard).toContain('Output token - 600');
    expect(finalCard).toContain('Cache create - 900');
    expect(finalCard).toContain('Cached token - 18K (75%)');
    expect(finalCard).toContain('Total token - 26K');
    expect(finalCard).toContain('Context - 10K');

    // 反估算断言：估算路径会产出 'Output token - 1K'。
    expect(finalCard).not.toContain('Output token - 1K');
  });

  it('test_anchor_kimi_done_card_shows_no_token_block_when_jsonl_has_no_usage_record', async () => {
    const sessionId = 'session_no_usage_x';
    // 有真实的 turn/上下文事件，但零条 usage.record；末行 step.end。
    setupSession(sessionId, [
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
    ]);

    const connector = await runBridge(sessionId);
    const finalCard = JSON.stringify(connector._cards.at(-1));
    expect(finalCard).toContain('✅ 已完成');

    // jsonl 对 usage 一无所述时，不得展示累加器初值合成的零值行。
    const allCards = connector._cards.map((c) => JSON.stringify(c));
    for (const [i, cardJson] of allCards.entries()) {
      expect(
        cardJson.includes('Input token - 0'),
        `卡片#${i} 不应展示伪造的 "Input token - 0"`,
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
        `卡片#${i} 不应展示伪造的 "Cached token - 0"`,
      ).toBe(false);
      expect(
        cardJson.includes('Context - 0'),
        `卡片#${i} 不应展示伪造的 "Context - 0"（session 上下文非空，jsonl 只是没记录）`,
      ).toBe(false);
    }
  });
});
