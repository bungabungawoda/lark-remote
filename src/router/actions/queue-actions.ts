// 排队卡动作族：实现从 CommandRouter 搬出，类上保留同名薄委托。
import type { CommandContext } from '../../bridge/index.js';
import type { AgentBinding } from '../../bridge/queue-manager.js';
import { getLogger } from '../../logger/index.js';
import type { AgentKind } from '../../agent-kinds.js';
import { agentDisplayName } from '../../card/card-shared.js';
import type { CommandRouter } from '../index.js';
import type { CardActionResponse } from './shared.js';
import { CARD_PAYLOAD_MISSING } from './shared.js';

export async function queuePayloadOrReply(
  host: CommandRouter,
  value: { cwd?: string; messageId?: string },
  ctx: CommandContext,
): Promise<{ cwd: string; messageId: string } | null> {
  if (!value.cwd || !value.messageId) {
    await host.bridge.sendResult({ text: CARD_PAYLOAD_MISSING }, ctx);
    return null;
  }
  return { cwd: value.cwd, messageId: value.messageId };
}

/**
 * Handle queue.cancel: remove this message from the queue.
 */
export async function handleQueueCancel(
  host: CommandRouter,
  value: { cwd?: string; messageId?: string },
  ctx: CommandContext,
): Promise<void> {
  const payload = await host.queuePayloadOrReply(value, ctx);
  if (!payload) return;
  const { cwd, messageId } = payload;

  const removed = host.bridge.removeFromQueue(cwd, messageId);
  if (removed) {
    // 队列卡的「已撤销」更新由 removeFromQueue 统一触发（单一收口）；
    // 这里只负责给点击者一个即时反馈。
    await host.bridge.sendResult({ text: '✅ 已从队列中撤销' }, ctx);
  } else {
    await host.bridge.sendResult({ text: '⚠️ 该消息不在队列中（可能已开始执行）' }, ctx);
  }
}

/**
 * 把「执行编辑后的内容」注册成原队列槽位的一次性 replacement（复用入队时
 * 捕获的 binding + 恢复 lane cwd，否则编辑后重跑的 run 会丢 cwd 与绑定）。
 *
 * 重新入队不行：`enqueue` 只能追加到 promise 链尾部，会把编辑任务甩到
 * 后来者后面，违背「立即执行 = 下一个就跑」。三个调用点都必须在任何 await
 * 之前注册——begin 路径消费 replacement 的时机不可预测（见
 * handleQueueImmediate 步骤 1.5 的竞态说明）。
 */
export function registerEditedReplacement(
  host: CommandRouter,
  cwd: string,
  messageId: string,
  content: string,
  binding: AgentBinding | undefined,
  ctx: CommandContext,
): void {
  host.bridge.setTaskReplacement(cwd, messageId, async () => {
    await host.handle(content, ctx, { cwdOverride: cwd, binding });
  });
}

