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
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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

describe('Queue message edit', () => {
  it('test_anchor_queue_message_edit', async () => {
    const { bridge, connector } = makeBridge();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();

    // Track updateCard calls to verify card updates
    const updateCardCalls: Array<{ messageId: string; card: object }> = [];
    const originalUpdateCard = connector.updateCard;
    connector.updateCard = async (messageId: string, card: object) => {
      updateCardCalls.push({ messageId, card });
      (connector._cards as object[]).push(card);
    };

    // Scenario: Two tasks in queue
    // - Task 1: long running (blocks)
    // - Task 2: queued behind task 1, this is the one we want to edit

    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });

    // Task 1: starts immediately, blocks
    bridge.enqueue(
      tmpDir,
      async () => {
        await hang1;
      },
      {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-1', messagePreview: 'long task' },
      },
    );

    // Give task1 time to start
    await new Promise((r) => setTimeout(r, 50));

    // Task 2: queued behind task 1
    const originalMessage = 'original message content';
    bridge.enqueue(
      tmpDir,
      async () => {
        /* quick task */
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: originalMessage,
        },
      },
    );

    // Wait for queue card to be sent
    await new Promise((r) => setTimeout(r, 100));

    // Step 1: Verify queue card shows original message content
    const initialCards = connector._sent.filter((s: { input: unknown }) => {
      const inp = s.input as Record<string, unknown>;
      const card = inp.card as Record<string, unknown> | undefined;
      if (!card) return false;
      const header = card.header as Record<string, unknown> | undefined;
      const titleContent = (header?.title as { content?: string } | undefined)?.content;
      return header?.template === 'orange' && (titleContent?.includes('排队') ?? false);
    });
    expect(initialCards.length).toBeGreaterThan(0);

    // Verify the initial card contains an edit button (cmd: queue.edit)
    const initialCard = (initialCards[0].input as Record<string, unknown>).card as Record<
      string,
      unknown
    >;
    const initialBody = initialCard.body as Record<string, unknown>;
    const initialElements = initialBody.elements as Array<Record<string, unknown>>;
    const editButton = initialElements.find((el: Record<string, unknown>) => {
      if (el.tag !== 'button') return false;
      const behaviors = el.behaviors as Array<Record<string, unknown>> | undefined;
      if (!behaviors?.length) return false;
      const value = behaviors[0].value as Record<string, unknown> | undefined;
      return value?.cmd === 'queue.edit';
    });
    expect(editButton).toBeDefined();

    // Step 2: Simulate clicking edit button -> card shows input with default_value
    // This would be handled by router.handleCardAction for cmd 'queue.edit'
    // The card should update to show an input element with the current message as default_value
    const updatedNewContent = 'edited message content';

    // Step 3: Simulate submitting new content via queue.input
    // This would be handled by router.handleCardAction for cmd 'queue.input'
    // The queue manager should update the messagePreview for the queued task
    // and return the updated card object (sent as the cardAction callback
    // response `card.data`, not via a PATCH updateCard call).
    const editCard = await bridge.updateMessagePreview(tmpDir, 'msg-2', updatedNewContent);

    // Verify the queued task's messagePreview was updated
    const updatedTask = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(updatedTask?.messagePreview).toBe(updatedNewContent);

    // Step 4: Verify the returned card shows the new content
    expect(editCard).not.toBeNull();
    const editBody = (editCard as Record<string, unknown> | null)?.body as
      Record<string, unknown> | undefined;
    const editElements = editBody?.elements as Array<Record<string, unknown>> | undefined;
    const hasNewContent = editElements?.some((el: Record<string, unknown>) => {
      const text = el.text as Record<string, unknown> | undefined;
      const content = text?.content as string | undefined;
      return content?.includes(updatedNewContent) ?? false;
    });
    expect(hasNewContent).toBe(true);

    // Step 5: Verify the edit button is disabled once task starts executing
    release1();
    await new Promise((r) => setTimeout(r, 150));

    // The executing-state card should have disabled edit button
    const executingUpdateCall = updateCardCalls.find((call) => {
      const card = call.card as Record<string, unknown>;
      const header = card.header as Record<string, unknown>;
      const titleContent = (header?.title as { content?: string } | undefined)?.content;
      return titleContent?.includes('已开始执行') ?? false;
    });
    if (executingUpdateCall) {
      const execCard = executingUpdateCall.card as Record<string, unknown>;
      const execBody = execCard.body as Record<string, unknown>;
      const execElements = execBody.elements as Array<Record<string, unknown>>;
      const execEditButton = execElements.find((el: Record<string, unknown>) => {
        if (el.tag !== 'button') return false;
        const behaviors = el.behaviors as Array<Record<string, unknown>> | undefined;
        if (!behaviors?.length) return false;
        const value = behaviors[0].value as Record<string, unknown> | undefined;
        return value?.cmd === 'queue.edit';
      });
      if (execEditButton) {
        expect(execEditButton.disabled).toBe(true);
      }
    }

    connector.updateCard = originalUpdateCard;
  });
});
