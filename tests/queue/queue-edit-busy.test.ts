import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanupQueueTestContext,
  makeQueueTestContext,
  setupTwoTaskQueueScenario,
  type QueueTestContext,
} from '../lib/queue-scenario.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let ctx: QueueTestContext;

beforeEach(() => {
  ctx = makeQueueTestContext();
});

afterEach(() => {
  cleanupQueueTestContext(ctx);
});

describe('queue.edit misleading error when busy', () => {
  it('test_anchor_handleQueueEdit_does_not_say_task_started_executing_for_queued_task', async () => {
    // Bug: handleQueueEdit checks isBusyFor(workspace) and if true, returns
    // "⚠️ 任务已开始执行，无法编辑". But the task being edited is QUEUED —
    // it hasn't started executing. Another task is running in the workspace.
    // The error message is misleading: it says THIS task has started
    // executing when it hasn't.

    const { bridge, router, connector, tmpDir } = ctx;
    const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
      firstMessagePreview: 'task 1 running',
      secondMessagePreview: 'queued task',
    });

    // Verify task 2 is in the queue (it's queued, NOT executing)
    const task = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(task).toBeDefined();

    // Spy on isBusyFor to simulate a busy workspace (another task running)
    vi.spyOn(bridge, 'isBusyFor').mockReturnValue(true);

    // Simulate clicking "✏️ 编辑" on task 2's queue card
    const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    await router.handleCardAction(
      { cmd: 'queue.edit', workspace: tmpDir, messageId: 'msg-2' },
      cardCtx,
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
