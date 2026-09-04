/**
 * Shared helper functions for the ACP protocol layer.
 *
 * Extracted from runner.ts and translator.ts to avoid duplication (G5).
 * Shape source: approval.ts:28-29 — optionId is opaque, echo back as-is.
 */

import type { PermissionOption } from './protocol-types.js';

/**
 * Find an option by matching its `kind` against a list of candidate values,
 * and return the `optionId` to echo back in the approval response.
 * ACP option kind values vary between kimi versions; this handles both
 * the documented names and the observed real names (§2.3).
 */
export function findOptionIdByKind(
  options: PermissionOption[],
  candidateKinds: string[],
): string | undefined {
  for (const kind of candidateKinds) {
    const found = options.find((opt) => opt.kind === kind);
    if (found) return found.optionId;
  }
  return undefined;
}

/** 各 ACP 服务端的 option kind 候选表（kimi/opencode 观测名不同，语义对齐）。 */
export interface AcpApprovalKinds {
  accept: string[];
  acceptForSession: string[];
  decline: string[];
}

/** kimi 观测 kind（approval.ts:28-29 + 2026-08-15 live：approve_once/approve_always/reject）。 */
export const KIMI_APPROVAL_KINDS: AcpApprovalKinds = {
  accept: ['approve_once', 'approve_always', 'allow_once'],
  acceptForSession: ['approve_always', 'allow_always'],
  decline: ['reject', 'reject_once'],
};

/** opencode kind（permission.ts:219-223：once/always → approve，其余 → reject）。 */
export const OPENCODE_APPROVAL_KINDS: AcpApprovalKinds = {
  accept: ['allow_once', 'allow_always'],
  acceptForSession: ['allow_always', 'approve_always'],
  decline: ['reject_once', 'reject'],
};

/**
 * 把 bridge 审批动作（accept/accept_for_session/decline/cancel）映射为 ACP
 * request_permission 响应：按 kind 候选表查 optionId 回显；找不到一律
 * cancelled（安全兜底——服务端视为拒绝，不会悬挂）。
 */
export function buildAcpPermissionOutcome(
  action: string,
  options: PermissionOption[],
  kinds: AcpApprovalKinds,
): { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } } {
  if (action === 'cancel') {
    return { outcome: { outcome: 'cancelled' } };
  }
  const candidates =
    action === 'accept'
      ? kinds.accept
      : action === 'accept_for_session'
        ? kinds.acceptForSession
        : kinds.decline;
  const optionId = findOptionIdByKind(options, candidates);
  return optionId
    ? { outcome: { outcome: 'selected', optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/**
 * 从服务端 options kind 派生审批决定列表：accept/decline/cancel 恒有；
 * 带 always 类 option（kimi approve_always / opencode allow_always）才提供
 * acceptForSession（§P4「本会话总是允许」）。kimi/opencode 两侧共用。
 */
export function deriveAcpAvailableDecisions(options: PermissionOption[]): string[] {
  const decisions: string[] = ['accept', 'decline', 'cancel'];
  const hasAlwaysOption = options.some(
    (opt) => opt.kind === 'allow_always' || opt.kind === 'approve_always',
  );
  if (hasAlwaysOption) {
    decisions.push('acceptForSession');
  }
  return decisions;
}

/** 截断长文本并追加省略号（translator 审批 reason 用，原先两份相同拷贝）。 */
export function truncateWithEllipsis(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}