export async function handleQueueImmediate(
  host: CommandRouter,
  value: { cwd?: string; messageId?: string },
  ctx: CommandContext,
): Promise<void> {
  const payload = await host.queuePayloadOrReply(value, ctx);
  if (!payload) return;
  const { cwd, messageId } = payload;

  // 1. Check target exists BEFORE any await. The queue chain can advance
  // while later awaits (interruptCurrentRun / markQueueCardExecuting's card
  // send) are in flight, so the target must be read synchronously at entry.
  const targetTask = host.bridge.getQueuedTask(cwd, messageId);

  if (!targetTask) {
    // The target already began (or was cancelled) before this handler ran. We
    // must NOT claim the queue was cleared — nothing is removed in this branch
    // and tasks queued behind the target are still waiting.
    await host.bridge.sendResult(
      {
        text: '该消息已不在队列中（可能已开始执行或被撤销），无法立即执行。其余排队消息保持原状。',
      },
      ctx,
    );
    return;
  }

  // Compact 占 lane 时拒绝「立即执行」。该动作会调 interruptCurrentRun，而它
  // 遍历 activeRuns 时会一并中断正在跑的压缩（压缩也注册在 activeRuns 里）。
  // 渲染层已把按钮置灰，这里是旧卡片的兜底：改动前渲染的卡仍带可点的按钮。
  // 放在存在性检查之后：目标已失效时，上一条「不在队列中」的反馈更准确。
  const laneOccupant = host.bridge.getQueueExecutingInfo(cwd);
  if (laneOccupant?.kind === 'compact') {
    await host.bridge.sendResult({ text: '⚠️ 正在压缩会话，消息将在压缩完成后按顺序执行。' }, ctx);
    return;
  }

  // 1.4. Hold the target's run-card start until this handler has sent its
  // final feedback. The queue chain can advance during the awaits below
  // (interruptCurrentRun / the queue-card PATCH): the target may begin and
  // call forwardToClaude before the toast is sent. Without this hold the
  // run card would land first, leaving the toast as the newest message —
  // the chat list then previews the toast instead of the run card's title
  // (which is how the user follows a run without opening the conversation).
  // Registered before any await, released in finally on every exit path;
  // forwardToClaude waits for it before creating the run card.
  const releaseRunStart = host.bridge.holdQueueTaskRun(cwd, messageId);

  try {
    // 1.5. If the user edited the message, the original closure (captured at
    // enqueue time with stale content) must NOT run. Register a one-shot
    // replacement closure on the task's EXISTING queue slot BEFORE any await:
    // interruptCurrentRun / markQueueCardExecuting can let the chain advance to
    // this task's begin, and begin consumes the replacement at that point — a
    // registration after those awaits would arrive too late (the stale closure
    // runs and the replacement leaks as a permanent dead closure). Registering
    // on the existing slot (instead of removeFromQueue + re-enqueue) preserves
    // the queue position: enqueue can only append to the promise chain tail,
    // which would put the edited task behind tasks queued after it.
    if (targetTask.editedMessage) {
      host.registerEditedReplacement(
        cwd,
        messageId,
        targetTask.editedMessage,
        targetTask.binding,
        ctx,
      );
    }

    // 2. Stop current running process
    // (Note: queue executing count is reset inside Bridge.interruptCurrentRun
    //  so all stop paths — /stop, /t, card stop, queue.immediate — are covered.)
    const interrupt = await host.bridge.interruptCurrentRunDetailed({
      userId: ctx.userId,
      chatId: ctx.chatId,
      cwd,
    });
    const stopped = interrupt.stopped;
    // A remote (DSH) stop is only a request; when it cannot be confirmed the
    // target must not be promised "immediate" execution — its prompt would sit
    // behind the still-running turn with no visible progress.
    const stopUnconfirmed = interrupt.stop?.status === 'unconfirmed';
    getLogger().info(`[router] queue.immediate: stopped=${stopped} unconfirmed=${stopUnconfirmed}`);

    // 3. Remove all tasks BEFORE this one (by position in the current queue).
    const removedCount = host.clearTasksAheadOfTarget(cwd, messageId);

    // 4. DO NOT remove the target task - keep it in queue to execute immediately
    // The queue will naturally execute it after the current task (which we just stopped)

    // 4.4. Refresh the replacement with the latest edited content (idempotent:
    // re-registering over the same slot). Covers the user editing the message
    // again while interruptCurrentRun was awaiting; skipped automatically once
    // the task has begun, because getQueuedTask then returns undefined.
    const latestTask = host.bridge.getQueuedTask(cwd, messageId);
    if (latestTask?.editedMessage) {
      host.registerEditedReplacement(
        cwd,
        messageId,
        latestTask.editedMessage,
        latestTask.binding,
        ctx,
      );
    }

    // 4.5/6. 按「目标此刻真的是下一个吗」给唯一一份用户可见反馈。
    await host.reportImmediateOutcome({
      cwd,
      messageId,
      ctx,
      removedCount,
      stopped,
      stopUnconfirmed,
      agentKind: interrupt.agentKind,
    });
  } finally {
    releaseRunStart();
  }
}

/**
 * 清掉排在目标之前的所有排队任务，返回实际清除条数。
 *
 * 两条红线：
 * - 目标可能在 interruptCurrentRun 等待期间已经接跑（链并发前进），那时它已不在
 *   快照里，剩下的全部排在它**后面**——清除必须在目标位置之前停下，不得越界删掉
 *   用户没要求清除的任务。
 * - 移除循环必须整体同步：队列链在任何 await 处都会推进（卡片 PATCH 也算），
 *   一旦让出事件循环，用户要求清除的任务可能趁撤销卡还在路上就跑起来了。
 *   撤销卡片由 `removeFromQueue` 统一触发（fire-and-forget）。
 */
