/**
 * Agent turn 失败原因的判据（卡片渲染与自动续跑共用）。
 *
 * 上游把 `finish_reason: content_filter` 归一到普通 error（DSH 侧 code 为
 * `PI_AI_ERROR`）：它既不是限流也不是故障，而是模型输出被服务方安全策略截断，
 * 多数是误报。桥接若把它混进「运行出错」，用户看到的是英文内部报文、不知道
 * 该做什么；桥侧也就无从判断该不该自动续跑。
 *
 * 判据只留一处：渲染层（换文案）与桥接层（自动续跑一次）必须同一个口径，
 * 否则改文案和改重试语义会各自漂移。
 */

/** 服务方内容审核截断的报文特征：`Provider finish_reason: content_filter`。 */
const CONTENT_FILTER_RE = /finish_reason:\s*["']?content_filter\b/i;

/** 该 errorMsg 是否表示「模型输出被上游内容审核截断」。 */
export function isContentFilterFailure(errorMsg: string | undefined): boolean {
  return typeof errorMsg === 'string' && CONTENT_FILTER_RE.test(errorMsg);
}
