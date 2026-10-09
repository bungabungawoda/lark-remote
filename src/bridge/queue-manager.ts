import { getLogger } from '../logger/index.js';
import { displayName } from '../platform/path.js';
import type { AgentKind } from '../runner/types.js';

/**
 * 入队时刻快照：当前 defaultAgent + 该 agent 的 sessionId（无 session 则 undefined）。
 * 唯一捕获点：排队消息在入队时刻把 agent+session 钉进 AgentBinding，随任务闭包带到执行时刻
 * 执行时刻，避免 /new、/config 在排队期间改写 live 状态导致语义漂移。
 */
export interface AgentBinding {
  agent: AgentKind;
  sessionId?: string;
  /**
   * 会话代际快照（与 sessionId 同刻捕获）。随 binding 带到执行时刻：若执行前
   * session 指针被移动（/new、/cd、/resume、/config 切换），该 run 的 init /
   * turn_started 写回判 stale 跳过，避免「先发消息 → 后点新会话」时旧 sessionId
   * 被写回复活（2026-10-07 事故）。缺省时回退到执行起点捕获，保持旧行为。
   */
  sessionEpoch?: number;
}

/**
 * Per-workspace cap on the number of tasks WAITING to execute.
 * Without a bound, a message flood grows `queuedTasks` / the promise chain /
 * each task's captured `msg.content` closure without limit, and every enqueued
 * task fires a queue card (amplifying outbound API calls). When the waiting
 * queue is already at this depth, a new task is rejected with a visible card
 * instead of being queued. The currently-executing task is NOT counted (it is
 * tracked in `pendingOrExecutingCount`, not `queuedTasks`), so the cap is on
 * backlog, not throughput. Owner is a single user, so 50 is ample headroom.
 */
const MAX_WAITING_QUEUE = 50;

/** A queued task with its metadata for queue display cards. */
export interface QueuedTask {
  userId: string;
  chatId: string;
  /**
   * Queue dedup/identity key. For hand-typed messages this is the Feishu
   * message id; for card-action dispatches (e.g. `order.exec`, where one card
   * is clickable N times) this is a project-minted internal key (NOT a valid
   * Feishu message id). It is used for task lookup, cancellation, and queue
   * card button callbacks — never as a Feishu reply target.
   */
  messageId: string;
  /**
   * The Feishu message id the queue status card should reply to, when it
   * differs from `messageId` (i.e. `messageId` is an internal key). Falls back
   * to `messageId` for hand-typed messages, where the two coincide.
   */
  feishuReplyTo?: string;
  cwd: string;
  timestamp: number;
  messagePreview: string;
  /**
   * Whether the queued task's message is editable from the queue card.
   * Card actions like Compact are one-shot operations — editing their
   * preview is meaningless, so they enqueue with `editable: false` and the
   * queue card omits the ✏️ 编辑 button.
   */
  editable?: boolean;
  /**
   * Edited message content. Set by `updateQueuedTaskMessage` when the user
   * edits a queued message. The original closure captured at enqueue time
   * is immutable, so `handleQueueImmediate` reads this field to register a
   * one-shot replacement closure with the edited content (see router
   * `handleQueueImmediate`).
   */
  editedMessage?: string;
  /** 入队时刻捕获的 agent+session 绑定，随任务闭包带到执行时刻。 */
  binding?: AgentBinding;
}

/**
 * lane 条目的展示类型。只影响排队卡如何描述「正在执行的是什么」：
 * `message` 普通消息（缺省）、`compact` 压缩会话、`command` 其他卡片动作。
 */
export type LaneTaskKind = 'message' | 'compact' | 'command';

/**
 * lane 当前占用者的展示信息。由 begin 路径登记、settle 路径清除，与执行
 * 槽位同寿命；排队卡靠它回答「我在等谁」。
 */
export interface ExecutingInfo {
  /**
   * 归属标记：与执行槽位共用同一个 slot id。清除时校验它，防止一条迟到的
   * settle 清掉后继任务的占用者（身份不用外部 id，同 §9.24 口径）。
   */
  slotId: number;
  kind: LaneTaskKind;
  /** 展示标签，例如 '💬 消息' / '🗜 Compact' / '📋 config.save'。 */
  label: string;
  /** 该条目自己的排队预览（可选）。 */
  preview?: string;
  /** 登记时刻（epoch ms）。当前只供诊断，卡片不渲染实时时长。 */
  startedAt: number;
}

/** 排队卡「正在执行」一行用的展示标签。 */
function laneOccupantLabel(kind: LaneTaskKind, preview: string): string {
  switch (kind) {
    case 'compact':
      return '🗜 Compact';
    case 'command':
      // 卡片动作的预览形如 'card action: config.save'，标签里去掉前缀更短。
      return `📋 ${preview.replace(/^card action:\s*/, '')}`;
    default:
      return '💬 消息';
  }
}

