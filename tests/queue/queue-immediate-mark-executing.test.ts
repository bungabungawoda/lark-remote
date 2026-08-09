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

/** Extract all button elements from a card body. */
function extractButtons(card: object): Array<Record<string, unknown>> {
  const body = (card as Record<string, unknown>).body as Record<string, unknown>;
  const elements = body.elements as Array<Record<string, unknown>>;
  return elements.filter((el) => el.tag === 'button');
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  // 重置 mock
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-exec-test-'));
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

describe('queue.immediate marks target card executing', () => {
  it('test_anchor_handleQueueImmediate_updates_target_card_to_executing', async () => {
    // Bug: handleQueueImmediate stops the current run and clears tasks ahead of
    // the target, but does NOT update the TARGET's own queue card. The card stays
    // "⏳ 消息排队中" with all buttons enabled until the task actually starts
    // executing (updateQueueCardToExecuting in the queue callback). User clicks
    // 立即执行 but sees no immediate feedback; the button remains clickable.
    // Fix: handleQueueImmediate should mark the target card as executing right
    // away so buttons grey out immediately.

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
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'task 2 queued',
        },
      },
    );

    // Wait for task 2's queue card to be sent
    await new Promise((r) => setTimeout(r, 100));

    // Verify task 2 is still queued (not yet executing)
    const task = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(task).toBeDefined();

    // Simulate clicking "⚡ 立即执行" on task 2's queue card
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    await router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );

    // Bug: handleQueueImmediate does not update the target's card. After the
    // fix, the target card should be updated to "▶️ 已开始执行" (green header)
    // with all buttons disabled.
    const executingCard = connector._cards.find((c) => {
      const card = c as Record<string, unknown>;
      const header = card.header as Record<string, unknown> | undefined;
      const title = header?.title as Record<string, unknown> | undefined;
      return (title?.content as string | undefined)?.includes('已开始执行');
    });
    expect(executingCard).toBeDefined();

    // All buttons on the executing card must be disabled
    const buttons = extractButtons(executingCard as object);
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.disabled).toBe(true);
    }

    // Cleanup
    release1();
    await new Promise((r) => setTimeout(r, 100));
  });
});
