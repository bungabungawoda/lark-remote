import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { AgentKind, AgentRunner, Runner } from '../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
} from '../lib/bridge-stubs.js';
// 直接在模块顶层定义 mock（兼容 bun 的 vitest）
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// --- Stubs（同 tests/anchor/misc/bridge-kimi-usage-threading.test.ts 模式） ---
function asAgentRunner(r: Runner, kind: AgentKind): AgentRunner {
  return {
    ...r,
    kind,
    sessionReader: {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    },
    getStatusInfo: () => ({ kind, model: 'test' }),
  };
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  // 重置 mock
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-usage-scope-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'claude',
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('Bridge usage scope: live 优先、jsonl 兜底', () => {
  /**
   * 测试 1：claude 风格 result 事件使用 cache_read_input_tokens /
   * cache_creation_input_tokens 命名 → finishRun meta 的 cache 值来自 live。
   */
  it('claude 风格 result 事件：cache_read_input_tokens 命名正确提取到 live cache', async () => {
    const { SessionReaderRegistry } = await import('../../src/session/registry.js');
    // jsonl 返回 session 累计值（不应被用到 flow 字段）
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 50000,
        outputTokens: 5000,
        cacheReadTokens: 40000,
        cacheCreationTokens: 2000,
        totalTokens: 97000,
        contextLength: 95000,
        compactCount: 3,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const claudeCacheRunner = asAgentRunner(
      createStubRunner({
        mode: 'streaming',
        events: [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sess-claude-cache',
            cwd: tmpDir,
            model: 'claude-sonnet-4-20250514',
          },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'claude reply' }] } },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-claude-cache',
            usage: {
              input_tokens: 1000,
              output_tokens: 50,
              cache_read_input_tokens: 800,
              cache_creation_input_tokens: 100,
            },
          },
        ],
      }),
      'claude',
    );
    const bridge = new Bridge({
      // claude 风格：result 事件带 usage，使用 cache_read_input_tokens 命名
      runner: claudeCacheRunner,
      agentRegistry: createStubAgentRegistry(claudeCacheRunner),
      connector,
      sessionStore,
      config,
      sessionReaderRegistry: registry,
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    const finalCard = JSON.stringify(connector._cards.at(-1));

    // live 值：input=1000, output=50, cacheRead=800, cacheCreation=100
    // cache% = 800 / (1000+800) = 44%
    // total = max(undefined, 1000+50+800+100) = 1950 → 2K
    expect(finalCard).toContain('Input token - 1K'); // live 1000→1K
    expect(finalCard).toContain('Output token - 50'); // live 50
    expect(finalCard).toContain('Cached token - 800 (44%)'); // live cacheRead=800
    expect(finalCard).toContain('Cache create - 100'); // live cacheCreation=100
    expect(finalCard).toContain('Total token - 2K'); // 1950→2K
    // jsonl 的 session 累计值不应出现
    expect(finalCard).not.toContain('Input token - 50K'); // jsonl 的 50000
    expect(finalCard).not.toContain('Cached token - 40K'); // jsonl 的 40000
  });

  /**
   * 测试 2：resume 场景——jsonl 返回 session 累计，live 是本 run。
   * flow 字段全部等于 live 值，contextLength/compactCount 仍取 jsonl。
   */
  it('resume 场景：jsonl session 累计值不覆盖 live 本 run 值，contextLength 取 jsonl', async () => {
    const { SessionReaderRegistry } = await import('../../src/session/registry.js');
    // jsonl 返回 resume 后的 session 累计值
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 100000,
        outputTokens: 10000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 50000,
        totalTokens: 1_200_000,
        contextLength: 1_150_000,
        compactCount: 5,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const resumeRunner = asAgentRunner(
      createStubRunner({
        mode: 'streaming',
        events: [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sess-resume',
            cwd: tmpDir,
            model: 'claude-sonnet-4-20250514',
          },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'resume reply' }] } },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-resume',
            usage: {
              input_tokens: 1000,
              output_tokens: 50,
              cache_read_input_tokens: 800,
            },
          },
        ],
      }),
      'claude',
    );
    const bridge = new Bridge({
      // 本次 run 的 live result 只有本 run 的值
      runner: resumeRunner,
      agentRegistry: createStubAgentRegistry(resumeRunner),
      connector,
      sessionStore,
      config,
      sessionReaderRegistry: registry,
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    const finalCard = JSON.stringify(connector._cards.at(-1));

    // flow 字段 = live 本 run 值
    expect(finalCard).toContain('Input token - 1K'); // live 1000→1K
    expect(finalCard).toContain('Output token - 50'); // live 50
    expect(finalCard).toContain('Cached token - 800 (44%)'); // live 800, 800/(1000+800)=44%
    expect(finalCard).toContain('Total token - 2K'); // 1000+50+800+0=1850→2K
    // contextLength 取 jsonl（水位/历史计数）
    expect(finalCard).toContain('Context - 1.2M'); // jsonl 1_150_000 → 1.2M
    expect(finalCard).toContain('Compact - 5次'); // jsonl compactCount=5
    // jsonl 的 session 累计 flow 值不应出现
    expect(finalCard).not.toContain('Cached token - 1M ('); // jsonl 1_000_000 → 不含 "1M (" 子串
  });

  /**
   * 测试 3：kimi 场景——result 事件无 usage，jsonl 有完整 usage → flow 字段全部取 jsonl。
   */
  it('kimi 场景：无 live usage 时 jsonl 兜底所有 flow 字段', async () => {
    const { SessionReaderRegistry } = await import('../../src/session/registry.js');
    // kimi 会话 jsonl 兜底读出的完整 usage
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
    // 切换 defaultAgent 为 kimi
    const kimiConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
      defaultAgent: 'kimi',
      output: {
        showThinking: true,
        showToolUse: false,
        showToolResult: false,
      },
    });
    const kimiRunner = asAgentRunner(
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
      'kimi',
    );
    const bridge = new Bridge({
      // kimi 实时事件流：result 不带 usage
      runner: kimiRunner,
      agentRegistry: createStubAgentRegistry(kimiRunner),
      connector,
      sessionStore,
      config: kimiConfig,
      sessionReaderRegistry: registry,
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    const finalCard = JSON.stringify(connector._cards.at(-1));

    // 无 live usage → jsonl 兜底所有 flow 字段
    expect(finalCard).toContain('Input token - 5K'); // jsonl 5000→5K
    expect(finalCard).toContain('Output token - 800'); // jsonl 800
    expect(finalCard).toContain('Cached token - 2K (29%)'); // jsonl 2000, 2000/(5000+2000)=29%
    expect(finalCard).toContain('Total token - 8K'); // max(7900, 7900)=7900→8K
  });
});

