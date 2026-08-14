/**
 * ApprovalCoordinator: tracks and manages approval requests for a single run.
 *
 * Handles the lifecycle of command/file/permissions approval requests:
 * - onRequested: add to tracking, arm timeout timer
 * - onResolved: update state, clear timer
 * - submit: validate → atomic state transition → async respond
 * - togglePerm: flip permission item selection
 * - onTurnEnded / onConnectionLost: mark all as expired
 */

import type { ApprovalRequestedEvent, ApprovalView, AgentEvent } from '../runner/types.js';
import { getLogger } from '../logger/index.js';

// =============================================================================
// Types
// =============================================================================

export type ApprovalState = 'pending' | 'submitting' | 'resolved' | 'failed' | 'expired';

export interface TrackedApproval {
  requestId: number | string;
  kind: 'command' | 'file' | 'permissions';
  state: ApprovalState;
  view: ApprovalView;
  createdAt: number;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

export type ApprovalResponder = (requestId: number | string, response: unknown) => Promise<void>;

export type ApprovalAction =
  | { action: 'accept' }
  | { action: 'accept_for_session' }
  | { action: 'accept_with_execpolicy_amendment' }
  | { action: 'decline' }
  | { action: 'cancel' };

export interface ApprovalToggleAction {
  permId: string;
  selected: boolean;
}

// =============================================================================
// Coordinator
// =============================================================================

export class ApprovalCoordinator {
  private approvals = new Map<number | string, TrackedApproval>();
  /** 已提交过的 nonce（按 requestId）：同一按钮连点/飞书重投递只生效一次。 */
  private submittedNonces = new Map<number | string, Set<string>>();
  private readonly runId: string;
  private readonly userId: string;
  private readonly chatId: string;
  private readonly workspace: string;
  private readonly approvalTimeoutMs: number;
  private readonly responder: ApprovalResponder;
  private readonly interruptTurn: () => Promise<void>;
  private readonly pushToCard: (events: AgentEvent[]) => Promise<void>;

  constructor(opts: {
    runId: string;
    userId: string;
    chatId: string;
    workspace: string;
    approvalTimeoutMs: number;
    responder: ApprovalResponder;
    interruptTurn: () => Promise<void>;
    pushToCard: (events: AgentEvent[]) => Promise<void>;
  }) {
    this.runId = opts.runId;
    this.userId = opts.userId;
    this.chatId = opts.chatId;
    this.workspace = opts.workspace;
    this.approvalTimeoutMs = opts.approvalTimeoutMs;
    this.responder = opts.responder;
    this.interruptTurn = opts.interruptTurn;
    this.pushToCard = opts.pushToCard;
  }

  /**
   * Handle an approval_requested event.
   */
  onRequested(event: ApprovalRequestedEvent): void {
    const existing = this.approvals.get(event.requestId);
    if (existing) {
      // Already tracked — update state
      existing.state = 'pending';
      existing.view = event.view;
      return;
    }

    const timer = setTimeout(() => {
      this.expireApproval(event.requestId);
    }, this.approvalTimeoutMs);

    const tracked: TrackedApproval = {
      requestId: event.requestId,
      kind: event.kind,
      state: 'pending',
      view: event.view,
      createdAt: Date.now(),
      timeoutTimer: timer,
    };

    this.approvals.set(event.requestId, tracked);
  }

  /**
   * Handle an approval_resolved event.
   */
  onResolved(requestId: number | string): void {
    const tracked = this.approvals.get(requestId);
    if (!tracked) return;

    tracked.state = 'resolved';
    this.clearTimer(tracked);
  }

  /**
   * Handle turn ended — mark all pending approvals as expired.
   */
  onTurnEnded(): void {
    for (const [, tracked] of this.approvals) {
      if (tracked.state === 'pending') {
        tracked.state = 'expired';
        this.clearTimer(tracked);
      }
    }
  }

  /**
   * Handle connection lost — same as onTurnEnded.
   */
  onConnectionLost(): void {
    this.onTurnEnded();
  }

  /**
   * Submit an approval decision.
   * Returns a promise that resolves when the response is sent.
   */
  async submit(
    action: ApprovalAction,
    ctx: { requestId: number | string; nonce?: string },
  ): Promise<string> {
    const tracked = this.approvals.get(ctx.requestId);
    if (!tracked) {
      throw new Error(`Approval request ${ctx.requestId} not found`);
    }
    // nonce 去重：同一张卡片渲染出的按钮连续点击（或飞书重投递）携带相同
    // nonce，只允许生效一次；不同渲染的按钮 nonce 不同，状态机（pending →
    // submitting）仍然兜底防二次提交。
    if (ctx.nonce !== undefined) {
      const seen = this.submittedNonces.get(ctx.requestId) ?? new Set<string>();
      if (seen.has(ctx.nonce)) {
        throw new Error(`Approval request ${ctx.requestId} already submitted (duplicate nonce)`);
      }
      seen.add(ctx.nonce);
      this.submittedNonces.set(ctx.requestId, seen);
    }
    if (tracked.state !== 'pending') {
      throw new Error(
        `Approval request ${ctx.requestId} is no longer pending (state=${tracked.state})`,
      );
    }

    // Validate action against available decisions. decline/cancel are always
    // allowed as a safety override: denying/interrupting is a universal human
    // affordance even when the server's list omits them (observed in practice).
    const decision = this.actionToDecision(action);
    const safetyOverride = decision === 'decline' || decision === 'cancel';
    if (!tracked.view.availableDecisions.includes(decision) && !safetyOverride) {
      throw new Error(
        `Decision "${decision}" not in available decisions: ${tracked.view.availableDecisions.join(', ')}`,
      );
    }

    // Atomic state transition: pending → submitting（同步，无 await）
    tracked.state = 'submitting';
    this.clearTimer(tracked);

    // Send response via the responder
    try {
      await this.responder(ctx.requestId, action);
      tracked.state = 'resolved';
    } catch {
      tracked.state = 'failed';
    }

    return `Approval ${tracked.requestId} (${tracked.kind}): ${decision}`;
  }

