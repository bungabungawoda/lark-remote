import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentRunner, Runner } from '../../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
} from '../../lib/bridge-stubs.js';
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
/** Wrap a stub Runner with AgentRunner fields（同 bridge.test.ts 的 asAgentRunner）。 */
function asAgentRunner(r: Runner): AgentRunner {
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

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-kimi-usage-anchor-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'kimi',
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('Bridge threads jsonl input/output tokens to kimi done card (anchor)', () => {
  /**
   * Anchor: kimi 终态卡片必须显示 jsonl 读出的真实 inputTokens/outputTokens。
   *
   * 验证什么（target）:
   *   kimi 的实时事件流不含 usage（只有 assistant/meta 事件，result 不带 usage），
   *   run 结束后 bridge 通过 resolveFinalUsage 从会话 jsonl 兜底读 usage
   *   （src/bridge/index.ts:1220-1256）。该返回对象必须把 jsonl 的
   *   inputTokens/outputTokens 一并透传到 cardSession.finish 的 meta，
   *   使终态卡片的 formatUsageStats（src/router/index.ts:3832+）走"真实值路径"。
   *
   * 缺失导致什么（importance）:
   *   现实现 resolveFinalUsage 手工窄化返回对象，丢弃 inputTokens/outputTokens；
   *   finish meta 的 inputTokens/outputTokens 只来自 live result 事件（kimi 恒为
   *   undefined，src/bridge/index.ts:1069-1080）。终态卡片因此走 formatUsageStats
   *   的"估算路径"：Input = contextLength + cacheRead（缓存重复计）、
   *   Output = contextLength × 10%——数值失真，误导用户。
   *   本场景数值（jsonl: input 5000 / output 800 / cacheRead 2000 / cacheCreate 100 /
   *   total 7900 / contextLength 7300）下两路径显示完全不同：
   *     真实路径（期望）: Input token - 5K / Output token - 800 / Total token - 8K /
   *                       Cached token - 2K (29%)
   *     估算路径（现状）: Input token - 9K (7300+2000=9300→9K) / Output token - 730
   *                       (7300×10%) / Total token - 10K (9300+730+100=10130→10K) /
   *                       Cached token - 2K (22%)
   *   格式化依据 src/router/index.ts:3818-3824 formatTokenK: n>=1000 →
   *   Math.round(n/1000)+"K"（7900→8K、9300→9K、10130→10K），n<1000 → 原值（800→"800"）。
   *
   * 依据 spec（spec_basis）:
   *   spec 要求 jsonl 作为数据源——live result 事件没有 usage 时，
   *   终态卡片必须用 jsonl 读出的真实 inputTokens/outputTokens。
   */
  it('test_anchor_bridge_threads_jsonl_input_output_tokens_to_done_card', async () => {
    const { SessionReaderRegistry } = await import('../../../src/session/registry.js');
    // kimi 会话 jsonl 兜底读出的完整 usage（真实值）。
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 5000,
        outputTokens: 800,
        cacheReadTokens: 2000,
        cacheCreationTokens: 100,
        totalTokens: 7900,
        contextLength: 7300,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('kimi', stubReader as never);

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const bridgeRunner = asAgentRunner(
      createStubRunner({
        mode: 'streaming',
        events: [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sess-kimi-usage',
            cwd: tmpDir,
            model: 'kimi-code/k3',
          },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'kimi reply' }] } },
          { type: 'result', subtype: 'success', session_id: 'sess-kimi-usage' },
        ],
      }),
    );
    const bridge = new Bridge({
      // kimi 实时事件流：system.init → assistant 文本 → result(success, 无 usage)。
      runner: bridgeRunner,
      agentRegistry: createStubAgentRegistry(bridgeRunner),
      connector,
      sessionStore,
      config,
      sessionReaderRegistry: registry,
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    // 兜底确认：done 路径确实读了 kimi 会话 jsonl。
    expect(readSpy).toHaveBeenCalledWith('sess-kimi-usage', tmpDir);

    // 终态卡片 = stub connector 收到的最后一次 card update（streaming 成功路径）。
    const finalCard = JSON.stringify(connector._cards.at(-1));

    // 真实值（jsonl）必须出现在终态卡片 usage 文本行：
    expect(finalCard).toContain('Input token - 5K'); // 真实 5000→5K；估算路径显示 9K（现 RED）
    expect(finalCard).toContain('Output token - 800'); // 真实 800；估算路径显示 730（现 RED）
    expect(finalCard).toContain('Total token - 8K'); // 真实 max(7900, 7900)=7900→8K；估算显示 10K
    expect(finalCard).toContain('Cached token - 2K (29%)'); // 真实 cacheRead，cache% = 2000/(5000+2000)；估算路径显示 22%
  });
});
