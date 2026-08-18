import { getLogger } from '../logger/index.js';
import type { AgentKind } from '../runner/types.js';

/**
 * 入队时刻快照：当前 defaultAgent + 该 agent 的 sessionId（无 session 则 undefined）。
 * 唯一捕获点：排队消息在 T0 把 agent+session 钉进 AgentBinding，随任务闭包带到 T1
 * 执行时刻，避免 /new、/config 在排队期间改写 live 状态导致语义漂移（方案 D4）。
 */
export interface AgentBinding {
  agent: AgentKind;
  sessionId?: string;
}

/**
 * Per-workspace cap on the number of tasks WAITING to execute (review P2-5).
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
  workspace: string;
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
  /** 入队时刻捕获的 agent+session 绑定（方案 D4），随任务闭包带到执行时刻。 */
  binding?: AgentBinding;
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
    /** 入队时刻捕获的 agent+session 绑定（方案 D4）。 */
    binding?: AgentBinding;
  };
}

/** Queue info for a workspace */
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
   * P3-5: per-workspace `messageId → QueuedTask` index mirroring `queuedTasks`.
   * O(1) lookup for the task-start removal path (replacing the old double
   * `find`+`findIndex` O(N) scan) and for `getQueuedTask`/`removeFromQueue`/
   * `updateQueuedTaskMessage`. The ordered array remains the source of truth
   * (position display depends on order); the index must be kept in sync on
   * every mutation (push / splice / shift) via the `indexAdd`/`indexRemove`
   * helpers. Same messageId is never enqueued twice in one workspace
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
  /** Track number of executing tasks per workspace (for queue card display). */
  private pendingOrExecutingCount = new Map<string, number>();
  /**
   * Monotonic counter minting a unique slot id per enqueued task. A slot
   * identifies one task's execution period for the interrupt bookkeeping in
   * `executingSlot`/`interruptedSlots` — replacing the unowned skip-credit
   * counter, which any settle could consume and which therefore leaked a
   * re-armed count after repeated resets (see A4 anchor).
   */
  private slotCounter = 0;
  /**
   * Per-workspace slot id of the task currently executing. Set in the begin
   * path right before the task runs; deleted when that task's settle fires.
   * `resetExecutingCount` reads it to bind the interrupt credit to exactly
   * the interrupted task's slot.
   */
  private executingSlot = new Map<string, number>();
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
   * after the task settles (A21). `handleQueueImmediate` step 6 uses this to
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

  /** Callback to check if workspace has an active run */
  private isWorkspaceRunning: (workspace: string) => boolean;

  /** Callback to send card updates */
  private sendCard: (chatId: string, card: object, opts?: { replyTo?: string }) => Promise<string>;
  /** Callback to update existing card */
  private updateCard: (messageId: string, card: object) => Promise<void>;

  constructor(
    isWorkspaceRunning: (workspace: string) => boolean,
    sendCard: (chatId: string, card: object, opts?: { replyTo?: string }) => Promise<string>,
    updateCard: (messageId: string, card: object) => Promise<void>,
  ) {
    this.isWorkspaceRunning = isWorkspaceRunning;
    this.sendCard = sendCard;
    this.updateCard = updateCard;
  }

  /** P3-5: register a queued task in the per-workspace `messageId → task` index. */
  private indexAdd(workspace: string, task: QueuedTask): void {
    let idx = this.taskIndex.get(workspace);
    if (!idx) {
      idx = new Map();
      this.taskIndex.set(workspace, idx);
    }
    idx.set(task.messageId, task);
  }

  /** P3-5: drop a task from the per-workspace index by messageId. */
  private indexRemove(workspace: string, messageId: string): void {
    this.taskIndex.get(workspace)?.delete(messageId);
  }

  /** P3-5: O(1) lookup of a queued task by messageId via the index. */
  private indexGet(workspace: string, messageId: string): QueuedTask | undefined {
    return this.taskIndex.get(workspace)?.get(messageId);
  }

  /**
   * Enqueue a task into the workspace-level serial queue.
   * Each workspace has its own serial queue for parallel execution across workspaces.
   */
  enqueue(workspace: string, task: () => Promise<void>, opts?: EnqueueOptions): void {
    // Guard: reject non-function tasks that would poison the queue chain
    if (typeof task !== 'function') {
      getLogger().warn(
        '[queue-manager] enqueue ignored task is not a function, workspace=',
        workspace,
      );
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
        workspace,
        timestamp: Date.now(),
        messagePreview,
        editable: taskMeta.editable,
        binding: taskMeta.binding,
      };

      // Check if there are tasks waiting BEFORE adding this one
      const currentExecutingCount = this.pendingOrExecutingCount.get(workspace) ?? 0;
      const currentQueueLength = this.queuedTasks.get(workspace)?.length ?? 0;
      const hasWaitingTasks = currentExecutingCount > 0 || currentQueueLength > 0;

      // P2-5: bound the waiting backlog. When the queue is full, reject the
      // task with a visible card instead of appending it (which would grow
      // the promise chain + closures unboundedly under a message flood and
      // fire another queue card). Do NOT increment pendingOrExecutingCount —
      // a rejected task never executes, so it must not occupy a slot.
      if (currentQueueLength >= MAX_WAITING_QUEUE) {
        getLogger().warn(
          `[queue-manager] queue full workspace=${workspace} depth=${currentQueueLength} rejecting task messageId=${taskMeta.messageId}`,
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
                    content: `当前 workspace 已有 ${MAX_WAITING_QUEUE} 条消息排队等待，为防止积压已拒收本条消息。请等待队列消化后重发，或用 \`/stop\` 清空当前任务。`,
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

      // Add to workspace queue list
      let taskList = this.queuedTasks.get(workspace);
      if (!taskList) {
        taskList = [];
        this.queuedTasks.set(workspace, taskList);
      }
      taskList.push(queuedTask);
      this.indexAdd(workspace, queuedTask);

      // Increment executing count SYNCHRONOUSLY so subsequent enqueues see it
      this.pendingOrExecutingCount.set(workspace, currentExecutingCount + 1);

      // Only send the queue card if the task actually has to wait.
      if (hasWaitingTasks) {
        void this.sendQueueStatusCard(
          workspace,
          taskMeta.chatId,
          taskMeta.messageId,
          messagePreview,
          // Reply to the real Feishu message id when the queue key is an
          // internal key (order.exec); otherwise messageId IS the Feishu id.
          taskMeta.feishuReplyTo,
        );
      }
      getLogger().debug(
        `[queue-manager] enqueue task queued workspace=${workspace} queueCard=${hasWaitingTasks} executing=${currentExecutingCount + 1} queueLen=${currentQueueLength + 1}`,
      );
    }

    // Get or create the queue for this workspace
    let queue = this.queues.get(workspace);
    if (!queue) {
      queue = Promise.resolve();
      this.queues.set(workspace, queue);
    }
    getLogger().debug(`[queue-manager] enqueue workspace=${workspace}`);

    // Capture messageId for cancellation guard
    const messageId = taskMeta?.messageId;
    // messagePreview already captured above (outside taskMeta block)
    const newQueue = queue
      .then(() => {
        getLogger().debug(
          `[queue-manager] task begin workspace=${workspace} messageId=${messageId}`,
        );

        // Live preview for the executing card: read from the QueuedTask at
        // begin time, not the enqueue-closure `taskMeta` (which is frozen).
        // `updateQueuedTaskMessage` (queue.edit/queue.input) mutates the live
        // task, so a task edited while queued must show the edited content
        // when it naturally starts.
        let livePreview = taskMeta?.messagePreview ?? '';
        // Check if this task was cancelled before executing
        if (messageId) {
          // P3-5: O(1) index lookup replaces the old `find` + `findIndex`
          // double O(N) scan. The ordered array still drives removal (splice
          // preserves queue order for position display); the index stays in
          // sync via indexRemove.
          const task = this.indexGet(workspace, messageId);
          if (!task) {
            getLogger().debug(
              `[queue-manager] task skipped (cancelled) workspace=${workspace} messageId=${messageId}`,
            );
            return;
          }
          livePreview = task.messagePreview;
          // Remove this task's metadata by messageId
          const taskList = this.queuedTasks.get(workspace);
          const idx = taskList?.findIndex((t) => t.messageId === messageId) ?? -1;
          if (taskList && idx >= 0) {
            taskList.splice(idx, 1);
          }
          this.indexRemove(workspace, messageId);
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
          const workspaceReplacements = this.taskReplacements.get(workspace);
          replacement = workspaceReplacements?.get(messageId);
          if (replacement) {
            workspaceReplacements?.delete(messageId);
            if (workspaceReplacements && workspaceReplacements.size === 0) {
              this.taskReplacements.delete(workspace);
            }
          }
        }
        // Update queue card to "executing" status BEFORE running the task.
        // This must happen after the cancellation check: a skipped/cancelled
        // task must keep its "❌ 已撤销" card, not be flipped to executing.
        if (messageId) {
          void this.updateQueueCardToExecuting(workspace, messageId, livePreview, true);
        }
        // Re-arm the pending/executing count for every task that is about to
        // run. `resetExecutingCount` (external interrupt) zeroes the count,
        // and the interrupted task's settle consumes the skip-credit — so a
        // task enqueued BEFORE the interrupt can begin with count 0. Without
        // this, a running task is invisible to later enqueues and they
        // silently skip the "⏳ 消息排队中" card. This applies regardless of
        // taskMeta: resetExecutingCount can clear the count for any workspace,
        // and a task that resumes after an interrupt must re-arm even when it
        // carries no metadata.
        const currentCount = this.pendingOrExecutingCount.get(workspace) ?? 0;
        if (currentCount < 1) {
          this.pendingOrExecutingCount.set(workspace, 1);
          getLogger().debug(
            `[queue-manager] re-armed pendingOrExecutingCount workspace=${workspace} (interrupt resume)`,
          );
        }
        // Mark this task's slot as the current execution period before running
        // it. `resetExecutingCount` reads this marker to grant the interrupt
        // credit to exactly this task; the settle removes the marker.
        this.executingSlot.set(workspace, slotId);
        return replacement ? replacement() : task();
      })
      .then(() => {
        getLogger().debug(`[queue-manager] task end workspace=${workspace}`);
        // beganMessageIds entry intentionally retained: sticky by design
        // (A21) — the marker records "has ever begun", not "is currently
        // running", so a task that began and settled quickly still reports
        // "已开始执行" to queue.immediate.
        this.decrementExecutingCount(workspace, slotId);
      })
      .catch((err: unknown) => {
        getLogger().error('[queue-manager] queue task error:', err);
        // Same sticky rationale as the success settle: the marker survives
        // even when the task errors after beginning (A21).
        this.decrementExecutingCount(workspace, slotId);
      });
    this.queues.set(workspace, newQueue);
  }

  /**
   * Execute a task immediately without going through the queue.
   * Used for / commands that should respond immediately.
   */
  enqueueImmediate(workspace: string, task: () => Promise<void>): void {
    getLogger().debug(`[queue-manager] enqueueImmediate workspace=${workspace}`);
    void task().catch((err: unknown) =>
      getLogger().error('[queue-manager] immediate task error:', err),
    );
  }

  /**
   * One-shot: replace the execution closure of an existing queued task in
   * place, preserving its queue position (tasks queued behind it still run
   * after it). Consumed when the task's slot begins; removed if cancelled.
   */
  setTaskReplacement(workspace: string, messageId: string, task: () => Promise<void>): void {
    let workspaceReplacements = this.taskReplacements.get(workspace);
    if (!workspaceReplacements) {
      workspaceReplacements = new Map();
      this.taskReplacements.set(workspace, workspaceReplacements);
    }
    workspaceReplacements.set(messageId, task);
    getLogger().debug(
      `[queue-manager] set task replacement workspace=${workspace} messageId=${messageId}`,
    );
  }

  /** Send a queue status card showing current queue position and actions. */
  private async sendQueueStatusCard(
    workspace: string,
    chatId: string,
    replyToMessageId: string,
    messagePreview?: string,
    /** Feishu reply target when `replyToMessageId` (the queue key) is an
     *  internal key, not a valid Feishu message id. Defaults to the queue key
     *  for hand-typed messages. */
    feishuReplyTo?: string,
  ): Promise<string | undefined> {
    const taskList = this.queuedTasks.get(workspace) ?? [];
    const positionInQueue = taskList.findIndex(
      (t) => t.chatId === chatId && t.messageId === replyToMessageId,
    );
    const actualPosition = positionInQueue + 1;
    const tasksAhead = actualPosition - 1;

    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '⏳ 消息排队中' },
      },
      body: {
        elements: this.buildQueueStatusCardElements(
          workspace,
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

  /** Get queue info for a workspace. */
  getQueueInfo(workspace: string): QueueInfo {
    const taskList = this.queuedTasks.get(workspace) ?? [];
    return {
      position: taskList.length,
      tasksAhead: Math.max(0, taskList.length - 1),
      isRunning: this.isWorkspaceRunning(workspace),
    };
  }

  /** Build queue status card elements. */
  private buildQueueStatusCardElements(
    workspace: string,
    actualPosition: number,
    tasksAhead: number,
    messageId: string,
    messagePreview?: string,
  ): object[] {
    const workspaceName = workspace.split('/').pop() ?? workspace;
    const isRunning = this.isWorkspaceRunning(workspace);
    const elements: object[] = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**当前 Workspace:** \`${workspaceName}\`\n**位置:** 第 ${actualPosition} 位\n**前面还有:** ${tasksAhead} 条消息在排队`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `💡 消息将按顺序执行…当前正在处理: ${isRunning ? '有任务运行中' : '空闲'}`,
        },
      },
      { tag: 'hr' },
    ];

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
      const task = this.indexGet(workspace, messageId);
      if (task?.editable !== false) {
        // Edit button: a pending (queued) task is editable by default. The
        // executing/cancelled states render via dedicated card builders that
        // hard-disable all buttons, so this builder only serves pending cards.
        elements.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '✏️ 编辑' },
          type: 'default',
          size: 'small',
          behaviors: [{ type: 'callback', value: { cmd: 'queue.edit', workspace, messageId } }],
        });
      }
      elements.push({ tag: 'hr' });
    }

    // Action buttons
    elements.push(...this.buildQueueActionButtons(workspace, messageId, false));

    return elements;
  }

  /**
   * Build the 撤销/立即执行 action button pair for a queue card.
   *
   * Both buttons route to `queue.cancel` / `queue.immediate` callbacks with
   * the same workspace/messageId; only the `disabled` flag varies by card
   * state — pending cards enable both, executing/cancelled cards disable
   * both. Centralizing the pair here eliminates the 3-way duplication
   * between `buildQueueStatusCardElements`, `updateQueueCardToExecuting`,
   * and `updateQueueCardToCancelled` (Clean Code P2-1).
   */
  private buildQueueActionButtons(
    workspace: string,
    messageId: string,
    disabled: boolean,
  ): object[] {
    return [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '❌ 撤销' },
        type: 'danger',
        disabled,
        behaviors: [{ type: 'callback', value: { cmd: 'queue.cancel', workspace, messageId } }],
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '⚡ 立即执行' },
        type: 'primary',
        disabled,
        behaviors: [{ type: 'callback', value: { cmd: 'queue.immediate', workspace, messageId } }],
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
    workspace: string,
    messageId: string,
    messagePreview: string,
    started = false,
  ): Promise<void> {
    const cardMessageId = await this.queueCardMessages.get(messageId);
    if (!cardMessageId) {
      getLogger().debug(`[queue-manager] no queue card to update, messageId=${messageId}`);
      return;
    }

    const workspaceName = workspace.split('/').pop() ?? workspace;

    try {
      // Prefer the live preview: an edited task's messagePreview is updated in
      // place, and the passed-in snapshot may be stale if the card send was in
      // flight while the user edited (A19). The begin path (started=true) already
      // passes the live preview captured at begin (A12), so the fallback is only
      // exercised when the task is no longer queued.
      const liveTask = this.indexGet(workspace, messageId);
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
            ...this.buildQueueActionButtons(workspace, messageId, true),
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
  removeFromQueue(workspace: string, messageId: string): boolean {
    // Drop any one-shot replacement for this task: a cancelled/removed task
    // must never leave a closure behind that could execute later.
    const workspaceReplacements = this.taskReplacements.get(workspace);
    if (workspaceReplacements?.delete(messageId) && workspaceReplacements.size === 0) {
      this.taskReplacements.delete(workspace);
    }
    const taskList = this.queuedTasks.get(workspace);
    if (!taskList) return false;

    // P3-5: index is the O(1) presence check; array splice keeps order.
    if (!this.indexGet(workspace, messageId)) return false;
    const index = taskList.findIndex((t) => t.messageId === messageId);
    if (index >= 0) {
      taskList.splice(index, 1);
    }
    this.indexRemove(workspace, messageId);
    // Note: queueCardMessages mapping is NOT deleted here.
    // The caller (handleQueueCancel) will call updateQueueCardToCancelled
    // which will clean up the mapping after updating the card.
    getLogger().info(
      `[queue-manager] removed from queue workspace=${workspace} messageId=${messageId}`,
    );
    return true;
  }

  /** Update queue card to "cancelled" status when user clicks 撤销. */
  async updateQueueCardToCancelled(workspace: string, messageId: string): Promise<void> {
    const cardMessageId = await this.queueCardMessages.get(messageId);
    if (!cardMessageId) {
      getLogger().debug(
        `[queue-manager] no queue card to update (cancelled), messageId=${messageId}`,
      );
      return;
    }

    const workspaceName = workspace.split('/').pop() ?? workspace;
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
          ...this.buildQueueActionButtons(workspace, messageId, true),
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
  getQueuedTask(workspace: string, messageId: string): QueuedTask | undefined {
    // P3-5: O(1) index lookup instead of array `find`.
    return this.indexGet(workspace, messageId);
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

  /** Get all queued tasks for a workspace. Returns a copy to prevent aliasing bugs. */
  getQueuedTasks(workspace: string): QueuedTask[] {
    return [...(this.queuedTasks.get(workspace) ?? [])];
  }

  /** Update the messagePreview for a queued task. Returns true if found and updated. */
  updateQueuedTaskMessage(workspace: string, messageId: string, newMessage: string): boolean {
    // P3-5: O(1) index lookup instead of array `find`.
    const task = this.indexGet(workspace, messageId);
    if (!task) return false;

    task.messagePreview = newMessage;
    task.editedMessage = newMessage;
    getLogger().info(
      `[queue-manager] updated messagePreview workspace=${workspace} messageId=${messageId}`,
    );
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
  buildQueueCardForEdit(
    workspace: string,
    messageId: string,
    newMessagePreview: string,
  ): object | null {
    const taskList = this.queuedTasks.get(workspace) ?? [];
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
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '⏳ 消息排队中' },
      },
      body: {
        elements: this.buildQueueStatusCardElements(
          workspace,
          actualPosition,
          tasksAhead,
          messageId,
          newMessagePreview,
        ),
      },
    };
  }

  /**
   * Decrement `pendingOrExecutingCount` for a workspace, honoring per-slot
   * interrupt bookkeeping.
   *
   * Called from the queue chain's `.then()`/`.catch()` settle with the slot
   * id minted at enqueue time. Three cases:
   *
   * 1. The slot is the workspace's current executing slot → its execution
   *    period ends (`executingSlot` marker removed).
   * 2. The slot is in `interruptedSlots` (its task was interrupted by
   *    `resetExecutingCount`) → skip the decrement: the reset already zeroed
   *    the count, so a stale decrement could wrongly zero it again while a
   *    newer task (enqueued after the reset) is still running.
   * 3. Otherwise → normal decrement.
   */
  private decrementExecutingCount(workspace: string, slotId: number): void {
    if (this.executingSlot.get(workspace) === slotId) {
      this.executingSlot.delete(workspace);
    }
    const interrupted = this.interruptedSlots.get(workspace);
    if (interrupted?.has(slotId)) {
      interrupted.delete(slotId);
      if (interrupted.size === 0) {
        this.interruptedSlots.delete(workspace);
      }
      getLogger().debug(
        `[queue-manager] skip decrement (interrupted slot) workspace=${workspace} slot=${slotId}`,
      );
      return;
    }
    const count = this.pendingOrExecutingCount.get(workspace) ?? 1;
    this.pendingOrExecutingCount.set(workspace, Math.max(0, count - 1));
  }

  /**
   * Reset the executing task count for a workspace.
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
   * advance to a NEW task, which then owns `executingSlot`). When the current
   * slot no longer matches the interrupted task's slot, the interrupted task
   * already decremented normally — resetting now would zero the count of the
   * running successor and mark ITS slot interrupted, hiding it from the
   * queue card (A22).
   */
  resetExecutingCount(workspace: string, expectedSlot: number): void {
    const currentSlot = this.executingSlot.get(workspace);
    if (currentSlot !== expectedSlot) {
      getLogger().debug(
        `[queue-manager] resetExecutingCount skip (stopped task settled, slot advanced) workspace=${workspace} expectedSlot=${expectedSlot} currentSlot=${currentSlot ?? 'none'}`,
      );
      return;
    }
    // P3#9: only reset and grant an interrupt slot when there is actually a
    // pending/executing task.
    const currentCount = this.pendingOrExecutingCount.get(workspace) ?? 0;
    if (currentCount === 0) {
      getLogger().debug(
        `[queue-manager] resetExecutingCount no-op (count already 0) workspace=${workspace}`,
      );
      return;
    }
    // Bind the interrupt credit to the currently executing task's slot (if
    // any; defensive against a count without an executing task). `Set.add`
    // dedupes repeated resets of the same slot.
    const slot = currentSlot;
    this.pendingOrExecutingCount.set(workspace, 0);
    if (slot !== undefined) {
      let interrupted = this.interruptedSlots.get(workspace);
      if (!interrupted) {
        interrupted = new Set();
        this.interruptedSlots.set(workspace, interrupted);
      }
      interrupted.add(slot);
      getLogger().debug(
        `[queue-manager] reset pendingOrExecutingCount workspace=${workspace} interruptedSlot=${slot}`,
      );
      return;
    }
    getLogger().debug(
      `[queue-manager] reset pendingOrExecutingCount workspace=${workspace} (no executing slot)`,
    );
  }

  /**
   * The slot id of the task currently executing in this workspace (if any).
   */
  getExecutingSlot(workspace: string): number | undefined {
    return this.executingSlot.get(workspace);
  }
}
