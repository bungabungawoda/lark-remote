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
 * The `updateCard` callback records all calls so tests can inspect the card
 * content that was sent.
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

/** Extract position/tasksAhead text from a queue card. */
function extractPositionInfo(card: object): { position: number; tasksAhead: number } {
  const body = (card as Record<string, unknown>).body as Record<string, unknown>;
  const elements = body.elements as Array<Record<string, unknown>>;
  const div = elements[0];
  const text = div.text as Record<string, unknown>;
  const content = text.content as string;
  // Format: "**当前 Workspace:** `xxx`\n**位置:** 第 N 位\n**前面还有:** M 条消息在排队"
  const posMatch = content.match(/位置:\*?\*? 第 (\d+) 位/);
  const aheadMatch = content.match(/前面还有:\*?\*? (\d+) 条消息/);
  return {
    position: posMatch ? parseInt(posMatch[1], 10) : -1,
    tasksAhead: aheadMatch ? parseInt(aheadMatch[1], 10) : -1,
  };
}

/** Extract all button elements from a card body. */
function extractButtons(card: object): Array<Record<string, unknown>> {
  const body = (card as Record<string, unknown>).body as Record<string, unknown>;
  const elements = body.elements as Array<Record<string, unknown>>;
  return elements.filter((el) => el.tag === 'button');
}

/** Get the plain_text label of a button element. */
function buttonLabel(btn: Record<string, unknown>): string {
  const text = btn.text as Record<string, unknown> | undefined;
  return (text?.content as string) ?? '';
}

