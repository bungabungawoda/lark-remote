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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-4-router-pollution-'));
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
  run: async function* () {
    throw new Error('run not expected in stub');
  },
};

function createStubConnector() {
  return {
    sendWithRetry: async () => 'msg-id',
    sendFile: async () => 'file-msg-id',
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => 'stream-msg-id',
    updateCard: async () => {},
    connected: true,
  };
}

function createStubReader(): AgentSessionReader {
  return {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [], displayTitle: '' }),
    isSessionActive: () => false,
  };
}

function createRouter() {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
  const bridge = new Bridge({
    agentRegistry: createStubAgentRegistry(stubRunner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    connector,
    sessionStore,
    config,
  });
  const registry = new SessionReaderRegistry();
  registry.register('claude', createStubReader());
  registry.register('codex', createStubReader());
  registry.register('opencode', createStubReader());
  registry.register('pi', createStubReader());
  registry.register('kimi', createStubReader());
  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    sessionReaderRegistry: registry,
  });
  return { router, sessionStore };
}

describe('P1-4 router 卡片路径原型链污染守卫 (anchor)', () => {
  /**
   * 验证什么（target）:
   *   review.md §P1-4 的守卫只落在 src/config/index.ts 的
   *   setNestedValue/deleteNestedValue/getConfigValue（文本直写路径），但卡片
   *   config.set/config.input 走 router 私有的 setNestedValue
   *   （src/router/index.ts:1222），该函数无 key 段守卫，且各 builder 的
   *   handleFieldChange 对未知 key 原样回显 patch —— 伪造卡片 action
   *   `{ cmd: 'config.set', key: '__proto__.polluted', option: 'yes' }` 可经
   *   `current['__proto__']`（Object.prototype）写入 `polluted`，进程级污染。
   *   修复后：config.set/config.input 的 key 段一律拒绝
   *   __proto__/prototype/constructor，Object.prototype 不被污染。
   *
   * 缺失导致什么（importance）:
   *   与文本路径同等级的正确性 bug：伪造/误构造的卡片 key 让 bridge 进程
   *   Object.prototype 进入不可测状态且无任何报错（review.md §P1-4）。
   */
  it('anchor: config.set 伪造 __proto__ key 不得污染 Object.prototype', async () => {
    const { router } = createRouter();
    await router.handleCardAction(
      { cmd: 'config.set', key: '__proto__.polluted', option: 'yes' },
      ctx,
    );
    // 现状：router setNestedValue 无守卫，Object.prototype.polluted === 'yes' → RED
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('anchor: config.input 伪造 __proto__ key 不得污染 Object.prototype', async () => {
    const { router } = createRouter();
    await router.handleCardAction(
      { cmd: 'config.input', key: '__proto__.polluted', inputValue: 'yes' },
      ctx,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});