export function clearTasksAheadOfTarget(
  host: CommandRouter,
  cwd: string,
  messageId: string,
): number {
  const tasks = host.bridge.getQueuedTasks(cwd);
  const targetIdx = tasks.findIndex((t) => t.messageId === messageId);
  let removedCount = 0;
  for (let i = 0; i < targetIdx; i++) {
    if (host.bridge.removeFromQueue(cwd, tasks[i].messageId)) {
      removedCount++;
    }
  }
  if (targetIdx < 0) {
    getLogger().debug(
      `[router] queue.immediate: target no longer queued (began/cancelled), not clearing tasks behind it`,
    );
  }
  return removedCount;
}

/**
 * `queue.immediate` 的终态反馈（唯一出口）。
 *
 * 承诺必须与真实调度一致：目标只有确实是停止后的下一个，才可以把它的卡翻成
 * 「执行中」并说「将立即执行」；在途接跑/被撤销/被抢先/远程停止未确认四种状态
 * 各给各的文案（把没发生的事说成发生了，比沉默更糟——用户会据文案决定要不要重发）。
 */
export async function reportImmediateOutcome(
  host: CommandRouter,
  opts: {
    cwd: string;
    messageId: string;
    ctx: CommandContext;
    removedCount: number;
    stopped: boolean;
    stopUnconfirmed: boolean;
    agentKind?: AgentKind;
  },
): Promise<void> {
  const { cwd, messageId, ctx, removedCount, stopped, stopUnconfirmed, agentKind } = opts;
  const targetStillQueued = host.bridge.getQueuedTask(cwd, messageId) !== undefined;
  if (!targetStillQueued) {
    // 目标在途接跑：已经在执行，说「无需重复操作」；真的被撤销了才说「未安排执行」。
    if (host.bridge.hasTaskBegan(messageId)) {
      await host.bridge.sendResult(
        { text: `ℹ️ 目标消息已开始执行，无需重复操作。已清除 ${removedCount} 条排队消息。` },
        ctx,
      );
    } else {
      await host.bridge.sendResult(
        {
          text: `⚠️ 目标消息已不在队列中（可能已被撤销），未安排执行。已清除 ${removedCount} 条排队消息。`,
        },
        ctx,
      );
    }
    return;
  }
  if (stopUnconfirmed) {
    const name = agentKind ? agentDisplayName(agentKind) : 'agent';
    await host.bridge.sendResult(
      {
        text:
          `⚠️ 未能确认 ${name} 的 turn 已停止，它可能仍在后台运行。\n` +
          `已清除 ${removedCount} 条排队消息；您的消息已提交，但可能要等该 turn 结束后才开始。`,
      },
      ctx,
    );
    return;
  }
  if (!host.bridge.isBusyFor(cwd)) {
    // Normal path: nothing new began during the stop, the target is next.
    // Mark its own card as executing now so buttons grey out immediately.
    // Done BEFORE any removal so getQueuedTask still returns the task with
    // its (possibly edited) messagePreview for the card. The queue callback's
    // later updateQueueCardToExecuting call becomes a no-op (idempotent).
    await host.bridge.markQueueCardExecuting(cwd, messageId);
    const stopPrefix = stopped ? '⚡ 已停止当前任务，' : '';
    await host.bridge.sendResult(
      { text: `${stopPrefix}清除了 ${removedCount} 条排队消息。您的消息将立即执行。` },
      ctx,
    );
    return;
  }
  await host.bridge.sendResult(
    {
      text: `⚠️ 排在目标之前的任务已开始执行，目标消息保持排队。已清除 ${removedCount} 条排队消息。`,
    },
    ctx,
  );
}

/**
 * Handle queue.diagnose: show diagnostic info for why message is queuing.
 */
