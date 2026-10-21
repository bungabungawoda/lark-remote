/**
 * Bridge codex done 卡 usage 口径：live 优先（jsonl per-turn 不覆盖 live），
 * jsonl 无 usage 时回退 live。
 *
 * 合并自 codex-bridge-jsonl-flow-priority / codex-bridge-jsonl-missing-fallback-live。
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

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-jsonl-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'codex',
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

async function runBridge(
  readSpy: ReturnType<typeof vi.fn>,
  sessionId: string,
  usage: Record<string, number>,
) {
  const { SessionReaderRegistry } = await import('../../../src/session/registry.js');
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
          session_id: sessionId,
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
          session_id: sessionId,
          usage,
        },
      ],
    }),
  );
  const bridge = new Bridge({
    runner: bridgeRunner,
    agentRegistry: createStubAgentRegistry(bridgeRunner),
    connector,
    sessionStore,
    config,
    sessionReaderRegistry: registry,
  });
  sessionStore.setCwd(ctx.userId, tmpDir);

  await bridge.forwardToClaude('hello', ctx);
  return { connector, readSpy, sessionId };
}

describe('Bridge codex jsonl usage authority', () => {
  it('test_anchor_bridge_codex_flow_fields_live_priority', async () => {
    // codex 会话 jsonl（主线程文件）读出的 per-turn + 累计 usage。
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 165,
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

    const {
      connector,
      readSpy: spy,
      sessionId,
    } = await runBridge(readSpy, 'sess-codex-flow', {
      // codex app-server 的 turn.completed.usage 是本 turn 增量（live 值）。
      input_tokens: 200,
      output_tokens: 2000,
      cache_read_tokens: 400000,
      cache_creation_tokens: 0,
      total_tokens: 402200,
    });

    expect(spy).toHaveBeenCalledWith(sessionId, tmpDir);

    const finalCard = JSON.stringify(connector._cards.at(-1));

    // flow 字段 = live 本 turn 增量（jsonl per-turn 值不得覆盖）
    expect(finalCard).toContain('Input token - 200');
    expect(finalCard).toContain('Output token - 2K');
    expect(finalCard).toContain('Cached token - 400K (100%)');
    expect(finalCard).toContain('Total token - 402K');
    // 累计后缀 = jsonl 累计值
    expect(finalCard).toContain('· 累计 244K');
    expect(finalCard).toContain('· 累计 256K');
    expect(finalCard).toContain('· 累计 107.8M (100%)');
    expect(finalCard).toContain('· 累计 108.3M');
  });

  it('test_anchor_bridge_codex_jsonl_missing_falls_back_to_live', async () => {
    // jsonl 无 usage（老版本 rollout 无 token_count）
    const readSpy = vi.fn(() => ({ events: [], usage: undefined }));

    const {
      connector,
      readSpy: spy,
      sessionId,
    } = await runBridge(readSpy, 'sess-codex-fallback', {
      input_tokens: 244381,
      output_tokens: 256385,
      cache_read_tokens: 107833472,
      cache_creation_tokens: 0,
      total_tokens: 108334238,
    });

    expect(spy).toHaveBeenCalledWith(sessionId, tmpDir);

    const finalCard = JSON.stringify(connector._cards.at(-1));

    // jsonl 无 usage → 回退 live result usage（>=1M 用 M 单位）
    expect(finalCard).toContain('Input token - 244K');
    expect(finalCard).toContain('Output token - 256K');
    expect(finalCard).toContain('Cached token - 107.8M (100%)');
    expect(finalCard).toContain('Total token - 108.3M');
  });
});
