import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner } from '../../src/runner/index.js';

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

// --- Stubs ---

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-bridge-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
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

function makeBridge(
  opts: {
    runner?: Runner;
    idleTimeoutMs?: number;
    connector?: ReturnType<typeof createStubConnector>;
  } = {},
) {
  const sessionStore = new SessionStore();
  const connector = opts.connector ?? createStubConnector();
  const runner = opts.runner ?? createStubRunner();
  const bridge = new Bridge({
    agentRegistry: createStubAgentRegistry(runner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    connector,
    sessionStore,
    config,
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  });
  return { bridge, sessionStore, connector, runner };
}

describe('Queue card update when task starts executing', () => {
  it('test_anchor_queue_card_updates_when_task_starts_executing', async () => {
    const { bridge, connector } = makeBridge();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();

    // Track updateCard calls
    const updateCardCalls: Array<{ messageId: string; card: object }> = [];
    const originalUpdateCard = connector.updateCard;
    connector.updateCard = async (messageId: string, card: object) => {
      updateCardCalls.push({ messageId, card });
      (connector._cards as object[]).push(card);
    };

    // Scenario: Two tasks in queue
    // - Task 1: long running (blocks)
    // - Task 2: queued behind task 1

    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });

    // Task 1: starts immediately, blocks for a while
    bridge.enqueue(
      tmpDir,
      async () => {
        await hang1;
      },
      { taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-1', messagePreview: 'long task' } },
    );

    // Give task1 time to start executing
    await new Promise((r) => setTimeout(r, 50));

    // Task 2: will be queued (taskList.length > 1 triggers queue card)
    bridge.enqueue(
      tmpDir,
      async () => {
        /* quick task */
      },
      {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-2', messagePreview: 'quick task' },
      },
    );

    // Wait for queue card to be sent
    await new Promise((r) => setTimeout(r, 100));

    // Verify initial queue card was sent (header: orange, title: "排队中")
    // FIXED: Use header.title?.content instead of String(header?.title)
    const initialCards = connector._sent.filter((s: { input: unknown }) => {
      const inp = s.input as Record<string, unknown>;
      const card = inp.card as Record<string, unknown> | undefined;
      if (!card) return false;
      const header = card.header as Record<string, unknown> | undefined;
      const titleContent = (header?.title as { content?: string } | undefined)?.content;
      return header?.template === 'orange' && (titleContent?.includes('排队') ?? false);
    });
    expect(initialCards.length).toBeGreaterThan(0);

    // Now release task1 - task2 starts executing
    release1();

    // Wait for task2 to actually start executing
    await new Promise((r) => setTimeout(r, 100));

    // CRITICAL ASSERTION: When task2 starts, the queue card should be UPDATED
    // Expected behavior: connector.updateCard should be called with updated card
    // - header.template: 'green'
    // - header.title contains "已开始执行"
    // - buttons have disabled: true

    expect(updateCardCalls.length).toBeGreaterThan(0);

    // Verify the update has correct properties
    const updatedCard = updateCardCalls[updateCardCalls.length - 1].card as Record<string, unknown>;
    const header = updatedCard.header as Record<string, unknown>;
    const title = header?.title as Record<string, unknown>;

    expect(header?.template).toBe('green');
    expect(String(title?.content)).toContain('已开始执行');

    // Check buttons are disabled
    const body = updatedCard.body as Record<string, unknown>;
    const elements = body?.elements as Array<Record<string, unknown>>;
    const buttons = elements?.filter((el: Record<string, unknown>) => el.tag === 'button');
    for (const btn of buttons ?? []) {
      expect(btn.disabled).toBe(true);
    }

    connector.updateCard = originalUpdateCard;
  });
});
