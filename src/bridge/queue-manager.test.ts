import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { QueueManager } from './queue-manager.js';
import { expectNoV1ActionContainer } from '../../tests/lib/card-view.js';
import { mockLogger } from '../../tests/lib/logger-mock.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

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

/**
 * Extract position/tasksAhead text from a queue card.
 *
 * 正文分成多块 div（Workspace / 队列位置 / 正在执行），所以要扫全部文本；
 * 且 tasksAhead === 0 时「队列位置 / 前面还有」两行整体不渲染（2026-10-09：
 * 「排队中 / 前面还有 0 条」自相矛盾），此时返回 -1 = 这张卡不说位置。
 */
function extractPositionInfo(card: object): { position: number; tasksAhead: number } {
  const content = extractCardText(card);
  // Format: "**队列位置:** 第 N 位\n**前面还有:** M 条消息"
  const posMatch = content.match(/位置:\*?\*? 第 (\d+) 位/);
  const aheadMatch = content.match(/前面还有:\*?\*? (\d+) 条消息/);
  return {
    position: posMatch ? parseInt(posMatch[1], 10) : -1,
    tasksAhead: aheadMatch ? parseInt(aheadMatch[1], 10) : -1,
  };
}

/** All text content of a card body, joined by newline. */
function extractCardText(card: object): string {
  const body = (card as Record<string, unknown>).body as Record<string, unknown>;
  const elements = body.elements as Array<Record<string, unknown>>;
  return elements
    .map((el) => (el.text as Record<string, unknown> | undefined)?.content)
    .filter((c): c is string => typeof c === 'string')
    .join('\n');
}