describe('Bridge cumulative Total threading: done 卡必须显示累计 Total', () => {
  /**
   * 穿越完整链路 reader -> bridge.forwardToClaude -> finish('done') ->
   * RunState.cumulativeTotalTokens -> renderRunCard -> formatUsageStats。
   *
   * session reader 已返回 cumulativeTotalTokens，但 bridge 的 3 个成功路径
   * finish 调用漏传该字段（仅 catch 路径传了），导致 done 卡的 "Total token"
   * 行不带 "· 累计 X"。Input/Output 累计已透传（作对照），仅 Total 缺失。
   */
  it('正常完成(done)：Total token 行带 session 累计后缀', async () => {
    const { SessionReaderRegistry } = await import('../../src/session/registry.js');
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        // flow 字段（live 优先，此处仅占位）
        inputTokens: 50000,
        outputTokens: 5000,
        cacheReadTokens: 40000,
        cacheCreationTokens: 2000,
        totalTokens: 97000,
        contextLength: 95000,
        compactCount: 3,
        // session 累计（所有 run 之和），应作为 "· 累计 X" 透传到 done 卡
        cumulativeTotalTokens: 50000,
        cumulativeInputTokens: 46630,
        cumulativeOutputTokens: 3319,
        cumulativeCacheReadTokens: 40000,
        cumulativeCacheCreationTokens: 2000,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const cumTotalRunner = asAgentRunner(
      createStubRunner({
        mode: 'streaming',
        events: [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sess-cum-total',
            cwd: tmpDir,
            model: 'claude-sonnet-4-20250514',
          },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'done reply' }] } },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-cum-total',
            usage: {
              input_tokens: 1000,
              output_tokens: 50,
              cache_read_input_tokens: 800,
            },
          },
        ],
      }),
      'claude',
    );
    const bridge = new Bridge({
      runner: cumTotalRunner,
      agentRegistry: createStubAgentRegistry(cumTotalRunner),
      connector,
      sessionStore,
      config,
      sessionReaderRegistry: registry,
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    const finalCard = JSON.stringify(connector._cards.at(-1));

    // flow 字段 = live 本 run 值（与 test 1 同口径）
    expect(finalCard).toContain('Input token - 1K');
    expect(finalCard).toContain('Output token - 50');
    expect(finalCard).toContain('Total token - 2K');
    // 累计后缀（session-wide，从 jsonl 透传）--对照：Input/Output 已透传
    expect(finalCard).toContain('Input token - 1K · 累计 47K');
    expect(finalCard).toContain('Output token - 50 · 累计 3K');
    // 关键断言：Total 行必须带累计（RED--bridge 成功路径漏传 cumulativeTotalTokens）
    expect(finalCard).toContain('Total token - 2K · 累计 50K');
  });
});