  /**
   * Toggle a permission item's selected state.
   */
  async togglePerm(
    action: ApprovalToggleAction,
    ctx: { requestId: number | string },
  ): Promise<string> {
    const tracked = this.approvals.get(ctx.requestId);
    if (!tracked) {
      throw new Error(`Approval request ${ctx.requestId} not found`);
    }
    if (tracked.kind !== 'permissions') {
      throw new Error(`Approval request ${ctx.requestId} is not a permissions request`);
    }
    if (tracked.state !== 'pending') {
      throw new Error(`Approval request ${ctx.requestId} is no longer pending`);
    }

    const items = tracked.view.permissions?.items;
    if (!items) {
      throw new Error(`Approval request ${ctx.requestId} has no permissions items`);
    }

    const item = items.find((i) => i.id === action.permId);
    if (!item) {
      throw new Error(`Permission item ${action.permId} not found in request ${ctx.requestId}`);
    }

    item.selected = action.selected;
    return `Permission ${action.permId}: ${action.selected ? 'granted' : 'denied'}`;
  }

  /**
   * Update a pending approval's view (out-of-order item/started arrives late).
   * Only applies while the approval is still pending — resolved/expired
   * approvals must not be resurrected or rewritten.
   */
  updateView(requestId: number | string, view: ApprovalView): void {
    const tracked = this.approvals.get(requestId);
    if (!tracked || tracked.state !== 'pending') return;
    tracked.view = view;
  }

  /**
   * Get the number of pending approvals.
   */
  pendingCount(): number {
    let count = 0;
    for (const [, tracked] of this.approvals) {
      if (tracked.state === 'pending') count++;
    }
    return count;
  }

  /**
   * Get the head (oldest pending) approval, or undefined.
   */
  head(): TrackedApproval | undefined {
    let oldest: TrackedApproval | undefined;
    let oldestTime = Infinity;
    for (const [, tracked] of this.approvals) {
      if (tracked.state === 'pending' && tracked.createdAt < oldestTime) {
        oldest = tracked;
        oldestTime = tracked.createdAt;
      }
    }
    return oldest;
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private clearTimer(tracked: TrackedApproval): void {
    if (tracked.timeoutTimer !== null) {
      clearTimeout(tracked.timeoutTimer);
      tracked.timeoutTimer = null;
    }
  }

  private expireApproval(requestId: number | string): void {
    const tracked = this.approvals.get(requestId);
    if (!tracked || tracked.state !== 'pending') return;
    tracked.state = 'expired';
    this.clearTimer(tracked);
    // 闭环：审批过期时向 server 发送 cancel（真实协议决策空间中的「停止等待」语义），
    // 避免 server 无限等待审批响应。decline 仅是本桥 UI 安全兜底，不在真实协议内。
    // 此前只改本地状态，server 只能等 runner 的 turn 超时兜底（用户「点了允许还超时」）。
    void this.responder(requestId, { action: 'cancel' }).catch((err: unknown) => {
      getLogger().warn(
        `[approval-coordinator] expiry cancel failed requestId=${requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // 响应失败不是「正常过期」：状态升级为 failed，避免误判为已正常通知
      // server（spec R1：responder 抛错时状态置 failed）。
      tracked.state = 'failed';
      // 兜底：cancel 未能送达时主动中断 turn，避免 server 无限等待审批响应。
      void this.interruptTurn().catch((interruptErr: unknown) => {
        getLogger().warn(
          `[approval-coordinator] expiry interrupt failed requestId=${requestId}: ${
            interruptErr instanceof Error ? interruptErr.message : String(interruptErr)
          }`,
        );
      });
    });
    // 通知卡片进入过期态（run-renderer 渲染「⏰ 审批已过期」并隐藏按钮）。
    void this.pushToCard([{ type: 'approval_expired', requestId }]).catch((err: unknown) => {
      getLogger().warn(
        `[approval-coordinator] expiry card event failed requestId=${requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  private actionToDecision(action: ApprovalAction): string {
    switch (action.action) {
      case 'accept':
        return 'accept';
      case 'accept_for_session':
        return 'acceptForSession';
      case 'accept_with_execpolicy_amendment':
        return 'acceptWithExecpolicyAmendment';
      case 'decline':
        return 'decline';
      case 'cancel':
        return 'cancel';
    }
  }
}

/** Map a card decision string to the ApprovalAction used across the bridge. */
export function decisionToApprovalAction(decision: string): ApprovalAction {
  switch (decision) {
    case 'accept':
      return { action: 'accept' };
    case 'acceptForSession':
      return { action: 'accept_for_session' };
    case 'acceptWithExecpolicyAmendment':
      return { action: 'accept_with_execpolicy_amendment' };
    case 'decline':
      return { action: 'decline' };
    case 'cancel':
      return { action: 'cancel' };
    default:
      return { action: 'decline' };
  }
}
