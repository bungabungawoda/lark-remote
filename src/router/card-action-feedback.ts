/**
 * 非直返 card action 的异步回执判定（入口层的出站侧）。
 *
 * `src/index.ts` 的 card action 分发只有两类出口：`DIRECT_RETURN_CMDS` 同步
 * return 给飞书回调（toast 能弹），其余走 `bridge.enqueueImmediate` /
 * `bridge.enqueue`——fire-and-forget，回调响应早已被飞书收走，handler 返回的
 * toast 无处可去。本模块给出异步出口应转发的文案：失败/告警换成一条持久文本
 * 消息（卡片只承载成功态，失败在刷新后的卡片上完全看不出来），成功类不回执
 * （逐次回执会把聊天刷成日志）。
 */

/** 只转发这两类；success/info/loading 由原地刷新的卡片表达。 */
const FORWARDABLE = new Set(['error', 'warning']);

/**
 * 从 `router.handleCardAction` 的返回值里取出应异步回给用户的文本。
 *
 * 返回 undefined = 无需回执。结构不合期望时同样返回 undefined（判定函数不得
 * 成为 fire-and-forget 任务里新的抛错源）。
 */
export function actionFeedbackText(res: unknown): string | undefined {
  const toast = (res as { toast?: { type?: unknown; content?: unknown } } | null | undefined)
    ?.toast;
  if (typeof toast !== 'object' || toast === null) return undefined;
  const { type, content } = toast as { type?: unknown; content?: unknown };
  if (typeof type !== 'string' || !FORWARDABLE.has(type)) return undefined;
  if (typeof content !== 'string') return undefined;
  return content.trim() || undefined;
}