/** Options for enqueue operation */
export interface EnqueueOptions {
  taskMeta?: {
    userId: string;
    chatId: string;
    messageId: string;
    messagePreview: string;
    /**
     * Feishu message id the queue status card should reply to, when the queue
     * dedup key (`messageId`) is NOT a valid Feishu id (e.g. an order.exec
     * internal key). Omitted for hand-typed messages, where `messageId` is the
     * real Feishu id and doubles as the reply target.
     */
    feishuReplyTo?: string;
    /** Whether the queued task is editable (queue card ✏️ 编辑 button). Defaults to true. */
    editable?: boolean;
    /** 入队时刻捕获的 agent+session 绑定。 */
    binding?: AgentBinding;
    /**
     * lane 占用者的展示类型，缺省 'message'。
     * 'compact' 时排队卡写明「正在执行: 🗜 Compact」，并把「立即执行」置灰
     * ——该按钮会中断压缩（见 buildQueueActionButtons）。
     */
    kind?: LaneTaskKind;
  };
}

/** Queue info for a cwd */
interface QueueInfo {
  position: number;
  tasksAhead: number;
  isRunning: boolean;
}

/**
 * QueueManager handles the per-workspace serial processing queue.
 * Manages task queuing, cancellation, and queue status card rendering.
 */
export class QueueManager {
  /** Per-workspace (cwd) serial queues. Key = cwd, value = tail of promise chain. */
  private queues = new Map<string, Promise<void>>();
  /** Per-workspace queued tasks for queue display cards. Key = cwd, value = task list. */
  private queuedTasks = new Map<string, QueuedTask[]>();
  /**
   * per-workspace `messageId → QueuedTask` index mirroring `queuedTasks`.
   * O(1) lookup for the task-start removal path (replacing the old double
   * `find`+`findIndex` O(N) scan) and for `getQueuedTask`/`removeFromQueue`/
   * `updateQueuedTaskMessage`. The ordered array remains the source of truth
   * (position display depends on order); the index must be kept in sync on
   * every mutation (push / splice / shift) via the `indexAdd`/`indexRemove`
   * helpers. Same messageId is never enqueued twice in one cwd
   * (Feishu dedup + internal-key dedup), so no overwrite concern.
   */
  private taskIndex = new Map<string, Map<string, QueuedTask>>();
  /**
   * Map from user messageId to the queue card's Feishu send promise. Storing
   * the promise (not the resolved id) closes the race where the card send is
   * still in flight when the task begins: the begin path awaits the stored
   * promise, so a late-arriving card id still gets reconciled to the
   * executing/cancelled state. The promise never rejects (send failures
   * resolve undefined), so awaiting it is always safe.
   */
  /** queue card 的 send promise 表（public：bridge 集成测试注入/断言用）。 */
  queueCardMessages = new Map<string, Promise<string | undefined>>();
  /** Track number of executing tasks per cwd (for queue card display). */
  private pendingOrExecutingCount = new Map<string, number>();
  /**
   * Monotonic counter minting a unique slot id per enqueued task. A slot
   * identifies one task's execution period for the interrupt bookkeeping in
   * `executingInfo`/`interruptedSlots` — replacing the unowned skip-credit
   * counter, which any settle could consume and which therefore leaked a
   * re-armed count after repeated resets.
   */
  private slotCounter = 0;
  /**
   * Per-workspace record of the task currently executing — the lane occupant.
   * Set in the begin path right before the task runs; deleted by that task's
   * settle. Carries both the slot id (`resetExecutingCount` binds the
   * interrupt credit to exactly the interrupted task's slot) and the display
   * info the queue card needs to name what a waiting message waits for.
   *
   * 2026-10-09 线上：一次 Compact 占着 lane，新消息的排队卡却写「位置: 第 1
   * 位 / 前面还有: 0 条消息」——开卡判据看 lane（含正在执行者），位置文案只看
   * 等待队列，两个口径的差集正是这条记录。
   */
  private executingInfo = new Map<string, ExecutingInfo>();
  /**
   * Per-workspace set of slot ids whose task was interrupted by
   * `resetExecutingCount`. When such a slot settles, its decrement is skipped
   * (the reset already zeroed the count). A slot is granted at most once —
   * repeated resets of the same executing task do not mint extra credits —
   * which prevents a normal task's settle from consuming a credit instead of
   * decrementing, leaking the re-armed count to 1.
   */
  private interruptedSlots = new Map<string, Set<number>>();
  /** Per-workspace messageId → replacement closure, set by queue.edit + immediate. */
  private taskReplacements = new Map<string, Map<string, () => Promise<void>>>();
  /**
   * MessageIds of tasks that have actually begun executing (cancellation check
   * passed, task removed from the queue). Entries are sticky: they remain
   * after the task settles. `handleQueueImmediate` step 6 uses this to
   * distinguish "target was cancelled (never began)" from "target began while
   * the interrupt was in flight" so the final feedback can report the true
   * state instead of telling a running task's user that nothing was
   * scheduled. A task that began and then settled quickly must still report
   * "已开始执行", which requires the marker to survive settle. Message ids are
   * globally unique and never reused, so a sticky marker cannot misclassify a
   * later task; the set is bounded-pruned on insert to prevent unbounded
   * growth. Removed/cancelled tasks never enter the set (cancellation happens
   * before begin); `removeFromQueue` therefore needs no cleanup here.
   */
  private beganMessageIds = new Set<string>();

  /** Callback to check if cwd has an active run */
  private isWorkspaceRunning: (cwd: string) => boolean;

  /** Callback to send card updates */
  private sendCard: (chatId: string, card: object, opts?: { replyTo?: string }) => Promise<string>;
  /** Callback to update existing card */
  private updateCard: (messageId: string, card: object) => Promise<void>;

