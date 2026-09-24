import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanupQueueTestContext,
  makeQueueTestContext,
  setupTwoTaskQueueScenario,
  type QueueTestContext,
} from '../lib/queue-scenario.js';

vi.mock('../../src/logger/index.js', async () =>
  (await import('../lib/logger-mock.js')).loggerModuleMock(),
);

let ctx: QueueTestContext;

beforeEach(() => {
  ctx = makeQueueTestContext();
});

afterEach(() => {
  cleanupQueueTestContext(ctx);
});

describe('queue.immediate stale card', () => {
  it('test_anchor_handleQueueImmediate_updates_cancelled_cards_for_removed_tasks', async () => {
    // Bug: handleQueueImmediate removes tasks before the target from the queue
    // via removeFromQueue, but does NOT call updateQueueCardToCancelled for
    // those removed tasks. Their queue cards remain showing "⏳ 消息排队中"
    // instead of being updated to "❌ 已撤销".

    const { bridge, router, connector, tmpDir } = ctx;
    const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
      firstMessagePreview: 'task 1 running',
      secondMessagePreview: 'task 2 queued',
    });

    // Spy on updateQueueCardToCancelled to track calls
    const cancelSpy = vi.spyOn(bridge, 'updateQueueCardToCancelled');

    // Task 3: queued behind task 1 and 2 (gets a queue card) — this is the target
    bridge.enqueue(tmpDir, async () => {}, {
      taskMeta: {
        userId: 'u1',
        chatId: 'c1',
        messageId: 'msg-3',
        messagePreview: 'task 3 queued',
      },
    });

    // Wait for queue cards to be sent
    await new Promise((r) => setTimeout(r, 100));

    // Verify both task 2 and task 3 are in the queue
    const tasks = bridge.getQueuedTasks(tmpDir);
    expect(tasks.find((t) => t.messageId === 'msg-2')).toBeDefined();
    expect(tasks.find((t) => t.messageId === 'msg-3')).toBeDefined();

    // Simulate clicking "立即执行" on task 3's queue card
    const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-3' };
    await router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'msg-3' },
      cardCtx,
    );

    // Bug: handleQueueImmediate removes task 2 from the queue but does NOT
    // call updateQueueCardToCancelled for it. Task 2's queue card remains
    // showing "⏳ 消息排队中" instead of being updated to "❌ 已撤销".
    expect(cancelSpy).toHaveBeenCalledWith(tmpDir, 'msg-2');

    // Cleanup
    release1();
    await new Promise((r) => setTimeout(r, 100));
  });
});
