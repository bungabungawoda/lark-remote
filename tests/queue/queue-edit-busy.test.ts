import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner } from '../../src/runner/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

import { createStubAgentRegistry, createStubSessionReaderRegistry } from '../lib/bridge-stubs.js';
// 直接在模块顶层定义 mock（兼容 bun 的 vitest）
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

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
    addReaction: async () => {},
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

function createStubRunner(): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      throw new Error('run not expected in stub');
    },
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-edit-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      binary: 'claude',
      model: 'opus',
      stopGraceMs: 5000,
    },
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue.edit misleading error when busy', () => {
  it('test_anchor_handleQueueEdit_does_not_say_task_started_executing_for_queued_task', async () => {
    // Bug: handleQueueEdit checks isBusyFor(workspace) and if true, returns
    // "⚠️ 任务已开始执行，无法编辑". But the task being edited is QUEUED —
    // it hasn't started executing. Another task is running in the workspace.
    // The error message is misleading: it says THIS task has started
    // executing when it hasn't.

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    // Task 1: starts immediately, hangs (blocks the queue)
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        await hang1;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-1',
          messagePreview: 'task 1 running',
        },
      },
    );

    // Give task 1 time to start
    await new Promise((r) => setTimeout(r, 50));

    // Task 2: queued behind task 1 (gets a queue card)
    bridge.enqueue(
      tmpDir,
      async () => {
        /* quick */
      },
      {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-2', messagePreview: 'queued task' },
      },
    );

    // Wait for queue card to be sent
    await new Promise((r) => setTimeout(r, 100));

    // Verify task 2 is in the queue (it's queued, NOT executing)
    const task = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(task).toBeDefined();

    // Spy on isBusyFor to simulate a busy workspace (another task running)
    vi.spyOn(bridge, 'isBusyFor').mockReturnValue(true);

    // Simulate clicking "✏️ 编辑" on task 2's queue card
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    await router.handleCardAction(
      { cmd: 'queue.edit', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );

    // Bug: handleQueueEdit returns "⚠️ 任务已开始执行，无法编辑" when
    // isBusyFor returns true. But task 2 is QUEUED, not executing — it's
    // the workspace that's busy with ANOTHER task. The error message should
    // NOT say "任务已开始执行" (which implies THIS task has started).
    const sentTexts = connector._sent
      .map((s) => (s.input as Record<string, unknown>)?.text as string | undefined)
      .filter((t): t is string => typeof t === 'string');

    const misleadingMessage = sentTexts.find((t) => t.includes('任务已开始执行'));
    expect(misleadingMessage).toBeUndefined();

    // Cleanup
    release1();
    await new Promise((r) => setTimeout(r, 100));
  });
});
