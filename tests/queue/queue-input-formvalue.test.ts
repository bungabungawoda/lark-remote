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

describe('queue.input isBusyFor blocking', () => {
  it('test_anchor_handleQueueInput_allows_editing_queued_task_when_workspace_busy', async () => {
    // Bug: handleQueueInput checks isBusyFor(workspace) and blocks editing
    // if the workspace is busy. But the task being edited is QUEUED (not
    // executing) — editing its message preview should work even when another
    // task is running in the same workspace.

    const { bridge, router, tmpDir } = ctx;
    const { release1 } = await setupTwoTaskQueueScenario(bridge, ctx.connector, tmpDir, {
      firstMessagePreview: 'task 1 running',
      secondMessagePreview: 'original content',
    });

    // Verify task 2 is in the queue
    const task = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(task).toBeDefined();

    // Spy on isBusyFor to simulate a busy workspace (another task running)
    vi.spyOn(bridge, 'isBusyFor').mockReturnValue(true);

    // Spy on updateMessagePreview to verify it gets called
    const updateSpy = vi.spyOn(bridge, 'updateMessagePreview');

    // Simulate submitting new content via queue.input
    const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    await router.handleCardAction(
      {
        cmd: 'queue.input',
        workspace: tmpDir,
        messageId: 'msg-2',
        inputValue: 'new edited content',
      },
      cardCtx,
    );

    // Bug: handleQueueInput returns early when isBusyFor returns true,
    // so updateMessagePreview is never called. But the task is QUEUED —
    // editing its message should work even when the workspace is busy.
    expect(updateSpy).toHaveBeenCalledWith(tmpDir, 'msg-2', 'new edited content');

    // Cleanup
    release1();
    await new Promise((r) => setTimeout(r, 100));
  });
});
