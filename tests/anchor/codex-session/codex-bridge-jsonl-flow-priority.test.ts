/**
 * Anchor A5 (plan §2.2 P1): codex done 卡 flow 字段必须 jsonl 优先——即使 live
 * result 事件带了 usage（codex exec 的 turn.completed.usage 是会话累计
 * total_token_usage，不是本 run 增量）。
 *
 * 验证什么行为：
 *   defaultAgent='codex'、live result usage 存在（input=244381/output=256385/
 *   cacheRead=107833472/total=108334238，会话累计）且 jsonl 读出 per-turn 值
 *   （input=165/output=1363/cacheRead=445568/total=447096）时，done 卡 flow
 *   字段显示 jsonl per-turn 值（Input 165、Output 1K、Cached 446K、Total 447K），
 *   累计后缀显示 jsonl 累计值（244K/256K/107,833K/108,334K）。
 *
 * 缺失/错误会导致什么：
 *   现逻辑"live 有 input/output → 所有 flow 字段用 live scope"对 codex 不成立：
 *   live usage 是会话累计（resume 长会话可达 108M），被当成"本 run"展示 →
 *   虚高约 240 倍（实测 2026-08-01 14:01 run 的 Input 244K 其实是整个会话从
 *   12:56 起的累计）。claude/pi/opencode/kimi 的 live usage 语义是单 run/单 turn，
 *   live 优先仍正确；只有 codex 需要 jsonl 优先。
 *
 * 依据（spec 原文）：
 *   plan §2.2："this.config.defaultAgent === 'codex' 时，flow 字段一律取
 *   finalUsage（jsonl，主线程文件的 per-turn last_token_usage 语义）……jsonl
 *   缺失时才回退 live"；plan §2.3 预期表：修复后 Input 165 / Output 1,363 /
 *   Cached 445,568 / Total 447,096，累计 244K/256K/107,833K/108,334K。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentEvent, AgentRunner, Runner } from '../../../src/runner/index.js';

import { createStubAgentRegistry } from '../../lib/bridge-stubs.js';
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

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

function asCodexRunner(r: Runner): AgentRunner {
  return {
    ...r,
    kind: 'codex',
    sessionReader: {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    },
    getStatusInfo: () => ({ kind: 'codex', model: 'codex-test' }),
  };
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-flow-anchor-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'codex',
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('Bridge codex done 卡 flow 字段 jsonl 优先 (anchor)', () => {
  it('test_anchor_bridge_codex_flow_fields_jsonl_priority', async () => {
    const { SessionReaderRegistry } = await import('../../../src/session/registry.js');
    // codex 会话 jsonl（主线程文件）读出的 per-turn + 累计 usage（真实值）。
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 165, // per-turn: last_token_usage.input - cached
        outputTokens: 1363,
        cacheReadTokens: 445568,
        cacheCreationTokens: 0,
        totalTokens: 447096,
        contextLength: 445733,
        cumulativeInputTokens: 244381,
        cumulativeOutputTokens: 256385,
        cumulativeCacheReadTokens: 107833472,
        cumulativeCacheCreationTokens: 0,
        cumulativeTotalTokens: 108334238,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('codex', stubReader as never);

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const bridgeRunner = asCodexRunner(
      createStreamingRunner([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-codex-flow',
          cwd: tmpDir,
          model: 'deepseek-v4-flash',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'codex reply' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-codex-flow',
          usage: {
            // snake_case: codex exec 的 turn.completed.usage 是会话累计值，
            // 必须被 liveInputTokens/liveOutputTokens 真正捕获（否则测试会
            // 静默退化成 jsonl 兜底路径 = 伪覆盖）。
            input_tokens: 244381,
            output_tokens: 256385,
            cache_read_tokens: 107833472,
            cache_creation_tokens: 0,
            total_tokens: 108334238,
          },
        },
      ]),
    );
    const bridge = new Bridge({
      // codex 实时流：result 带 usage = 会话累计（turn.completed.usage 语义）。
      runner: bridgeRunner,
      agentRegistry: createStubAgentRegistry(bridgeRunner),
      connector,
      sessionStore,
      config,
      sessionReaderRegistry: registry,
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    expect(readSpy).toHaveBeenCalledWith('sess-codex-flow', tmpDir);

    const finalCard = JSON.stringify(connector._cards.at(-1));

    // flow 字段 = jsonl per-turn 值（live 累计值被忽略 → 现 RED：显示 244K/256K/107833K/108334K）
    expect(finalCard).toContain('Input token - 165'); // live 显示 244K
    expect(finalCard).toContain('Output token - 1K'); // live 显示 256K
    expect(finalCard).toContain('Cached token - 446K (100%)'); // live 显示 107,833K
    expect(finalCard).toContain('Total token - 447K'); // live 显示 108,334K
    // 累计后缀 = jsonl 累计值（保持正确）
    expect(finalCard).toContain('· 累计 244K');
    expect(finalCard).toContain('· 累计 256K');
    expect(finalCard).toContain('· 累计 107833K (100%)');
    expect(finalCard).toContain('· 累计 108334K');
  });
});
