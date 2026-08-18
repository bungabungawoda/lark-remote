/**
 * Anchor A5 (plan §2.2 P1, 2026-08-14 修订): codex app-server 的 live usage 是
 * 本 turn 增量（协议 tokenUsage.last），与 opencode 一致走 live 优先；jsonl 的
 * per-turn 值不得覆盖 live；累计后缀仍来自 jsonl。
 *
 * 验证什么行为：
 *   defaultAgent='codex'、runner 声明 usageAuthority='live'、live result usage
 *   存在（input=200/output=2000/cacheRead=400000/total=402200，本 turn 增量）
 *   且 jsonl 读出 per-turn 值（input=165/output=1363/cacheRead=445568/
 *   total=447096）与累计值时，done 卡 flow 字段显示 live 值（Input 200、
 *   Output 2K、Cached 400K、Total 402K），累计后缀显示 jsonl 累计值
 *   （244K/256K/107,833K/108,334K）。
 *
 * 缺失/错误会导致什么：
 *   若重新引入「codex jsonl 优先」例外（exec 时代 live usage 是会话累计），
 *   live 增量会被 jsonl per-turn 值覆盖，done 卡显示错误的本 run 数值。
 *   本测试守护 codex 与其他 agent 一致的 live 优先不变量。
 */
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
function asCodexRunner(r: Runner): AgentRunner {
  return {
    ...r,
    kind: 'codex',
    getUsageAuthority: () => 'live' as const,
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

describe('Bridge codex done 卡 flow 字段 live 优先 (anchor)', () => {
  it('test_anchor_bridge_codex_flow_fields_live_priority', async () => {
    const { SessionReaderRegistry } = await import('../../../src/session/registry.js');
    // codex 会话 jsonl（主线程文件）读出的 per-turn + 累计 usage。
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
      createStubRunner({
        mode: 'streaming',
        events: [
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
              // snake_case: codex app-server 的 turn.completed.usage 是本 turn
              // 增量（tokenUsage.last 语义），live 值必须被真正捕获并展示。
              input_tokens: 200,
              output_tokens: 2000,
              cache_read_tokens: 400000,
              cache_creation_tokens: 0,
              total_tokens: 402200,
            },
          },
        ],
      }),
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

    // flow 字段 = live 本 turn 增量（jsonl per-turn 值不得覆盖）
    expect(finalCard).toContain('Input token - 200'); // jsonl per-turn 165
    expect(finalCard).toContain('Output token - 2K'); // jsonl per-turn 1K
    expect(finalCard).toContain('Cached token - 400K (100%)'); // jsonl per-turn 446K
    expect(finalCard).toContain('Total token - 402K'); // jsonl per-turn 447K
    // 累计后缀 = jsonl 累计值（保持正确，>=1M 用 M 单位）
    expect(finalCard).toContain('· 累计 244K');
    expect(finalCard).toContain('· 累计 256K');
    expect(finalCard).toContain('· 累计 107.8M (100%)');
    expect(finalCard).toContain('· 累计 108.3M');
  });
});
