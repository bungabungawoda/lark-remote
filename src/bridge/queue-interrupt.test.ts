import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { QueueManager } from './queue-manager.js';

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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-qm-test-'));
  mockLogger.debug.mockClear();
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a QueueManager with stub callbacks for testing.
 */
function makeQueueManager(isRunning: (ws: string) => boolean = () => false) {
  const sentCards: Array<{ chatId: string; card: object }> = [];
  const updatedCards: Array<{ messageId: string; card: object }> = [];

  const sendCard = async (chatId: string, card: object) => {
    sentCards.push({ chatId, card });
    return `card-msg-${sentCards.length}`;
  };
  const updateCard = async (messageId: string, card: object) => {
    updatedCards.push({ messageId, card });
  };

  const qm = new QueueManager(isRunning, sendCard, updateCard);
  return { qm, sentCards, updatedCards };
}

describe('QueueManager - task interruption state sync', () => {
  it('resetExecutingCount lets the next enqueue start immediately (no queue card)', async () => {
    // Bug: when a running task is interrupted externally (via /stop or
    // "立即执行"), Bridge calls interruptCurrentRun() which kills the process
    // and clears activeRuns, but the queue's pendingOrExecutingCount stays > 0
    // because the promise-chain settle (.then/.catch) lags behind the kill.
    // Subsequent messages are wrongly shown as "排队中".
    //
    // Fix: Bridge.interruptCurrentRun calls queueManager.resetExecutingCount(cwd)
    // immediately after killing the process. This test verifies that after the
    // reset, a subsequent enqueue does NOT send a queue card, and that once the
    // killed task's promise rejects (process drain) the next task runs.
    const { qm, sentCards } = makeQueueManager(() => false);

    // Task 1: starts executing and hangs (process will be "killed" externally)
    let hangReject: (err: Error) => void = () => {};
    const hangPromise = new Promise<void>((_resolve, reject) => {
      hangReject = reject;
    });
    qm.enqueue(
      tmpDir,
      async () => {
        await hangPromise;
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
    await new Promise((r) => setTimeout(r, 50));
    // Task 1 is executing — no queue card yet
    expect(sentCards.length).toBe(0);

    // Simulate the external interrupt: Bridge kills the process and resets the
    // queue count (the real call site is Bridge.interruptCurrentRun).
    const stoppedSlot = qm.getExecutingSlot(tmpDir)!;
    qm.resetExecutingCount(tmpDir, stoppedSlot);

    // Task 2: enqueues after the reset. Without the fix, pendingOrExecutingCount
    // would still be 1 and Task 2 would get a "排队中" card. With the fix,
    // count is 0 so Task 2 does not get a queue card.
    let task2Ran = false;
    qm.enqueue(
      tmpDir,
      async () => {
        task2Ran = true;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'task 2 should run immediately',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    // No queue card — count was reset to 0 at enqueue time
    expect(sentCards.length).toBe(0);

    // Simulate the process kill: Task 1's promise rejects, the chain advances
    // to Task 2 (the .catch settle consumes the skip-credit, not the count).
    hangReject(new Error('simulated process kill'));
    await new Promise((r) => setTimeout(r, 50));
    expect(task2Ran).toBe(true);
  });

  it('resetExecutingCount skip-credit prevents stale settle from zeroing the count', async () => {
    // After resetExecutingCount, the interrupted task's promise-chain settle
    // (.then/.catch) still fires eventually. Without a skip-credit, that
    // decrement would zero the count while a newer task (enqueued after the
    // reset) is still running — causing a THIRD message to skip its queue card.
    // The skip-credit mechanism consumes the stale settle instead of decrementing.
    const { qm, sentCards } = makeQueueManager(() => false);

    // Task 1: hangs, then will be "killed" (reject, simulating process kill)
    let hangReject: (err: Error) => void = () => {};
    const hangPromise = new Promise<void>((_resolve, reject) => {
      hangReject = reject;
    });
    qm.enqueue(
      tmpDir,
      async () => {
        await hangPromise;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-1',
          messagePreview: 'task 1',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));

    // Interrupt: reset count (grants 1 skip-credit)
    const stoppedSlot = qm.getExecutingSlot(tmpDir)!;
    qm.resetExecutingCount(tmpDir, stoppedSlot);

    // Task 2: enqueues, no queue card (count was 0). count becomes 1.
    let task2Resolve: () => void = () => {};
    const task2Promise = new Promise<void>((resolve) => {
      task2Resolve = resolve;
    });
    qm.enqueue(
      tmpDir,
      async () => {
        await task2Promise;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'task 2 running',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(sentCards.length).toBe(0); // Task 2 enqueued with no queue card

    // Now Task 1's promise rejects (the killed process finally drains).
    // The skip-credit should absorb this settle so the count stays at 1
    // (Task 2 is now running after the chain advanced).
    hangReject(new Error('simulated process kill'));
    await new Promise((r) => setTimeout(r, 50));

    // Task 3: enqueues while Task 2 still running. Count should be 1 (Task 2),
    // so Task 3 MUST get a queue card. If the stale settle had wrongly
    // decremented, count would be 0 and Task 3 would skip the card.
    qm.enqueue(
      tmpDir,
      async () => {
        // no-op
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-3',
          messagePreview: 'task 3 should queue',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(sentCards.length).toBe(1); // Task 3 correctly shown as queued

    // Cleanup
    task2Resolve();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('resetExecutingCount is a no-op-safe method on the QueueManager', async () => {
    // Smoke test: the method exists, doesn't throw, and is safe to call on a
    // workspace with no executing tasks.
    const { qm } = makeQueueManager(() => false);

    expect(() => qm.resetExecutingCount(tmpDir, -1)).not.toThrow();
    expect(qm.getQueueInfo(tmpDir).position).toBe(0);
  });
});