/** Queue card header title. */
function extractHeaderTitle(card: object): string {
  const header = (card as Record<string, unknown>).header as Record<string, unknown>;
  const title = header.title as Record<string, unknown>;
  return String(title.content);
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

    // Enqueue 4 tasks: task 1 starts immediately (cwd is running),
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
    // 回归守卫：不得硬编码 position=1 / tasksAhead=0（历史 bug）
    expect(info.position).toBe(3);
    expect(info.tasksAhead).toBe(2);

    // Cleanup
    release1();
    await new Promise((r) => setTimeout(r, 50));
  });

  // index-consistency regression anchor. A `Map<messageId, QueuedTask>`
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
    // Bug: buildQueueStatusCardElements uses isWorkspaceRunning(cwd) to
    // disable 撤销/立即执行 buttons and hide the 编辑 button. But a queue card
    // is only sent when hasWaitingTasks (a front task is running), so isRunning
    // is almost always true at send time -> buttons always disabled / edit
    // hidden. The button state must reflect the task's OWN lifecycle (pending
    // = not yet executing = all actions available), not cwd busyness.

    // cwd always running = the real scenario when a card is sent
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
    expectNoV1ActionContainer(JSON.stringify(card));

    release1();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('test_anchor_non_editable_queued_task_card_omits_edit_button', async () => {
    // Compact 等单向卡片动作入队时带 editable=false：排队卡仍然要发（位置/撤销/
    // 立即执行都在），但 ✏️ 编辑 按钮必须消失——编辑一个不可编辑的预览无意义。
    // 回归：曾对所有排队任务一律渲染编辑按钮，导致 Compact 排队卡可被编辑。
    const { qm, sentCards } = makeQueueManager(() => true);

    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });

    // Task 1: starts immediately (no queue card)
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

    // Task 2: compact card action, queued behind task 1, NOT editable
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
          messagePreview: 'card action: compact',
          editable: false,
        },
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    const card = sentCards[sentCards.length - 1].card;
    const buttons = extractButtons(card);

    // Preview 仍然展示（排队卡内容不丢）
    const body = (card as Record<string, unknown>).body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;
    expect(JSON.stringify(elements).includes('card action: compact')).toBe(true);

    // ✏️ 编辑 按钮必须不存在
    expect(buttons.some((b) => buttonLabel(b).includes('编辑'))).toBe(false);

    // ❌ 撤销 / ⚡ 立即执行 仍然存在且可用（排队任务自身生命周期不受影响）
    const cancelBtn = buttons.find((b) => buttonLabel(b).includes('撤销'));
    expect(cancelBtn).toBeDefined();
    expect(cancelBtn!.disabled).not.toBe(true);
    const execBtn = buttons.find((b) => buttonLabel(b).includes('立即执行'));
    expect(execBtn).toBeDefined();
    expect(execBtn!.disabled).not.toBe(true);

    // CardKit 2.0 铁律：禁止 V1 action 容器与 V2 behaviors 混用
    expectNoV1ActionContainer(JSON.stringify(card));

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

  it('test_anchor_removeFromQueue_cancelled_task_never_executes_after_drain', async () => {
    // removeFromQueue 取消排队任务的回归守卫：
    // removeFromQueue 只删元数据，Promise 链上的 .then 回调不可摘除——取消守卫
    // （queue-manager.ts 的 `if (!task) return`）必须在 begin 路径跳过已取消任务。
    // 断言目标任务闭包未执行（executed 只含阻塞任务）。

    const { qm } = makeQueueManager(() => true);
    const executed: string[] = [];

    // Task 1 — 阻塞 cwd，先开始执行
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    qm.enqueue(
      tmpDir,
      async () => {
        executed.push('1');
        await hang1;
      },
      {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-1', messagePreview: 't1' },
      },
    );

    // Task 2 — 排在 task 1 后面，随后被取消
    qm.enqueue(
      tmpDir,
      async () => {
        executed.push('2');
      },
      {
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-2', messagePreview: 't2' },
      },
    );

    await new Promise((r) => setTimeout(r, 30));

    // Task 2 在队列中，取消成功
    expect(qm.getQueuedTasks(tmpDir).map((t) => t.messageId)).toContain('msg-2');
    expect(qm.removeFromQueue(tmpDir, 'msg-2')).toBe(true);
    expect(qm.getQueuedTasks(tmpDir).map((t) => t.messageId)).not.toContain('msg-2');

    // 放行 task 1，队列链推进到已取消的 task 2 —— 守卫必须跳过它
    release1();
    await new Promise((r) => setTimeout(r, 50));

    // 有 bug 时 executed = ['1', '2']；修复后 task 2 被跳过
    expect(executed).toEqual(['1']);
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

/**
 * 队列身份不变量：一个 cwd 内 queue key 必须与「一次入队动作」1:1。
 *
 * 铸造点在入口层（`CommandRouter.mintQueueTaskKey`，index.ts 的非即时卡片动作
 * 分支 + order.exec 文本钩子）。飞书卡片的 messageId 是展示层 id，同一张卡可被
 * 连点 N 次（1:N），绝不能当 queue key：queuedTasks 的定位（findIndex 命中最早
 * 那条兄弟）、taskIndex 的取消判据（第一条开始执行时 indexRemove 删掉共享 key，
 * 其余兄弟被判「已撤销」）、queueCardMessages 的卡片更新（Map 覆盖，只留最后
 * 一张卡）三处会同时串位。
 *
 * 2026-10-08 线上：连点同一张卡的 🗜 Compact 三次 → 三张排队卡都显示
 * 「位置: 第 1 位 / 前面还有 0 条」，其中两张永久停在「⏳ 消息排队中」，
 * 实际只压缩了一次。
 */
describe('QueueManager 队列身份（连点同一张卡）', () => {
  it('test_anchor_card_action_queue_key_unique_per_enqueue_runs_all_and_numbers_positions', async () => {
    // 验证什么：每次入队各自的 key → 位置按 1/2/3 递增、三条任务全部执行、
    // 每张排队卡各自被更新为「已开始执行」。
    // 缺失后果：见本 describe 的块注释（三张卡位置相同 + 两条任务静默丢弃）。
    const { qm, sentCards, updatedCards } = makeQueueManager();
    const chatId = 'c1';
    const runs: string[] = [];

    // 占住队列的 run（带 taskMeta，模拟正在跑的 agent run）。
    let releaseRun: () => void = () => {};
    const hanging = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    qm.enqueue(
      tmpDir,
      async () => {
        await hanging;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId,
          messageId: 'om-running-run',
          messagePreview: '正在跑的 run',
        },
      },
    );
    // 让占队任务的 begin 跑完（begin 把它从 queuedTasks 摘掉）—— 之后入队的
    // 点击才是「第 1 位」，与线上形态一致（run 已在跑，队列里只剩点击）。
    await new Promise((r) => setTimeout(r, 0));

    // 连点同一张卡 3 次：入口层每次铸造独立 key，卡片 id 只作回复目标。
    for (let i = 1; i <= 3; i++) {
      const queueKey = `card-compact-${i}`;
      qm.enqueue(
        tmpDir,
        async () => {
          runs.push(queueKey);
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId,
            messageId: queueKey,
            feishuReplyTo: 'om-same-card',
            messagePreview: 'card action: compact',
            editable: false,
          },
        },
      );
    }

    await new Promise((r) => setTimeout(r, 50));

    // 三张排队卡，位置各不相同且递增。第一张前面只有正在跑的 run（没有等待
    // 中的消息），所以它按新口径不渲染「队列位置 / 前面还有」，改报
    // 「等待当前任务结束」+「正在执行」；后两张才数等待队列，位置 2/3。
    expect(sentCards).toHaveLength(3);
    const infos = sentCards.map((s) => extractPositionInfo(s.card));
    expect(infos.map((i) => i.position)).toEqual([-1, 2, 3]);
    expect(infos.map((i) => i.tasksAhead)).toEqual([-1, 1, 2]);
    expect(sentCards.map((s) => extractHeaderTitle(s.card))).toEqual([
      '⏳ 等待当前任务结束',
      '⏳ 消息排队中',
      '⏳ 消息排队中',
    ]);

    releaseRun();
    await new Promise((r) => setTimeout(r, 50));

    // 三条任务全部执行（不再被当成「同一条的重复点击」静默丢弃）
    expect(runs).toEqual(['card-compact-1', 'card-compact-2', 'card-compact-3']);

    // 每张卡各自被更新：「已开始执行」不再打到别的卡上
    expect(updatedCards.map((u) => u.messageId)).toEqual([
      'card-msg-1',
      'card-msg-2',
      'card-msg-3',
    ]);
  });

  it('同 key 入队触发 tripwire warn（身份不变量被破坏时必须留证据）', async () => {
    // 验证什么：queue key 撞车时日志必须留痕 —— 数组（追加）与 taskIndex（覆盖）
    // 会漂移，位置/撤销/卡片更新会串到别的条目上，静默下去就是 2026-10-08 的
    // 「卡片永久等待中」无法从日志复现。
    const { qm } = makeQueueManager();
    mockLogger.warn.mockClear();

    let releaseRun: () => void = () => {};
    const hanging = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    qm.enqueue(
      tmpDir,
      async () => {
        await hanging;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'om-running-run',
          messagePreview: 'run',
        },
      },
    );
    qm.enqueue(tmpDir, async () => undefined, {
      taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'dup-key', messagePreview: 'task A' },
    });
    qm.enqueue(tmpDir, async () => undefined, {
      taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'dup-key', messagePreview: 'task B' },
    });

    const warnings = mockLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnings).toContain('duplicate queue key');
    expect(warnings).toContain('dup-key');

    releaseRun();
    await new Promise((r) => setTimeout(r, 30));
  });
});
