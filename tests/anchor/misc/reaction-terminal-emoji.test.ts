/**
 * Adversarial TDD anchor —— reaction 表情按运行终态区分（spec 2026-08-02 用户确认）
 *
 * 验证什么：coding agent 运行以 error 终态结束时，贴在用户原消息上的
 *   connector.addReaction 必须收到 'ERROR'，而不是 'Done'。
 * 缺失/错误会导致什么：失败的单子会显示成功表情，用户扫一眼误判为完成，
 *   与 spec「error → ERROR、失败不能用 done」冲突。
 * 依据：round-log spec（用户 2026-08-02 确认）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Runner } from '../../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
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

// --- Stubs（Bridge 边界测试替身，与 src/bridge/bridge.test.ts 同模式） ---

function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  const cards: object[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async (chatId: string, filePath: string) => {
      sent.push({ chatId, input: { file: filePath }, opts: undefined });
      return 'file-msg-id';
    },
    reconnect: async () => {},
    addReaction: vi.fn().mockResolvedValue(undefined),
    streamCard: async (
      chatId: string,
      initial: object,
      producer: (controller: {
        messageId: string;
        current: object;
        update(next: object | ((current: object) => object)): Promise<void>;
      }) => Promise<void>,
      opts?: unknown,
    ) => {
      sent.push({ chatId, input: { card: initial }, opts });
      cards.push(initial);
      let current = initial;
      await producer({
        messageId: 'stream-msg-id',
        get current() {
          return current;
        },
        update: async (next) => {
          current = typeof next === 'function' ? next(current) : next;
          cards.push(current);
        },
      });
      return 'stream-msg-id';
    },
    updateCard: async (_messageId: string, card: object) => {
      cards.push(card);
    },
    connected: true,
    _sent: sent,
    _cards: cards,
  };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('reaction emoji by run terminal (anchor)', () => {
  let tmpDir: string;
  let config: AppConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-reaction-anchor-'));
    config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { binary: 'claude', model: 'opus', stopGraceMs: 5000 },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * 验证什么：runner 直接抛错 → run 终态为 error → reaction 必须是 'ERROR'。
   * 缺失/错误会导致什么：失败的单子显示 Done（成功表情），误导用户。
   * 依据：round-log spec「error → 'ERROR'」。
   */
  it('test_anchor_run_error_terminal_adds_error_reaction', async () => {
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        throw new Error('claude died');
      },
    };
    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
      idleTimeoutMs: 60_000,
    });

    await bridge.forwardToClaude('hello', ctx);

    expect(connector.addReaction).toHaveBeenCalledWith(ctx.messageId, 'ERROR');
  });

  /**
   * 验证什么：空闲看门狗超时 → run 终态为 idle_timeout → reaction 必须是 'Alarm'。
   * 缺失/错误会导致什么：超时的单子显示 Done（成功表情），与 spec「idle_timeout → 'Alarm'」冲突。
   * 依据：round-log spec（用户 2026-08-02 确认）。
   */
  it('test_anchor_idle_timeout_terminal_adds_alarm_reaction', async () => {
    vi.useFakeTimers();
    try {
      let resolveHang: () => void = () => {};
      const hangPromise = new Promise<void>((resolve) => {
        resolveHang = resolve;
      });
      const runner: Runner = {
        isRunning: false,
        stop: async () => {
          resolveHang();
        },
        killOrphan: () => {},
        registerExitHandlers: () => {},
        run: async function* () {
          await hangPromise;
        },
      };
      const connector = createStubConnector();
      const sessionStore = new SessionStore();
      sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));
      const bridge = new Bridge({
        runner,
        agentRegistry: createStubAgentRegistry(runner),
        sessionReaderRegistry: createStubSessionReaderRegistry(),
        connector,
        sessionStore,
        config,
        idleTimeoutMs: 1000,
      });

      const promise = bridge.forwardToClaude('hello', ctx);
      // Cross the idle timeout so the watchdog fires → runner.stop() → idle_timeout terminal
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(connector.addReaction).toHaveBeenCalledWith(ctx.messageId, 'Alarm');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 验证什么：用户主动 /stop（interruptCurrentRun）→ run 终态为 interrupted → reaction 必须是 'SHHH'。
   * 缺失/错误会导致什么：用户叫停的单子显示 Done（成功表情），与 spec「interrupted → 'SHHH'」冲突。
   * 依据：round-log spec（用户 2026-08-02 确认）。
   */
  it('test_anchor_interrupted_terminal_adds_shhh_reaction', async () => {
    let resolveHang: () => void = () => {};
    const hangPromise = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    const runner: Runner = {
      isRunning: false,
      stop: async () => {
        resolveHang();
      },
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        await hangPromise;
      },
    };
    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
      idleTimeoutMs: 60_000,
    });

    // Step 1 (createRunSession) is synchronous, so the active run is registered
    // before the first await; interrupting then releases the hanging generator.
    const promise = bridge.forwardToClaude('hello', ctx);
    await bridge.interruptCurrentRun({ userId: ctx.userId, chatId: ctx.chatId });
    await promise;

    expect(connector.addReaction).toHaveBeenCalledWith(ctx.messageId, 'SHHH');
  });
});