  constructor(
    isWorkspaceRunning: (cwd: string) => boolean,
    sendCard: (chatId: string, card: object, opts?: { replyTo?: string }) => Promise<string>,
    updateCard: (messageId: string, card: object) => Promise<void>,
  ) {
    this.isWorkspaceRunning = isWorkspaceRunning;
    this.sendCard = sendCard;
    this.updateCard = updateCard;
  }

  /** register a queued task in the per-workspace `messageId → task` index. */
  private indexAdd(cwd: string, task: QueuedTask): void {
    let idx = this.taskIndex.get(cwd);
    if (!idx) {
      idx = new Map();
      this.taskIndex.set(cwd, idx);
    }
    idx.set(task.messageId, task);
  }

  /** drop a task from the per-workspace index by messageId. */
  private indexRemove(cwd: string, messageId: string): void {
    this.taskIndex.get(cwd)?.delete(messageId);
  }

  /** O(1) lookup of a queued task by messageId via the index. */
  private indexGet(cwd: string, messageId: string): QueuedTask | undefined {
    return this.taskIndex.get(cwd)?.get(messageId);
  }

  /**
   * Enqueue a task into the workspace-level serial queue.
   * Each cwd has its own serial queue for parallel execution across workspaces.
   */
  enqueue(cwd: string, task: () => Promise<void>, opts?: EnqueueOptions): void {
    // Guard: reject non-function tasks that would poison the queue chain
    if (typeof task !== 'function') {
      getLogger().warn('[queue-manager] enqueue ignored task is not a function, cwd=', cwd);
      return;
    }

    // Mint a unique slot id for this task's execution period (regardless of
    // taskMeta). The slot binds begin/settle bookkeeping to this task, so an
    // interrupt credit granted by `resetExecutingCount` can only be consumed
    // by the interrupted task's own settle.
    const slotId = ++this.slotCounter;

    // Track this task in the queue for display card
    const taskMeta = opts?.taskMeta;
    let messagePreview: string | undefined;
    if (taskMeta) {
      messagePreview = taskMeta.messagePreview;
      const queuedTask: QueuedTask = {
        userId: taskMeta.userId,
        chatId: taskMeta.chatId,
        messageId: taskMeta.messageId,
        feishuReplyTo: taskMeta.feishuReplyTo,
        cwd,
        timestamp: Date.now(),
        messagePreview,
        editable: taskMeta.editable,
        binding: taskMeta.binding,
      };

      // Check if there are tasks waiting BEFORE adding this one
      const currentExecutingCount = this.pendingOrExecutingCount.get(cwd) ?? 0;
      const currentQueueLength = this.queuedTasks.get(cwd)?.length ?? 0;
      const hasWaitingTasks = currentExecutingCount > 0 || currentQueueLength > 0;

      // bound the waiting backlog. When the queue is full, reject the
      // task with a visible card instead of appending it (which would grow
      // the promise chain + closures unboundedly under a message flood and
      // fire another queue card). Do NOT increment pendingOrExecutingCount —
      // a rejected task never executes, so it must not occupy a slot.
      if (currentQueueLength >= MAX_WAITING_QUEUE) {
        getLogger().warn(
          `[queue-manager] queue full cwd=${cwd} depth=${currentQueueLength} rejecting task messageId=${taskMeta.messageId}`,
        );
        void this.sendCard(
          taskMeta.chatId,
          {
            schema: '2.0',
            config: { wide_screen_mode: true },
            header: {
              template: 'red',
              title: { tag: 'plain_text', content: '🚫 队列已满' },
            },
            body: {
              elements: [
                {
                  tag: 'div',
                  text: {
                    tag: 'lark_md',
                    content: `当前工作目录已有 ${MAX_WAITING_QUEUE} 条消息排队等待，为防止积压已拒收本条消息。请等待队列消化后重发，或用 \`/stop\` 清空当前任务。`,
                  },
                },
              ],
            },
          },
          { replyTo: taskMeta.feishuReplyTo ?? taskMeta.messageId },
        ).catch((err) => {
          getLogger().error('[queue-manager] failed to send queue-full rejection card:', err);
        });
        return;
      }

      // Add to cwd queue list
      let taskList = this.queuedTasks.get(cwd);
      if (!taskList) {
        taskList = [];
        this.queuedTasks.set(cwd, taskList);
      }
      // 身份不变量 tripwire：同一 cwd 内 queue key 必须唯一（一次入队动作一个
      // key，铸造点 router.mintQueueTaskKey）。撞 key 时数组（追加）与 taskIndex
      // （覆盖）必然漂移，位置显示/撤销/立即执行/卡片更新会串到别的条目上——
      // 2026-10-08 线上缺陷就是这么长出来的。这里不改行为，只留证据。
      if (this.indexGet(cwd, queuedTask.messageId)) {
        getLogger().warn(
          `[queue-manager] duplicate queue key cwd=${cwd} messageId=${queuedTask.messageId} — ` +
            'queue identity must be minted per enqueue action (see router.mintQueueTaskKey)',
        );
      }
      taskList.push(queuedTask);
      this.indexAdd(cwd, queuedTask);

      // Increment executing count SYNCHRONOUSLY so subsequent enqueues see it
      this.pendingOrExecutingCount.set(cwd, currentExecutingCount + 1);

      // Only send the queue card if the task actually has to wait.
      if (hasWaitingTasks) {
        void this.sendQueueStatusCard(
          cwd,
          taskMeta.chatId,
          taskMeta.messageId,
          messagePreview,
          // Reply to the real Feishu message id when the queue key is an
          // internal key (order.exec); otherwise messageId IS the Feishu id.
          taskMeta.feishuReplyTo,
        );
      }
      getLogger().debug(
        `[queue-manager] enqueue task queued cwd=${cwd} queueCard=${hasWaitingTasks} executing=${currentExecutingCount + 1} queueLen=${currentQueueLength + 1}`,
      );
    }

    // Get or create the queue for this cwd
    let queue = this.queues.get(cwd);
    if (!queue) {
      queue = Promise.resolve();
      this.queues.set(cwd, queue);
    }
    getLogger().debug(`[queue-manager] enqueue cwd=${cwd}`);

    // Capture messageId for cancellation guard
    const messageId = taskMeta?.messageId;
    // messagePreview already captured above (outside taskMeta block)
    const newQueue = queue
      .then(() => {
        getLogger().debug(`[queue-manager] task begin cwd=${cwd} messageId=${messageId}`);

        // Live preview for the executing card: read from the QueuedTask at
        // begin time, not the enqueue-closure `taskMeta` (which is frozen).
        // `updateQueuedTaskMessage` (queue.edit/queue.input) mutates the live
        // task, so a task edited while queued must show the edited content
        // when it naturally starts.
        let livePreview = taskMeta?.messagePreview ?? '';
        // Check if this task was cancelled before executing
        if (messageId) {
          // O(1) index lookup replaces the old `find` + `findIndex`
          // double O(N) scan. The ordered array still drives removal (splice
          // preserves queue order for position display); the index stays in
          // sync via indexRemove.
          const task = this.indexGet(cwd, messageId);
          if (!task) {
            getLogger().debug(
              `[queue-manager] task skipped (cancelled) cwd=${cwd} messageId=${messageId}`,
            );
            return;
          }
          livePreview = task.messagePreview;
          // Remove this task's metadata by messageId
          const taskList = this.queuedTasks.get(cwd);
          const idx = taskList?.findIndex((t) => t.messageId === messageId) ?? -1;
          if (taskList && idx >= 0) {
            taskList.splice(idx, 1);
          }
          this.indexRemove(cwd, messageId);
          // Cancellation check passed and the task has been removed: it is
          // about to run, so record it as began for queue.immediate feedback.
          // Bounded: ids are only consulted for the current immediate target,
          // so pruning the oldest entries is safe.
          if (this.beganMessageIds.size >= 10_000) {
            const oldest = this.beganMessageIds.values().next().value as string | undefined;
            if (oldest !== undefined) this.beganMessageIds.delete(oldest);
          }
          this.beganMessageIds.add(messageId);
        }
        // Consume any one-shot replacement closure registered by
        // `setTaskReplacement` (queue.edit + queue.immediate). The replacement
        // swaps in the edited content at this task's original queue slot, so
        // tasks queued behind it still run after it. Deleted here (one-shot)
        // so a stale closure can never run on a later task.
        let replacement: (() => Promise<void>) | undefined;
        if (messageId) {
          const workspaceReplacements = this.taskReplacements.get(cwd);
          replacement = workspaceReplacements?.get(messageId);
          if (replacement) {
            workspaceReplacements?.delete(messageId);
            if (workspaceReplacements && workspaceReplacements.size === 0) {
              this.taskReplacements.delete(cwd);
            }
          }
        }
        // Update queue card to "executing" status BEFORE running the task.
        // This must happen after the cancellation check: a skipped/cancelled
        // task must keep its "❌ 已撤销" card, not be flipped to executing.
        if (messageId) {
          void this.updateQueueCardToExecuting(cwd, messageId, livePreview, true);
        }
        // Re-arm the pending/executing count for every task that is about to
        // run. `resetExecutingCount` (external interrupt) zeroes the count,
        // and the interrupted task's settle consumes the skip-credit — so a
        // task enqueued BEFORE the interrupt can begin with count 0. Without
        // this, a running task is invisible to later enqueues and they
        // silently skip the "⏳ 消息排队中" card. This applies regardless of
        // taskMeta: resetExecutingCount can clear the count for any cwd,
        // and a task that resumes after an interrupt must re-arm even when it
        // carries no metadata.
        const currentCount = this.pendingOrExecutingCount.get(cwd) ?? 0;
        if (currentCount < 1) {
          this.pendingOrExecutingCount.set(cwd, 1);
          getLogger().debug(
            `[queue-manager] re-armed pendingOrExecutingCount cwd=${cwd} (interrupt resume)`,
          );
        }
        // Mark this task as the lane occupant for its whole execution period
        // before running it. `resetExecutingCount` reads the slot id to grant
        // the interrupt credit to exactly this task; the settle removes the
        // record. `kind`/`label` let a later message's queue card name what it
        // is waiting for instead of reporting "前面还有 0 条".
        this.executingInfo.set(cwd, {
          slotId,
          kind: taskMeta?.kind ?? 'message',
          label: laneOccupantLabel(taskMeta?.kind ?? 'message', livePreview),
          preview: livePreview,
          startedAt: Date.now(),
        });
        return replacement ? replacement() : task();
      })
      .then(() => {
        getLogger().debug(`[queue-manager] task end cwd=${cwd}`);
        // beganMessageIds entry intentionally retained: sticky by design
        // the marker records "has ever begun", not "is currently
        // running", so a task that began and settled quickly still reports
        // "已开始执行" to queue.immediate.
        this.decrementExecutingCount(cwd, slotId);
      })
      .catch((err: unknown) => {
        getLogger().error('[queue-manager] queue task error:', err);
        // Same sticky rationale as the success settle: the marker survives
        // even when the task errors after beginning.
        this.decrementExecutingCount(cwd, slotId);
      });
    this.queues.set(cwd, newQueue);
  }

