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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-resume-use-anchor-'));
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
    streamCard: async (
      _chatId: string,
      initial: object,
      producer: (controller: {
        messageId: string;
        current: object;
        update(next: object | ((current: object) => object)): Promise<void>;
      }) => Promise<void>,
    ) => {
      let current = initial;
      await producer({
        messageId: 'stream-msg-id',
        get current() {
          return current;
        },
        update: async (next) => {
          current = typeof next === 'function' ? next(current) : next;
        },
      });
      return 'stream-msg-id';
    },
    updateCard: async () => {},
    connected: true,
    _sent: sent,
  };
}

/**
 * claude reader：只有 'real-s1' 返回内容（校验通过），其余返回空（not found）。
 */
function createClaudeReader(): AgentSessionReader {
  return {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: (sessionId: string) =>
      sessionId === 'real-s1'
        ? {
            events: [
              {
                type: 'user',
                content: 'hello',
                timestamp: '2026-01-01T00:00:00.000Z',
              },
            ],
            displayTitle: 'hello',
          }
        : { events: [] },
    isSessionActive: () => false,
  };
}

function createRouter() {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { binary: 'claude', model: 'claude-opus-4-8', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
  const bridge = new Bridge({
    runner: stubRunner,
    agentRegistry: createStubAgentRegistry(stubRunner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    connector,
    sessionStore,
    config,
  });
  const registry = new SessionReaderRegistry();
  registry.register('claude', createClaudeReader());
  registry.register('codex', createClaudeReader());
  registry.register('opencode', createClaudeReader());
  registry.register('pi', createClaudeReader());
  registry.register('kimi', createClaudeReader());
  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    sessionReaderRegistry: registry,
  });
  return { router, sessionStore, connector };
}

describe('P1-5 resume.use 先写 sessionId 后校验 (anchor)', () => {
  /**
   * 验证什么（target）:
   *   resume.use 分支（src/router/index.ts:313-315）先无条件把 value.sessionId 写入
   *   sessionStore，再调 cmdResume 做存在性校验。校验失败（过期卡片：session 不在当前
   *   cwd）时，用户看到「未找到 session」但 store 已被污染，下一条消息会用无效
   *   sessionId 去 --resume，agent CLI 报错。修复后：校验失败不得写入。
   *
   * 缺失导致什么（importance）:
   *   过期 /resume 卡片点击 → sessionStore 绑定幽灵 sessionId，普通消息全部走
   *   无效 --resume 直到用户 /new（review.md §P1-5 构造条件）。
   *
   * 依据: review.md §P1-5 失败用例。
   */
  it('anchor: 校验失败（session 不存在）不得写入 sessionId', async () => {
    const { router, sessionStore } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handleCardAction({ cmd: 'resume.use', sessionId: 'ghost-session' }, ctx);
    // 现状：pre-write 后 getSessionId 返回 'ghost-session' → RED
    expect(sessionStore.getSessionId('user1', 'claude')).toBeUndefined();
  });

  /**
   * 验证什么（target）:
   *   value.sessionId 缺失时（314 行 targetSessionId=''）pre-write 会静默清空当前
   *   session 绑定。修复后：sessionId 缺失直接返回错误提示，不清空已有绑定。
   */
  it('anchor: sessionId 缺失不得静默清空已有绑定', async () => {
    const { router, sessionStore, connector } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    sessionStore.setSessionId('user1', 'claude', 'current-s1', fs.realpathSync(tmpDir));
    await router.handleCardAction({ cmd: 'resume.use' }, ctx);
    expect(sessionStore.getSessionId('user1', 'claude')).toBe('current-s1');
    expect((connector._sent.at(-1)?.input as { text?: string } | undefined)?.text).toContain(
      'sessionId',
    );
  });

  /**
   * 回归锁定：校验通过的 session 仍必须绑定（cmdResume :2352 的已验证路径写入）。
   * 修复前后均绿，防止「删 pre-write」误伤正常路径。
   */
  it('probe: 校验通过的 session 仍写入 sessionId', async () => {
    const { router, sessionStore } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handleCardAction({ cmd: 'resume.use', sessionId: 'real-s1' }, ctx);
    expect(sessionStore.getSessionId('user1', 'claude')).toBe('real-s1');
  });
});
