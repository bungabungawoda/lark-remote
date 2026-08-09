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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-23-config-discarded-'));
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
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
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

function createRouter(overrides?: { output?: Partial<AppConfig['output']> }) {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { binary: 'claude', model: 'claude-opus-4-8', stopGraceMs: 5000 },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
      ...overrides?.output,
    },
    idle: { watchdogMinutes: 15 },
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

describe('P2-23 /config 直写丢弃 pendingConfig 提示 (anchor)', () => {
  /**
   * 验证什么（target）:
   *   用户在 /config 卡片上点 toggle 产生 pendingConfig 差异（未点保存），
   *   随后发 `/config <key> <value>` 直写。当前 cmdConfig 在 line ~2987
   *   `this.pendingConfig = null` 静默丢弃暂存修改，没有任何提示。
   *   期望行为：返回的反馈（卡片或文本）应提示「已丢弃 N 项未保存修改」。
   *
   * 依据: P2-23 缺陷契约。
   */
  it('test_anchor_config_direct_write_warns_discarded_pending', async () => {
    // showThinking 初始 false，toggle 后 pendingConfig.showThinking = true（1 项差异）
    const { router, connector } = createRouter({
      output: { showThinking: false },
    });

    // 1. 通过卡片交互产生 pendingConfig 差异（走公开 handleCardAction 路径）
    await router.handleCardAction({ cmd: 'config.toggle', key: 'output.showThinking' }, ctx);
    // 确认 pendingConfig 确实有差异（1 项）
    const pendingConfig = (
      router as unknown as { pendingConfig: { output: { showThinking: boolean } } | null }
    ).pendingConfig;
    expect(pendingConfig).not.toBeNull();
    expect(pendingConfig!.output.showThinking).toBe(true);

    // 2. 发送 /config <key> <value> 直写命令（走公开 handle 路径）
    await router.handle('/config idle.watchdogMinutes 30', ctx);

    // 3. 直写路径返回 buildConfigCard()，经 bridge.sendResult → connector.sendWithRetry
    //    断言反馈中包含「丢弃」相关提示且体现差异条数
    const sentStr = JSON.stringify(connector._sent);
    expect(sentStr).toMatch(/丢弃/);
    // 体现差异条数（1 项未保存修改被丢弃）
    expect(sentStr).toMatch(/1\s*项/);
  });
});
