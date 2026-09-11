/**
 * Shared helper functions for the ACP protocol layer.
 *
 * Extracted from runner.ts and translator.ts to avoid duplication (G5).
 * Shape source: approval.ts:28-29 — optionId is opaque, echo back as-is.
 */

import type { ApprovalView } from '../../types.js';
import { getLogger } from '../../../logger/index.js';
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

// =============================================================================
// W2.11 审批生命周期骨架（kimi/opencode ACP runner 共用）
// =============================================================================

/**
 * 待审批请求登记（requestId → 登记，runner 持 Map）。
 * kimi 的提问分叉额外带 proto 来源标记。
 */
export interface AcpPendingApproval {
  kind: 'command' | 'file' | 'permissions' | 'question' | 'tool';
  view: ApprovalView;
  options: PermissionOption[];
  /** 提问来源（kimi elicitation）：elicitation form / request_permission 兜底桥。 */
  proto?: 'elicitation' | 'permission';
}

/**
 * respondApproval 共用骨架：取 pending → 构建 ACP 响应 → respond + 清除 + 日志。
 * buildOutcome 由调用方注入（kimi question 走 elicitation 回编，其余走
 * buildAcpPermissionOutcome）。client 缺失或 requestId 未知时静默丢弃。
 */
export function respondAcpApproval(opts: {
  client: { respond(requestId: number | string, response: unknown): void } | null | undefined;
  pendingApprovals: Map<number | string, AcpPendingApproval>;
  requestId: number | string;
  response: unknown;
  logTag: string;
  buildOutcome: (action: string, pending: AcpPendingApproval, response: unknown) => unknown;
}): void {
  const pending = opts.pendingApprovals.get(opts.requestId);
  if (!opts.client || !pending) return;

  const action = (opts.response as { action?: string })?.action ?? 'decline';
  const acpResponse = opts.buildOutcome(action, pending, opts.response);
  opts.client.respond(opts.requestId, acpResponse);
  opts.pendingApprovals.delete(opts.requestId);
  getLogger().info(
    `[${opts.logTag}] approval responded requestId=${opts.requestId} action=${action}`,
  );
}

/**
 * updateApprovalMode 共用尾段：本地缓存已由调用方按各自语义更新，会话在连时
 * 重发 session/set_mode。失败非致命（下一次 setupTurn 会重新套用缓存模式）。
 */
export async function sendAcpSetMode(opts: {
  client: { request(method: string, params: unknown): Promise<unknown> } | null | undefined;
  activeSessionId: string | null | undefined;
  modeId: string;
  logTag: string;
}): Promise<void> {
  if (!opts.client || !opts.activeSessionId) return;
  try {
    await opts.client.request('session/set_mode', {
      sessionId: opts.activeSessionId,
      modeId: opts.modeId,
    });
    getLogger().info(
      `[${opts.logTag}] session/set_mode hot-applied session=${opts.activeSessionId} modeId=${opts.modeId}`,
    );
  } catch (err) {
    getLogger().warn(
      `[${opts.logTag}] session/set_mode failed (non-fatal): ${(err as Error).message}`,
    );
  }
}
