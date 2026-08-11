import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from '../../../src/router/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import { atomicWrite } from '../../../src/persistence/atomic-write.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentSessionReader, Runner } from '../../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
} from '../../lib/bridge-stubs.js';
vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  initLogger: () => ({}),
}));

vi.mock('../../../src/persistence/atomic-write.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/persistence/atomic-write.js')>();
  return { ...mod, atomicWrite: vi.fn(mod.atomicWrite) };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-save-atomic-anchor-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

const stubRunner: Runner = {
  isRunning: false,
  stop: async () => {},
  killOrphan: () => {},
  registerExitHandlers: () => {},
  getStatusInfo: () => ({ kind: 'claude', model: 'test-model' }),
  run: async function* () {
    throw new Error('run not expected in stub');
  },
};

function createStubConnector() {
  const sent: { chatId: string; input: unknown }[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown) => {
      sent.push({ chatId, input });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => 'stream-msg-id',
    updateCard: async () => {},
    connected: true,
    _sent: sent,
  };
}

function createRouter() {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
    defaultAgent: 'pi',
  });
  const configPath = path.join(tmpDir, 'config.yaml');
  const bridge = new Bridge({
    runner: stubRunner,
    agentRegistry: createStubAgentRegistry(stubRunner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    connector,
    sessionStore,
    config,
  });
  const registry = new SessionReaderRegistry();
  const reader: AgentSessionReader = {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [] }),
    isSessionActive: () => false,
  };
  for (const kind of ['claude', 'codex', 'opencode', 'pi', 'kimi'] as const) {
    registry.register(kind, reader);
  }
  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath,
    sessionReaderRegistry: registry,
  });
  return { router, sessionStore, connector, bridge, configPath };
}

describe('P1-7 config.save 二次写盘必须原子 (anchor)', () => {
  /**
   * 验证什么（target）:
   *   config.save 携带当前 agent（pi）配置变更时，setConfigValues 原子写盘一次后，
   *   agentChoices 同步（syncAgentChoices）还要再写一次。旧实现用裸同步写
   *   （截断写盘），进程写一半崩溃 → config.yaml 截断 → 下次启动 loadConfig 失败。
   *   修复后：两次写盘都必须走 atomicWrite（tmp+rename）。
   *
   * 依据: review.md §P1-7。
   */
  it('anchor: agentChoices 同步写盘走 atomicWrite', async () => {
    const { router, configPath } = createRouter();
    const spy = vi.mocked(atomicWrite);
    spy.mockClear();

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.pi.model', option: 'p-model-7' },
      ctx,
    );
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 至少一次写盘是 agentChoices 同步（内容同时含 agentChoices + p-model-7），
    // 且该次写盘必须走 atomicWrite。旧实现该次写盘用裸同步写 → spy 只有
    // setConfigValues 那一次（不含 agentChoices）→ RED。
    const agentChoicesWrites = spy.mock.calls.filter(([file, content]) => {
      return (
        file === configPath &&
        String(content).includes('agentChoices') &&
        String(content).includes('p-model-7')
      );
    });
    expect(agentChoicesWrites.length).toBeGreaterThan(0);
    // 磁盘上确实可见（真实 atomicWrite 包装仍在写）
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('p-model-7');
  });

  /**
   * 防回归 grep：src/router/index.ts 禁止出现裸同步写盘调用（历史清理防回归传统）。
   */
  it('anchor: src/router/index.ts 无裸同步写盘调用', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/router/index.ts'), 'utf-8');
    expect(src).not.toMatch(/writeFileSync/);
  });
});