describe('QueueManager', () => {
  it('test_anchor_buildQueueCardForEdit_shows_correct_position_not_hardcoded_1', async () => {
    // Bug: buildQueueCardForEdit (formerly updateQueueCardAfterEdit) must not hardcode position=1, tasksAhead=0
    // regardless of how many tasks are actually ahead in the queue.
    // When task 4 (of 4) edits its message, the card should show position 3
    // (it's the 3rd queued task, 0-indexed position 3 in the list) with 2
    // tasks ahead — NOT position 1 with 0 ahead.

    const { qm, updatedCards: _updatedCards } = makeQueueManager(() => true);

    // Enqueue 4 tasks: task 1 starts immediately (workspace is running),
    // tasks 2-4 are queued behind it.
    // We use a hanging promise to keep task 1 running.
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });

    // Task 1 — starts running immediately (isRunning=true → hasWaitingTasks=false
    // for the first task, so no queue card). Actually, the first task has
    // executingCount=0 and queueLength=0, so hasWaitingTasks=false → no card.
    qm.enqueue(
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

    // Task 2 — queued (executingCount=1 → hasWaitingTasks=true → queue card sent)
    qm.enqueue(
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

    // Task 3 — queued behind 1 and 2
    qm.enqueue(
      tmpDir,
      async () => {
        /* quick */
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-3',
          messagePreview: 'task 3 queued',
        },
      },
    );

    // Task 4 — queued behind 1, 2, 3
    qm.enqueue(
      tmpDir,
      async () => {
        /* quick */
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-4',
          messagePreview: 'task 4 queued',
        },
      },
    );

    // Wait for queue cards to be sent (sendQueueStatusCard is fire-and-forget)
    await new Promise((r) => setTimeout(r, 50));

    // Verify task 4 is in the queue
    const tasks = qm.getQueuedTasks(tmpDir);
    expect(tasks.length).toBeGreaterThanOrEqual(3); // tasks 2, 3, 4 (task 1 removed when it starts)

    // Now simulate editing task 4's message: buildQueueCardForEdit returns the
    // card object (sent as the cardAction callback response `card.data`) rather
    // than issuing a PATCH updateCard call.
    const editCard = qm.buildQueueCardForEdit(tmpDir, 'msg-4', 'edited content');
    expect(editCard).not.toBeNull();

    const info = extractPositionInfo(editCard!);

    // Task 4 is the 4th task in the queue. Task 1 was removed when it started
    // (the queue callback removes it via splice). So tasks 2, 3, 4 remain.
    // Task 4 is at position 3 (1-indexed), with 2 tasks ahead.
    // BUG: current code hardcodes position=1, tasksAhead=0.
    expect(info.position).toBe(3);
    expect(info.tasksAhead).toBe(2);

    // Cleanup
    release1();
    await new Promise((r) => setTimeout(r, 50));
  });

  // P3-5: index-consistency regression anchor. A `Map<messageId, QueuedTask>`
  // index must stay in sync with the ordered `queuedTasks` array across every
  // mutation path (enqueue / task-start removal / cancel / immediate / edit).
  // Any stale index entry would make `getQueuedTask`, `removeFromQueue`,
  // `updateQueuedTaskMessage`, and `getQueuedTasks` disagree — observable as
  // a removed task still being found, or edit/cancel acting on a ghost entry.
  // This anchor exercises a mixed sequence and asserts the four public lookup
  // methods agree at every step. GREEN today (locks behavior); the green
  // refactor that introduces the index must keep it GREEN.
  it('test_anchor_queue_index_consistency_across_mixed_mutations', async () => {
    const { qm } = makeQueueManager(() => true);

    // Task 1 — runs immediately (held), tasks 2-4 queue behind.
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    const enqueueTask = (id: string, preview: string, run: () => Promise<void> = async () => {}) =>
      qm.enqueue(tmpDir, run, {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: id, messagePreview: preview },
      });

    enqueueTask('msg-1', 'task 1 running', async () => {
      await hang1;
    });
    enqueueTask('msg-2', 'task 2');
    enqueueTask('msg-3', 'task 3');
    enqueueTask('msg-4', 'task 4');
    await new Promise((r) => setTimeout(r, 30));

    // Snapshot helpers: the four public lookups must agree on membership.
    const assertConsistent = (ids: string[]) => {
      const list = qm.getQueuedTasks(tmpDir).map((t) => t.messageId);
      for (const id of ids) {
        const inList = list.includes(id);
        const found = qm.getQueuedTask(tmpDir, id);
        expect(found !== undefined).toBe(inList); // getQueuedTask agrees with list
        expect(qm.removeFromQueue(tmpDir, id)).toBe(inList); // removeFromQueue returns found==inList
        // removeFromQueue just removed it; re-assert both lookups now miss it.
        expect(qm.getQueuedTask(tmpDir, id)).toBeUndefined();
        expect(qm.getQueuedTasks(tmpDir).some((t) => t.messageId === id)).toBe(false);
      }
    };

    // After enqueueing 2,3,4 behind running task 1, all three are present.
    expect(qm.getQueuedTasks(tmpDir).map((t) => t.messageId)).toEqual(['msg-2', 'msg-3', 'msg-4']);

    // Cancel msg-3 (middle) — index must drop it, order preserved.
    expect(qm.removeFromQueue(tmpDir, 'msg-3')).toBe(true);
    expect(qm.getQueuedTasks(tmpDir).map((t) => t.messageId)).toEqual(['msg-2', 'msg-4']);
    // Stale index would still find msg-3.
    expect(qm.getQueuedTask(tmpDir, 'msg-3')).toBeUndefined();
    // Removing an already-removed id returns false (no ghost resurrection).
    expect(qm.removeFromQueue(tmpDir, 'msg-3')).toBe(false);

    // Edit msg-2's preview — update must land on the right task only.
    expect(qm.updateQueuedTaskMessage(tmpDir, 'msg-2', 'edited-2')).toBe(true);
    const t2 = qm.getQueuedTask(tmpDir, 'msg-2');
    expect(t2?.messagePreview).toBe('edited-2');
    expect(t2?.editedMessage).toBe('edited-2');
    // Editing a removed id fails.
    expect(qm.updateQueuedTaskMessage(tmpDir, 'msg-3', 'ghost')).toBe(false);

    // buildQueueCardForEdit reflects post-mutation position (msg-4 is now 2nd).
    const editCard = qm.buildQueueCardForEdit(tmpDir, 'msg-4', 'edited-4');
    expect(editCard).not.toBeNull();
    const info = extractPositionInfo(editCard!);
    expect(info.position).toBe(2); // [msg-2, msg-4] → msg-4 is 2nd
    // Edit card for a removed id returns null (index has no stale entry).
    expect(qm.buildQueueCardForEdit(tmpDir, 'msg-3', 'ghost')).toBeNull();

    // Cross-check the remaining two via the consistency helper.
    assertConsistent(['msg-2', 'msg-4']);

    release1();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('test_anchor_pending_queue_card_buttons_enabled_even_when_workspace_running', async () => {
    // Bug: buildQueueStatusCardElements uses isWorkspaceRunning(workspace) to
    // disable 撤销/立即执行 buttons and hide the 编辑 button. But a queue card
    // is only sent when hasWaitingTasks (a front task is running), so isRunning
    // is almost always true at send time -> buttons always disabled / edit
    // hidden. The button state must reflect the task's OWN lifecycle (pending
    // = not yet executing = all actions available), not workspace busyness.

    // workspace always running = the real scenario when a card is sent
    const { qm, sentCards } = makeQueueManager(() => true);

    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });

    // Task 1: starts immediately (executingCount becomes 1, no card sent)
    qm.enqueue(
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

    // Task 2: queued behind task 1 (executingCount=1 -> hasWaitingTasks -> card sent)
    qm.enqueue(
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

    await new Promise((r) => setTimeout(r, 50));

    // Last sent card is task 2's pending queue card
    const card = sentCards[sentCards.length - 1].card;
    const buttons = extractButtons(card);

    // ✏️ 编辑 button must exist (currently hidden by `if (!isRunning)`)
    const editBtn = buttons.find((b) => buttonLabel(b).includes('编辑'));
    expect(editBtn).toBeDefined();

    // ❌ 撤销 button must NOT be disabled (currently disabled: isRunning=true)
    const cancelBtn = buttons.find((b) => buttonLabel(b).includes('撤销'));
    expect(cancelBtn).toBeDefined();
    expect(cancelBtn!.disabled).not.toBe(true);

    // ⚡ 立即执行 button must NOT be disabled
    const execBtn = buttons.find((b) => buttonLabel(b).includes('立即执行'));
    expect(execBtn).toBeDefined();
    expect(execBtn!.disabled).not.toBe(true);

    // CardKit 2.0 铁律：禁止 V1 action 容器与 V2 behaviors 混用（飞书 200861 整卡不可用）
    expect(JSON.stringify(card)).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

    release1();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('test_anchor_replacement_registered_before_yield_is_consumed_by_begin_path', async () => {
    // RACE FIX (Plan B): The caller (handleQueueInput) must register the
    // replacement BEFORE any await. When this ordering is respected, the
    // begin path finds the replacement and executes it instead of the original
    // stale closure — even if the queue chain advances during a subsequent
    // await (e.g. updateMessagePreview).
    //
    // This test simulates the FIXED interleaving at the QueueManager level:
    // - Task A is running (hang), task B is queued.
    // - setTaskReplacement is called for B FIRST (synchronous, no await yet).
    // - Task A is released (queue chain advances, B begins).
    // - B's begin path finds the replacement → runs edited closure.
    // - Then updateQueuedTaskMessage is called (too late for the card, but the
    //   replacement was already consumed correctly).

    const { qm } = makeQueueManager(() => true);

    // Track which closure actually ran
    const executed: string[] = [];

    // Task A — runs immediately, held until we release it
    let releaseA: () => void = () => {};
    const hangA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    qm.enqueue(
      tmpDir,
      async () => {
        await hangA;
        executed.push('A');
      },
      {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-A', messagePreview: 'task A' },
      },
    );

    // Task B — queued behind A, captures OLD content in its original closure
    qm.enqueue(
      tmpDir,
      async () => {
        executed.push('B-original');
      },
      {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-B', messagePreview: 'old content' },
      },
    );

    await new Promise((r) => setTimeout(r, 30));

    // FIXED ORDER: register replacement BEFORE releasing A (synchronous, no await).
    // This is what handleQueueInput now does: setTaskReplacement before any await.
    qm.setTaskReplacement(tmpDir, 'msg-B', async () => {
      executed.push('B-edited');
    });

    // Also update the preview (simulates the second step of handleQueueInput,
    // but after the replacement is already registered).
    const updated = qm.updateQueuedTaskMessage(tmpDir, 'msg-B', 'new content');
    expect(updated).toBe(true);

    // Now release A — the queue chain advances, B begins.
    // The begin path finds the replacement and executes it.
    releaseA();
    await new Promise((r) => setTimeout(r, 50));

    // The replacement closure ran, not the original.
    expect(executed).toEqual(['A', 'B-edited']);
  });

  it('test_anchor_replacement_not_registered_when_task_already_began', async () => {
    // When a queued task has already begun (removed from the queue by the begin
    // path), getQueuedTask returns undefined. The caller must detect this and
    // NOT register a replacement (it would leak as a dead closure).
    // handleQueueInput now checks getQueuedTask BEFORE setTaskReplacement.

    const { qm } = makeQueueManager(() => true);

    const executed: string[] = [];

    // Task A — runs and completes quickly
    qm.enqueue(
      tmpDir,
      async () => {
        executed.push('A');
      },
      {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-A', messagePreview: 'task A' },
      },
    );

    // Task B — queued, will begin immediately after A completes
    qm.enqueue(
      tmpDir,
      async () => {
        executed.push('B-original');
      },
      {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-B', messagePreview: 'old content' },
      },
    );

    // Let both tasks complete
    await new Promise((r) => setTimeout(r, 50));

    // Both have already begun and settled.
    expect(qm.hasBegan('msg-A')).toBe(true);
    expect(qm.hasBegan('msg-B')).toBe(true);

    // getQueuedTask returns undefined — the caller must NOT register replacement.
    const task = qm.getQueuedTask(tmpDir, 'msg-B');
    expect(task).toBeUndefined();

    // If the caller erroneously registers a replacement for an already-began task,
    // it leaks as a dead closure (never consumed). The fix is to check
    // getQueuedTask first and skip setTaskReplacement when undefined.
    qm.setTaskReplacement(tmpDir, 'msg-B', async () => {
      executed.push('B-edited');
    });

    // The dead replacement should not run.
    await new Promise((r) => setTimeout(r, 30));
    expect(executed).toEqual(['A', 'B-original']);
  });
});
