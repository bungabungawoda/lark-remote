/**
 * 进程级未捕获 rejection 的分类。
 *
 * 飞书 SDK @larksuite/channel 的流式卡片 patch 走 throttle + setTimeout 异步触发，
 * patchCard 失败时 rejection 是一条脱离调用方 await 链的 detached Promise ——
 * `RunCardSession.update()` 的 try-catch 只包住 `controller.update()` 返回的 Promise，
 * 而后者在调完 `throttle.note()` 后立即 resolve，不等真正的 patch，所以挡不住
 * 延迟 fire 的 patch rejection。该 rejection 最终冒泡到 `process.unhandledRejection`。
 *
 * 该分类决定 detach 逃逸的 patch rejection 是「尽力而为的展示层失败」
 * （recoverable，记日志不 exit）还是「进程状态损坏」（fatal，exit）。
 */
type RejectionVerdict = 'recoverable' | 'fatal';

export function classifyRejection(reason: unknown): RejectionVerdict {
  // Guard against null/undefined/primitive reasons: the `as` cast below is
  // TS-only (erased at runtime), so `null.response` would throw a TypeError
  // synchronously inside the unhandledRejection callback — Node then re-emits
  // it as uncaughtException, causing a misleading fatal exit and losing the
  // original rejection.
  if (reason == null || typeof reason !== 'object') return 'fatal';
  const err = reason as {
    response?: { status?: number; data?: { code?: number } };
    code?: string;
  };
  const status = err.response?.status;
  if (status !== undefined && status >= 500 && status < 600) return 'recoverable';
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') return 'recoverable';
  // 飞书 API 业务错误（如 230027 外部会话无权限）—— 经 SDK throttle detach 路径逃逸的
  // patch rejection。流式卡片是尽力而为的展示层，飞书侧业务拒绝不应击穿进程。
  // 识别条件：4xx + 带飞书业务 code（区别于请求构造错误的纯 400）。
  const feishuCode = err.response?.data?.code;
  if (status !== undefined && status >= 400 && status < 500 && typeof feishuCode === 'number') {
    return 'recoverable';
  }
  return 'fatal';
}
