import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from '../../../src/router/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { AppConfigSchema } from '../../../src/config/index.js';
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-direct-write-anchor-'));
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

function createRouter(overrides?: {
  defaultAgent?: 'claude' | 'codex' | 'opencode' | 'pi' | 'kimi';
}) {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { binary: 'claude', model: 'claude-opus-4-8', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
    ...(overrides?.defaultAgent ? { defaultAgent: overrides.defaultAgent } : {}),
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

describe('P1-6 /config 直写路径运行时传播 (anchor)', () => {
  /**
   * 验证什么（target）:
   *   `/config claude.model <model>` 文本直写后必须 clearRunners——bridge 的 runner
   *   按 (workspace, agentKind) 缓存，缓存的 claude runner 继续用旧 model 跑，
   *   /status 与真实 run 自相矛盾。旧实现的 agentConfigKeys 过滤器只匹配
   *   pi/codex/opencode/kimi + agents.*，漏掉 claude. 与 defaultAgent。
   *
   * 依据: review.md §P1-6。
   */
  it('anchor: /config claude.model 直写后 clearRunners', async () => {
    const { router, bridge } = createRouter();
    const spy = vi.spyOn(bridge, 'clearRunners');
    await router.handle('/config claude.model claude-opus-4-8', ctx);
    expect(spy).toHaveBeenCalled(); // 现状：未被调用 → RED
  });

  /**
   * 验证什么（target）:
   *   `/config idle.watchdogMinutes 5` 直写后必须 setIdleTimeout(5*60_000)。
   *   旧实现只写盘，看门狗仍是旧值直到重启。
   */
  it('anchor: /config idle.watchdogMinutes 直写后 setIdleTimeout', async () => {
    const { router, bridge } = createRouter();
    const spy = vi.spyOn(bridge, 'setIdleTimeout');
    spy.mockClear(); // 构造时已调用过一次
    await router.handle('/config idle.watchdogMinutes 5', ctx);
    expect(spy).toHaveBeenCalledWith(5 * 60_000); // 现状：未调用 → RED
  });

  /**
   * 验证什么（target）:
   *   defaultAgent 属于 agent 配置变更，直写后同样必须 clearRunners（旧过滤器漏判）。
   */
  it('anchor: /config defaultAgent 直写后 clearRunners', async () => {
    const { router, bridge } = createRouter();
    const spy = vi.spyOn(bridge, 'clearRunners');
    await router.handle('/config defaultAgent codex', ctx);
    expect(spy).toHaveBeenCalled(); // 现状：未被调用 → RED
  });

  /**
   * 验证什么（target）:
   *   `/config pi.model X`（defaultAgent=pi）直写后必须 syncAgentChoices 并落盘，
   *   agentChoices.pi 不陈旧。旧实现直写路径完全没有 syncAgentChoices。
   */
  it('anchor: /config pi.model 直写后 agentChoices 同步落盘', async () => {
    const { router, configPath } = createRouter({ defaultAgent: 'pi' });
    await router.handle('/config pi.model p-model-42', ctx);
    const disk = fs.readFileSync(configPath, 'utf-8');
    expect(disk).toContain('agentChoices');
    expect(disk).toContain('p-model-42'); // 现状：不写 agentChoices → RED
  });
});
