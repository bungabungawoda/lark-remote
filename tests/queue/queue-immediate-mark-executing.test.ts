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

/** Extract all button elements from a card body. */
function extractButtons(card: object): Array<Record<string, unknown>> {
  const body = (card as Record<string, unknown>).body as Record<string, unknown>;
  const elements = body.elements as Array<Record<string, unknown>>;
  return elements.filter((el) => el.tag === 'button');
}

describe('queue.immediate marks target card executing', () => {
  it('test_anchor_handleQueueImmediate_updates_target_card_to_executing', async () => {
    // Bug: handleQueueImmediate stops the current run and clears tasks ahead of
    // the target, but does NOT update the TARGET's own queue card. The card stays
    // "⏳ 消息排队中" with all buttons enabled until the task actually starts
    // executing (updateQueueCardToExecuting in the queue callback). User clicks
    // 立即执行 but sees no immediate feedback; the button remains clickable.
    // Fix: handleQueueImmediate should mark the target card as executing right
    // away so buttons grey out immediately.

    const { bridge, router, connector, tmpDir } = ctx;
    const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
      firstMessagePreview: 'task 1 running',
      secondMessagePreview: 'task 2 queued',
    });

    // Verify task 2 is still queued (not yet executing)
    const task = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(task).toBeDefined();

    // Simulate clicking "⚡ 立即执行" on task 2's queue card
    const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    await router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'msg-2' },
      cardCtx,
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