  /**
   * Execute a task immediately without going through the queue.
   * Used for / commands that should respond immediately.
   */
  enqueueImmediate(cwd: string, task: () => Promise<void>): void {
    getLogger().debug(`[queue-manager] enqueueImmediate cwd=${cwd}`);
    void task().catch((err: unknown) =>
      getLogger().error('[queue-manager] immediate task error:', err),
    );
  }

  /**
   * One-shot: replace the execution closure of an existing queued task in
   * place, preserving its queue position (tasks queued behind it still run
   * after it). Consumed when the task's slot begins; removed if cancelled.
   */
  setTaskReplacement(cwd: string, messageId: string, task: () => Promise<void>): void {
    let workspaceReplacements = this.taskReplacements.get(cwd);
    if (!workspaceReplacements) {
      workspaceReplacements = new Map();
      this.taskReplacements.set(cwd, workspaceReplacements);
    }
    workspaceReplacements.set(messageId, task);
    getLogger().debug(`[queue-manager] set task replacement cwd=${cwd} messageId=${messageId}`);
  }

  /**
   * 排队卡头部。只有前面确实还有等待中的消息时才说「排队」；前面为空时
   * 用户等的是当前正在执行的任务（例如 Compact），用「等待当前任务结束」
   * 表达才不会与「前面还有 0 条」自相矛盾（2026-10-09 线上实例）。
   */
  private queueCardHeader(tasksAhead: number): {
    template: string;
    title: { tag: string; content: string };
  } {
    return {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: tasksAhead > 0 ? '⏳ 消息排队中' : '⏳ 等待当前任务结束',
      },
    };
  }

  /** Send a queue status card showing current queue position and actions. */
  private async sendQueueStatusCard(
    cwd: string,
    chatId: string,
    replyToMessageId: string,
    messagePreview?: string,
    /** Feishu reply target when `replyToMessageId` (the queue key) is an
     *  internal key, not a valid Feishu message id. Defaults to the queue key
     *  for hand-typed messages. */
    feishuReplyTo?: string,
  ): Promise<string | undefined> {
    const taskList = this.queuedTasks.get(cwd) ?? [];
    const positionInQueue = taskList.findIndex(
      (t) => t.chatId === chatId && t.messageId === replyToMessageId,
    );
    const actualPosition = positionInQueue + 1;
    const tasksAhead = actualPosition - 1;

    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: this.queueCardHeader(tasksAhead),
      body: {
        elements: this.buildQueueStatusCardElements(
          cwd,
          actualPosition,
          tasksAhead,
          replyToMessageId,
          messagePreview,
        ),
      },
    };

    // The Feishu reply target must be a real Feishu message id. The queue
    // dedup key (`replyToMessageId`) is an internal key for card-action
    // dispatches (order.exec), so reply to `feishuReplyTo` when provided.
    const feishuReplyTarget = feishuReplyTo ?? replyToMessageId;
    // Create the send promise and register it in the mapping BEFORE awaiting:
    // the begin path reads this mapping synchronously, so a late-resolving
    // send must still be reconcilable once its card id arrives.
    const sendPromise = this.sendCard(chatId, card, { replyTo: feishuReplyTarget }).catch((err) => {
      getLogger().error('[queue-manager] failed to send queue status card:', err);
      return undefined;
    });
    this.queueCardMessages.set(replyToMessageId, sendPromise);
    const messageId = await sendPromise;
    if (messageId === undefined) {
      // Send failed — the stored promise resolved undefined and no card
      // exists; drop the mapping so it does not accumulate across retried
      // failures.
      this.queueCardMessages.delete(replyToMessageId);
    }
    return messageId;
  }

  /** Get queue info for a cwd. */
  getQueueInfo(cwd: string): QueueInfo {
    const taskList = this.queuedTasks.get(cwd) ?? [];
    return {
      position: taskList.length,
      tasksAhead: Math.max(0, taskList.length - 1),
      isRunning: this.isWorkspaceRunning(cwd),
    };
  }

  /** Build queue status card elements. */
  private buildQueueStatusCardElements(
    cwd: string,
    actualPosition: number,
    tasksAhead: number,
    messageId: string,
    messagePreview?: string,
  ): object[] {
    const workspaceName = displayName(cwd);
    const occupant = this.executingInfo.get(cwd);
    const elements: object[] = [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**当前 Workspace:** \`${workspaceName}\`` },
      },
    ];

    // 「队列位置 / 前面还有」只在前面确实还有等待中的消息时渲染。前面为空时
    // 这两个数是「第 1 位 / 0 条」，与「排队中」字面矛盾；此时挡住用户的只有
    // 正在执行的任务，交给下一段如实说明。
    if (tasksAhead > 0) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**队列位置:** 第 ${actualPosition} 位\n**前面还有:** ${tasksAhead} 条消息`,
        },
      });
    }

    if (occupant) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**正在执行:** ${occupant.label}` },
      });
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            occupant.kind === 'compact'
              ? '💡 压缩结束后将按顺序执行你的消息'
              : '💡 消息将按顺序执行…',
        },
      });
    } else {
      // 防御分支：开卡判据是 lane 非空，所以「有排队卡但没有占用者」说明计数
      // 与占用者记录漂移了。不改行为，只留证据（与 duplicate queue key 同口径）。
      getLogger().warn(
        `[queue-manager] queue card without lane occupant cwd=${cwd} tasksAhead=${tasksAhead}`,
      );
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '💡 消息将按顺序执行…' },
      });
    }

    elements.push({ tag: 'hr' });

    // Show message preview with edit button (only if not executing AND the
    // task is editable). One-shot card actions like Compact enqueue with
    // editable=false: their preview is not user-editable text, so the ✏️ 编辑
    // button must not appear (queue card is still shown — only editing is
    // meaningless for them).
    if (messagePreview) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `📝 \`${messagePreview}\`` },
      });
      const task = this.indexGet(cwd, messageId);
      if (task?.editable !== false) {
        // Edit button: a pending (queued) task is editable by default. The
        // executing/cancelled states render via dedicated card builders that
        // hard-disable all buttons, so this builder only serves pending cards.
        elements.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '✏️ 编辑' },
          type: 'default',
          size: 'small',
          behaviors: [{ type: 'callback', value: { cmd: 'queue.edit', cwd, messageId } }],
        });
      }
      elements.push({ tag: 'hr' });
    }

    // Action buttons. Compact 占着 lane 时「⚡ 立即执行」会中断压缩
    // （interruptCurrentRun 遍历 activeRuns，压缩也注册在里面），按钮置灰并
    // 换文案说明；执行层 handleQueueImmediate 再做一次同样的守卫兜住旧卡片。
    elements.push(
      ...this.buildQueueActionButtons(
        cwd,
        messageId,
        false,
        occupant?.kind === 'compact' ? { immediateLabel: '压缩完成后按顺序执行' } : undefined,
      ),
    );

    return elements;
  }

  /**
   * Build the 撤销/立即执行 action button pair for a queue card.
   *
   * Both buttons route to `queue.cancel` / `queue.immediate` callbacks with
   * the same cwd/messageId; only the `disabled` flag varies by card
   * state — pending cards enable both, executing/cancelled cards disable
   * both. Centralizing the pair here eliminates the 3-way duplication
   * between `buildQueueStatusCardElements`, `updateQueueCardToExecuting`,
   * and `updateQueueCardToCancelled` (Clean Code).
   *
   * `opts.immediateLabel`（仅 pending 卡用）在 lane 被 Compact 占用时替换
   * 「⚡ 立即执行」并强制置灰：点击它会中断正在跑的压缩。「❌ 撤销」不参与，
   * 它只移除等待中的消息，不触碰 Compact。
   */
  private buildQueueActionButtons(
    cwd: string,
    messageId: string,
    disabled: boolean,
    opts?: { immediateLabel?: string },
  ): object[] {
    return [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '❌ 撤销' },
        type: 'danger',
        disabled,
        behaviors: [{ type: 'callback', value: { cmd: 'queue.cancel', cwd, messageId } }],
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: opts?.immediateLabel ?? '⚡ 立即执行' },
        type: 'primary',
        disabled: disabled || opts?.immediateLabel !== undefined,
        behaviors: [{ type: 'callback', value: { cmd: 'queue.immediate', cwd, messageId } }],
      },
    ];
  }

  /**
   * Update queue card to "started executing" status when task begins.
   *
   * `started` tells the method whether the caller has already confirmed the
   * task really began (begin path: cancellation check passed and the task has
   * been removed from the queue). When `started` is false (queue.immediate
   * mark path), a membership guard re-checks the task right before the card
   * update: if the task was removed/cancelled while the send was in flight,
   * the card must keep its "❌ 已撤销" state instead of being flipped back to
   * executing. The mapping is deleted in finally in both cases.
   */
  async updateQueueCardToExecuting(
    cwd: string,
    messageId: string,
    messagePreview: string,
    started = false,
  ): Promise<void> {
    const cardMessageId = await this.queueCardMessages.get(messageId);
    if (!cardMessageId) {
      getLogger().debug(`[queue-manager] no queue card to update, messageId=${messageId}`);
      return;
    }

    const workspaceName = displayName(cwd);

    try {
      // Prefer the live preview: an edited task's messagePreview is updated in
      // place, and the passed-in snapshot may be stale if the card send was in
      // flight while the user edited. The begin path (started=true) already
      // passes the live preview captured at begin, so the fallback is only
      // exercised when the task is no longer queued.
      const liveTask = this.indexGet(cwd, messageId);
      const stillQueued = liveTask !== undefined;
      if (!stillQueued && !started) {
        getLogger().debug(
          `[queue-manager] queue card update to executing skipped (task no longer queued and not started) messageId=${messageId}`,
        );
        return;
      }
      const previewForCard = liveTask?.messagePreview ?? messagePreview;
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: {
          template: 'green',
          title: { tag: 'plain_text', content: '▶️ 已开始执行' },
        },
        body: {
          elements: [
            {
              tag: 'div',
              text: { tag: 'lark_md', content: `**当前 Workspace:** \`${workspaceName}\`` },
            },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: `📝 \`${previewForCard}\`` } },
            { tag: 'hr' },
            ...this.buildQueueActionButtons(cwd, messageId, true),
          ],
        },
      };
      await this.updateCard(cardMessageId, card);
      getLogger().debug(`[queue-manager] queue card updated to executing messageId=${messageId}`);
    } catch (err) {
      getLogger().warn('[queue-manager] failed to update queue card to executing:', err);
    } finally {
      this.queueCardMessages.delete(messageId);
    }
  }

  /** Remove a task from the queue by messageId. Returns true if found and removed. */
  removeFromQueue(cwd: string, messageId: string): boolean {
    // Drop any one-shot replacement for this task: a cancelled/removed task
    // must never leave a closure behind that could execute later.
    const workspaceReplacements = this.taskReplacements.get(cwd);
    if (workspaceReplacements?.delete(messageId) && workspaceReplacements.size === 0) {
      this.taskReplacements.delete(cwd);
    }
    const taskList = this.queuedTasks.get(cwd);
    if (!taskList) return false;

    // index is the O(1) presence check; array splice keeps order.
    if (!this.indexGet(cwd, messageId)) return false;
    const index = taskList.findIndex((t) => t.messageId === messageId);
    if (index >= 0) {
      taskList.splice(index, 1);
    }
    this.indexRemove(cwd, messageId);
    // Note: queueCardMessages mapping is NOT deleted here.
    // The caller (handleQueueCancel) will call updateQueueCardToCancelled
    // which will clean up the mapping after updating the card.
    getLogger().info(`[queue-manager] removed from queue cwd=${cwd} messageId=${messageId}`);
    return true;
  }

  /** Update queue card to "cancelled" status when user clicks 撤销. */
  async updateQueueCardToCancelled(cwd: string, messageId: string): Promise<void> {
    const cardMessageId = await this.queueCardMessages.get(messageId);
    if (!cardMessageId) {
      getLogger().debug(
        `[queue-manager] no queue card to update (cancelled), messageId=${messageId}`,
      );
      return;
    }

    const workspaceName = displayName(cwd);
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'gray',
        title: { tag: 'plain_text', content: '❌ 已撤销' },
      },
      body: {
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: `**当前 Workspace:** \`${workspaceName}\`` },
          },
          { tag: 'hr' },
          { tag: 'div', text: { tag: 'lark_md', content: `📝 该消息已从队列中撤销` } },
          { tag: 'hr' },
          ...this.buildQueueActionButtons(cwd, messageId, true),
        ],
      },
    };

    try {
      await this.updateCard(cardMessageId, card);
      getLogger().debug(`[queue-manager] queue card updated to cancelled, messageId=${messageId}`);
    } catch (err) {
      getLogger().warn('[queue-manager] failed to update queue card to cancelled:', err);
    } finally {
      this.queueCardMessages.delete(messageId);
    }
  }

  /** Get task metadata from queue. */
  getQueuedTask(cwd: string, messageId: string): QueuedTask | undefined {
    // O(1) index lookup instead of array `find`.
    return this.indexGet(cwd, messageId);
  }

  /**
   * Whether a task with the given messageId has begun executing (cancellation
   * check passed, task removed from the queue). Sticky: true even after the
   * task settles, so queue.immediate can distinguish "began (possibly already
   * completed)" from "never began / cancelled".
   */
  hasBegan(messageId: string): boolean {
    return this.beganMessageIds.has(messageId);
  }

  /** Get all queued tasks for a cwd. Returns a copy to prevent aliasing bugs. */
  getQueuedTasks(cwd: string): QueuedTask[] {
    return [...(this.queuedTasks.get(cwd) ?? [])];
  }

  /** Update the messagePreview for a queued task. Returns true if found and updated. */
  updateQueuedTaskMessage(cwd: string, messageId: string, newMessage: string): boolean {
    // O(1) index lookup instead of array `find`.
    const task = this.indexGet(cwd, messageId);
    if (!task) return false;

    task.messagePreview = newMessage;
    task.editedMessage = newMessage;
    getLogger().info(`[queue-manager] updated messagePreview cwd=${cwd} messageId=${messageId}`);
    return true;
  }

  /**
   * Build the orange queue card reflecting the edited message content. Returns
   * the card object (sent as the cardAction callback response `card.data`,
   * which Feishu renders in place) or null if the task is no longer queued.
   *
   * Why a callback-response card instead of a PATCH updateCard API call:
   * when handleQueueInput returns a { toast } callback response, Feishu uses
   * that response to render the clicked card; a response without a `card`
   * field leaves the card in its pre-click (edit) state, overriding the
   * concurrent PATCH updateCard result. Returning { card } in the callback
   * response updates the card synchronously with no API race.
   */
  buildQueueCardForEdit(cwd: string, messageId: string, newMessagePreview: string): object | null {
    const taskList = this.queuedTasks.get(cwd) ?? [];
    const positionInQueue = taskList.findIndex((t) => t.messageId === messageId);
    if (positionInQueue < 0) {
      getLogger().info(
        `[queue-manager] task not in queue (build edit card), messageId=${messageId}`,
      );
      return null;
    }
    const actualPosition = positionInQueue + 1;
    const tasksAhead = positionInQueue;
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: this.queueCardHeader(tasksAhead),
      body: {
        elements: this.buildQueueStatusCardElements(
          cwd,
          actualPosition,
          tasksAhead,
          messageId,
          newMessagePreview,
        ),
      },
    };
  }

  /**
   * Decrement `pendingOrExecutingCount` for a cwd, honoring per-slot
   * interrupt bookkeeping.
   *
   * Called from the queue chain's `.then()`/`.catch()` settle with the slot
   * id minted at enqueue time. Three cases:
   *
   * 1. The slot is the workspace's current executing slot → its execution
   *    period ends (`executingInfo` record removed).
   * 2. The slot is in `interruptedSlots` (its task was interrupted by
   *    `resetExecutingCount`) → skip the decrement: the reset already zeroed
   *    the count, so a stale decrement could wrongly zero it again while a
   *    newer task (enqueued after the reset) is still running.
   * 3. Otherwise → normal decrement.
   */
  private decrementExecutingCount(cwd: string, slotId: number): void {
    if (this.executingInfo.get(cwd)?.slotId === slotId) {
      this.executingInfo.delete(cwd);
    }
    const interrupted = this.interruptedSlots.get(cwd);
    if (interrupted?.has(slotId)) {
      interrupted.delete(slotId);
      if (interrupted.size === 0) {
        this.interruptedSlots.delete(cwd);
      }
      getLogger().debug(
        `[queue-manager] skip decrement (interrupted slot) cwd=${cwd} slot=${slotId}`,
      );
      return;
    }
    const count = this.pendingOrExecutingCount.get(cwd) ?? 1;
    this.pendingOrExecutingCount.set(cwd, Math.max(0, count - 1));
  }

  /**
   * Reset the executing task count for a cwd.
   *
   * This should be called when a running task is interrupted externally
   * (e.g., via /stop command or "立即执行" button) so that the queue
   * correctly reflects that no tasks are currently executing.
   *
   * Without this reset, the pendingOrExecutingCount would remain > 0 even after
   * the task process is killed, causing subsequent messages to incorrectly
   * show as "排队中" because the queue thinks a task is still running.
   *
   * Also marks the currently executing task's slot as interrupted, so its
   * eventual `.then()`/`.catch()` settle skips the decrement (which could
   * otherwise zero the count while a newer task is still running). The mark
   * is granted at most once per slot: repeated resets of the same executing
   * task do not accumulate credits.
   *
   * `expectedSlot` binds the reset to the task that was actually interrupted:
   * the caller captures the executing slot BEFORE stopping the runner, and
   * the stop window may outlive the interrupted task's settle (the chain can
   * advance to a NEW task, which then owns `executingInfo`). When the current
   * slot no longer matches the interrupted task's slot, the interrupted task
   * already decremented normally — resetting now would zero the count of the
   * running successor and mark ITS slot interrupted, hiding it from the
   * queue card.
   */
  resetExecutingCount(cwd: string, expectedSlot: number): void {
    const currentSlot = this.executingInfo.get(cwd)?.slotId;
    if (currentSlot !== expectedSlot) {
      getLogger().debug(
        `[queue-manager] resetExecutingCount skip (stopped task settled, slot advanced) cwd=${cwd} expectedSlot=${expectedSlot} currentSlot=${currentSlot ?? 'none'}`,
      );
      return;
    }
    // only reset and grant an interrupt slot when there is actually a
    // pending/executing task.
    const currentCount = this.pendingOrExecutingCount.get(cwd) ?? 0;
    if (currentCount === 0) {
      getLogger().debug(`[queue-manager] resetExecutingCount no-op (count already 0) cwd=${cwd}`);
      return;
    }
    // Bind the interrupt credit to the currently executing task's slot (if
    // any; defensive against a count without an executing task). `Set.add`
    // dedupes repeated resets of the same slot.
    const slot = currentSlot;
    this.pendingOrExecutingCount.set(cwd, 0);
    if (slot !== undefined) {
      let interrupted = this.interruptedSlots.get(cwd);
      if (!interrupted) {
        interrupted = new Set();
        this.interruptedSlots.set(cwd, interrupted);
      }
      interrupted.add(slot);
      getLogger().debug(
        `[queue-manager] reset pendingOrExecutingCount cwd=${cwd} interruptedSlot=${slot}`,
      );
      return;
    }
    getLogger().debug(
      `[queue-manager] reset pendingOrExecutingCount cwd=${cwd} (no executing slot)`,
    );
  }

  /**
   * The slot id of the task currently executing in this cwd (if any).
   */
  getExecutingSlot(cwd: string): number | undefined {
    return this.executingInfo.get(cwd)?.slotId;
  }

  /**
   * The lane occupant's display info for this cwd (if any). Queue cards read
   * it to name what a waiting message is waiting for; `handleQueueImmediate`
   * reads it to refuse interrupting a running Compact. Returns a copy so
   * callers cannot mutate the live record.
   */
  getExecutingInfo(cwd: string): ExecutingInfo | undefined {
    const info = this.executingInfo.get(cwd);
    return info ? { ...info } : undefined;
  }
}
