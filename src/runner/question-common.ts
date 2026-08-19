/**
 * AskUserQuestion 公共工厂与映射（agent 无关）。
 *
 * 接入约定（types.ts UserQuestion 注释的落点）：
 * - 各 runner 用 makeQuestionApprovalEvent 构造标准 question 审批事件，
 *   避免四处手拼事件形状（claude/codex/kimi/pi 共用）；
 * - 用户答案经 ApprovalCoordinator 以 {问题文本: 值} 回传 runner 后，
 *   用 mapAnswersByIndex 按问题顺序展开，再做协议级编码
 *   （Codex 问题 id、Kimi q{i}、Pi 单题取值）。
 */

import type { ApprovalRequestedEvent, ApprovalView, UserQuestion } from './types.js';

export interface QuestionEventOptions {
  /** Per-request 审批超时覆盖（Codex autoResolutionMs）。 */
  timeoutMs?: number;
}

/**
 * 构造标准 question approval_requested 事件。
 * availableDecisions 恒为空数组：提问只能作答或跳过（decline/cancel 是
 * coordinator 的通用安全兜底），不允许 accept/decline 按钮混入提问卡。
 */
export function makeQuestionApprovalEvent(
  requestId: number | string,
  questions: UserQuestion[],
  threadId: string,
  opts?: QuestionEventOptions,
): ApprovalRequestedEvent {
  const view: ApprovalView = {
    requestId,
    kind: 'question',
    questions,
    availableDecisions: [],
  };
  return {
    type: 'approval_requested',
    requestId,
    kind: 'question',
    threadId,
    turnId: '',
    itemId: '',
    view,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    timestamp: new Date().toISOString(),
  };
}

/**
 * 按问题顺序把 coordinator 回传的 {问题文本: 值} 展开成索引对齐数组。
 * 未作答的问题对应 undefined，由各 runner 决定协议编码（跳过/空 answers）。
 */
export function mapAnswersByIndex(
  questions: UserQuestion[],
  answers: Record<string, string | string[]>,
): Array<string | string[] | undefined> {
  return questions.map((q) => answers[q.question]);
}
