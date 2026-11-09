export class DshError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DshError';
    this.code = code;
    this.details = details;
  }
}

/**
 * DSH 启动期的可重试失败：端点已经存在，但它的 service/context 还在激活
 * （0.2.2 的 HTTP 层先于异步 Service.init 就绪），或宿主启动期的传输/5xx
 * 失败。
 *
 * gateway code 只认 `service-unavailable` / `context-unavailable`，不认
 * `gateway/invocation-unavailable` / `definition-unavailable`：后者可能
 * 意味着旧宿主根本不提供该端点。调用方拿到未知错误必须放行，不能让就绪
 * 探测把旧宿主挡在门外。
 */
export function isDshTransientAvailabilityError(error: unknown): error is DshError {
  if (!(error instanceof DshError)) return false;
  // A startup probe can hit the per-attempt timeout before the host answers;
  // the retry loop still enforces the overall readiness/alignment deadline.
  if (error.code === 'transport' || error.code === 'timeout') return true;
  if (error.code === 'gateway/service-unavailable') return true;
  if (error.code === 'gateway/context-unavailable') return true;
  if (
    error.code === 'http' &&
    (error.details.status === 502 || error.details.status === 503 || error.details.status === 504)
  ) {
    return true;
  }
  return false;
}