export async function handleQueueDiagnose(
  host: CommandRouter,
  value: { cwd?: string; messageId?: string; userId?: string; chatId?: string },
  ctx: CommandContext,
): Promise<void> {
  const payload = await host.queuePayloadOrReply(value, ctx);
  if (!payload) return;
  const { cwd, messageId } = payload;
  const targetUserId = value.userId ?? ctx.userId;

  const task = host.bridge.getQueuedTask(cwd, messageId);
  const queueInfo = host.bridge.getQueueInfo(cwd);
  const activeRuns = host.bridge.getAllActiveRuns();
  // 「排在当前任务之前」按诊断目标自己的位置算（与 sendQueueStatusCard 同法）。
  // getQueueInfo.tasksAhead 是队尾视角（len-1），诊断目标不是队尾时数字误导。
  const queuedTasks = host.bridge.getQueuedTasks(cwd);
  const targetIdx = queuedTasks.findIndex((t) => t.messageId === messageId);
  const tasksAhead = targetIdx >= 0 ? targetIdx : queueInfo.tasksAhead;

  // Build diagnostic info
  const now = new Date().toLocaleString('zh-CN');
  const pid = process.pid;
  const sessionId = host.sessionStore.getSessionId(targetUserId, host.config.defaultAgent);

  // Format active runs info
  let activeRunsInfo = '无';
  if (activeRuns.size > 0) {
    const runInfos: string[] = [];
    for (const [cwd, run] of activeRuns) {
      runInfos.push(`- 📂 ${cwd}\n  runId: ${run.runId.slice(0, 8)}...\n  userId: ${run.userId}`);
    }
    activeRunsInfo = runInfos.join('\n');
  }

  const diagnosticCard = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '🔧 队列诊断报告' },
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**时间**: ${now}\n**进程 PID**: ${pid}` },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**消息信息**\n- 工作目录: \`${cwd}\`\n- 会话 ID: \`${sessionId ?? '(none)'}\`\n- 消息预览: ${task?.messagePreview ?? '(unknown)'}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**队列状态**\n- 排队的任务数: ${queueInfo.position}\n- 当前正在运行: ${queueInfo.isRunning ? '✅ 是' : '❌ 否'}\n- 排在当前任务之前的消息数: ${tasksAhead}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**活跃运行**\n${activeRunsInfo}` },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**队列判断**\n${
              queueInfo.isRunning
                ? `当前有 run 在消费队列，该消息前面还有 ${tasksAhead} 个任务。`
                : '当前没有活跃的 run 在消费队列（队列停滞）。'
            }`,
          },
        },
      ],
    },
  };

  await host.bridge.sendResult({ card: diagnosticCard }, ctx);
}

/**
 * Handle queue.edit: show input field for editing the queued message.
 */
export async function handleQueueEdit(
  host: CommandRouter,
  value: { cwd?: string; messageId?: string },
  ctx: CommandContext,
): Promise<void> {
  const payload = await host.queuePayloadOrReply(value, ctx);
  if (!payload) return;
  const { cwd, messageId } = payload;

  // Get current message preview
  const task = host.bridge.getQueuedTask(cwd, messageId);
  if (!task) {
    await host.bridge.sendResult({ text: '⚠️ 该消息不在队列中（可能已开始执行）' }, ctx);
    return;
  }

  // Build edit card
  // CardKit 2.0 input 提交（回车/完成键）时输入值走 raw.action.input_value
  // （SDK normalizer 丢弃，需 connector includeRawEvent: true + index.ts 从 raw 提取）。
  // 用 column_set + input + behaviors，不用 form 容器（form 触发 300123 无 submit button /
  // 200621 嵌套 column，submit-typed button 也被 CardKit 2.0 拒绝 HTTP 400）。
  const editCard = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '✏️ 编辑排队消息' },
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**当前消息:**\n\`${task.messagePreview}\`` },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '💡 输入新内容后按回车提交' },
        },
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 3,
              elements: [
                {
                  tag: 'input',
                  name: 'newMessage',
                  placeholder: { tag: 'plain_text', content: '输入新的消息内容...' },
                  default_value: task.messagePreview,
                  behaviors: [{ type: 'callback', value: { cmd: 'queue.input', cwd, messageId } }],
                },
              ],
            },
          ],
        },
      ],
    },
  };

  // 原地更新原排队卡片，而不是发送新卡片
  await host.bridge.updateCardInPlace(editCard, ctx);
}

