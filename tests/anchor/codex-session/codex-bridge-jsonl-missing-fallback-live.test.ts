/**
 * Anchor A6 (plan §2.2 P1 兜底): codex 的 jsonl 无 usage 时（老版本无
 * token_count 事件、或文件损坏/未落盘），done 卡 flow 字段必须回退 live
 * result usage，不能显示 undefined/估算值。
 *
 * 验证什么行为：
 *   defaultAgent='codex'、live result usage 存在（snake_case，真正捕获）、
 *   readSessionContent 返回 usage: undefined → done 卡 flow 显示 live 值
 *   （Input 244K / Output 256K / Cached 107833K / Total 108334K）。
 *
 * 缺失/错误会导致什么：
 *   codex 走 live 优先（app-server 的 usage 是本 turn 增量）后，若 jsonl 兜底
 *   缺失，jsonl 无 usage 的会话会显示估算值（formatUsageStats estimate path）
 *   甚至空白行——真实场景中老版本
 *   codex rollout 无 token_count 事件，/resume 与 done 卡都会退化。
 *
 * 依据（spec 原文）：
 *   plan §2.2："jsonl 缺失（如老版本无 token_count）时才回退 live"；
 *   plan §2.4 测试："codex jsonl 无 usage → 回退 live（兜底路径）"。
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-fallback-'));
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

describe('Bridge codex jsonl 无 usage 回退 live (anchor)', () => {
  it('test_anchor_bridge_codex_jsonl_missing_falls_back_to_live', async () => {
    const { SessionReaderRegistry } = await import('../../../src/session/registry.js');
    // jsonl 无 usage（老版本 rollout 无 token_count）
    const readSpy = vi.fn(() => ({ events: [], usage: undefined }));
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
            session_id: 'sess-codex-fallback',
            cwd: tmpDir,
            model: 'deepseek-v4-flash',
          },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-codex-fallback',
            usage: {
              input_tokens: 244381,
              output_tokens: 256385,
              cache_read_tokens: 107833472,
              cache_creation_tokens: 0,
              total_tokens: 108334238,
            },
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

    expect(readSpy).toHaveBeenCalledWith('sess-codex-fallback', tmpDir);

    const finalCard = JSON.stringify(connector._cards.at(-1));

    // jsonl 无 usage → 回退 live result usage（显示 live 值而非估算/空白，>=1M 用 M 单位）
    expect(finalCard).toContain('Input token - 244K');
    expect(finalCard).toContain('Output token - 256K');
    expect(finalCard).toContain('Cached token - 107.8M (100%)');
    expect(finalCard).toContain('Total token - 108.3M');
  });
});
