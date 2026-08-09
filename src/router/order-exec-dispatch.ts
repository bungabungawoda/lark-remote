import type { CommandRouter } from './index.js';
import type { Bridge } from '../bridge/index.js';

/** Context shared by all card-action dispatch paths (file-local; callers pass it structurally). */
interface DispatchContext {
  userId: string;
  chatId: string;
  messageId: string;
}

/**
 * Dispatch an `order.exec` card action as an equivalent queued user message
 * (Plan A): resolve the order text at the enqueue boundary, then enqueue it
 * through `router.handle(orderText)` — the same path a hand-typed message
 * takes. The real text flows as the queue `messagePreview` (→ queue card
 * display + edit default_value) and as the forwarded content; a unique
 * internal key is used as the queue dedup key instead of the Feishu card
 * messageId (one order card is clickable N times, so the card messageId is
 * 1:N with enqueue actions and must not be reused).
 *
 * Extracted from `src/index.ts` so the enqueue-time contract is unit-testable
 * without wiring up the full `main()` graph. Returns a short status string
 * for the caller to log; performs its own error feedback via `bridge.sendResult`.
 */
export async function dispatchOrderExecForQueue(args: {
  router: CommandRouter;
  bridge: Bridge;
  workspace: string;
  orderId: string | undefined;
  ctx: DispatchContext;
}): Promise<'enqueued' | 'missing-id' | 'not-found'> {
  const { router, bridge, workspace, orderId, ctx } = args;

  if (!orderId) {
    await bridge.sendResult({ text: '卡片 payload 缺少必要信息' }, ctx);
    return 'missing-id';
  }

  const resolved = router.resolveOrderExecForQueue(orderId);
  if (!resolved) {
    await bridge.sendResult({ text: '指令不存在或已被删除' }, ctx);
    return 'not-found';
  }

  // Step4/D4: 入队时刻（T0）快照 agent+session，随任务闭包带到 T1 执行时刻，
  // 避免排队期间 /new、/config 改写 live 状态导致语义漂移。唯一捕获点
  // Bridge.currentBinding。
  const binding = bridge.currentBinding(ctx.userId);

  bridge.enqueue(
    workspace,
    async () => {
      await router.handle(resolved.orderText, ctx, { cwdOverride: workspace, binding });
    },
    {
      taskMeta: {
        userId: ctx.userId,
        chatId: ctx.chatId,
        messageId: resolved.internalKey,
        messagePreview: resolved.orderText.slice(0, 3000),
        // The internal key is NOT a valid Feishu message id, so the queue
        // status card must reply to the real Feishu card message id instead.
        feishuReplyTo: ctx.messageId,
        // D3/Step4：binding 随 taskMeta 存进 QueuedTask，供替换闭包
        // （queue.edit/queue.immediate）复用，不重新快照。
        binding,
      },
    },
  );
  return 'enqueued';
}