/**
 * Handle queue.input: update the queued message with new content.
 * Returns a CardActionResponse carrying both a toast (immediate feedback,
 * no separate message sent) and a `card` field so Feishu renders the
 * updated queue card in place, closing the edit form. A toast-only response
 * leaves the card stuck in the edit state (Feishu keeps the pre-click card
 * when the callback response has no `card` field).
 */
export async function handleQueueInput(
  host: CommandRouter,
  value: {
    cwd?: string;
    messageId?: string;
    inputValue?: string;
    formValue?: Record<string, unknown>;
  },
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const newMessage = value.inputValue ?? (value.formValue?.['newMessage'] as string | undefined);
  const payload = await host.queuePayloadOrReply(value, ctx);
  if (!payload) return;
  const { cwd, messageId } = payload;

  if (!newMessage) {
    await host.bridge.sendResult({ text: '⚠️ 缺少新消息内容' }, ctx);
    return;
  }

  // RACE FIX: register the replacement closure BEFORE any await. The old
  // code awaited updateMessagePreview first, yielding to the microtask
  // queue. Between that yield and the later setTaskReplacement call, the
  // queue chain could advance: the task's begin path would find no
  // replacement → the original stale closure would run → the user saw
  // "消息已更新" but the agent executed the old prompt.
  //
  // By registering synchronously first, the begin path always finds the
  // replacement if the task starts during the subsequent await. Both
  // setTaskReplacement and the begin-path consumption are synchronous, so
  // there is no interleaving window.
  const inputTask = host.bridge.getQueuedTask(cwd, messageId);
  if (!inputTask) {
    // Task already left the queue (began or was cancelled) before we could
    // register the replacement. Return a toast so the edit-form card gets
    // dismissed — sendResult alone leaves the card stuck in the edit state
    // (Feishu keeps the pre-click card when the callback response has no
    // toast/card field).
    return { toast: { type: 'info', content: '任务已不在队列中（可能已开始执行或被撤销）' } };
  }
  host.registerEditedReplacement(cwd, messageId, newMessage, inputTask.binding, ctx);

  // Update the message preview (and editedMessage so handleQueueImmediate
  // re-enqueues the edited content instead of the stale original closure),
  // and build the updated queue card. Returning the card in the callback
  // response makes Feishu render it in place -- a toast-only response leaves
  // the card stuck in the edit state (Feishu keeps the pre-click card when
  // the callback response has no `card` field).
  //
  // After the synchronous replacement registration above, it is safe to
  // await here: even if the queue chain advances and the replacement is
  // consumed, the user-facing card update is best-effort (the executing card
  // is updated by updateQueueCardToExecuting instead).
  const card = await host.bridge.updateMessagePreview(cwd, messageId, newMessage);
  if (!card) {
    // Task left the queue during the await (began or cancelled). The
    // replacement was already consumed (begin path) or cleaned up
    // (cancel/removeFromQueue path). Inform the user the edit didn't stick
    // as a *card update*, but the replacement closure was already in effect.
    if (host.bridge.hasTaskBegan(messageId)) {
      return {
        toast: { type: 'success', content: '消息已更新（任务已开始执行）' },
      };
    }
    return {
      toast: { type: 'info', content: '任务已不在队列中，编辑未生效' },
    };
  }
  return {
    toast: { type: 'success', content: '消息已更新' },
    card: { type: 'raw', data: card },
  };
}

/**
 * 铸造一个排队条目身份 key（唯一铸造点）。
 *
 * 调用方：order.exec 文本钩子（resolveOrderExecForQueue）与入口层
 * （index.ts）的非即时卡片动作入队。卡片 messageId 只能当「回复目标」
 * （`taskMeta.feishuReplyTo`），不得当队列 key —— 理由见
 * `queueTaskKeyCounter` 字段注释。
 */
export function mintQueueTaskKey(host: CommandRouter, kind: string, id?: string): string {
  host.queueTaskKeyCounter += 1;
  return id === undefined
    ? `queue-${kind}-${host.queueTaskKeyCounter}`
    : `${kind}-${id}-${host.queueTaskKeyCounter}`;
}
