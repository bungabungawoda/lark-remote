/**
 * ApprovalCoordinator: tracks and manages approval requests for a single run.
 *
 * Handles the lifecycle of command/file/permissions approval requests:
 * - onRequested: add to tracking, arm timeout timer
 * - onResolved: update state, clear timer
 * - submit: validate → atomic state transition → async respond
 * - togglePerm: flip permission item selection
 * - onTurnEnded: mark all as expired
 */

import type { ApprovalRequestedEvent, ApprovalView, AgentEvent } from '../runner/types.js';
import type { ApprovalAction } from '../runner/types.js';
import { getLogger } from '../logger/index.js';

// =============================================================================
// Types
// =============================================================================

type ApprovalState = 'pending' | 'submitting' | 'resolved' | 'failed' | 'expired';

export interface TrackedApproval {
  requestId: number | string;
  kind: 'command' | 'file' | 'permissions' | 'question' | 'tool';
  state: ApprovalState;
  view: ApprovalView;
  createdAt: number;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  /** AskUserQuestion 已答问题索引 → 答案 label[]（kind === 'question'）。 */
  answers?: Map<number, string[]>;
  /** AskUserQuestion 补充说明（Codex user_note）：问题索引 → 文本。 */
  notes?: Map<number, string>;
  /** 计划审批修改意见（ExitPlanMode）：planFeedback 回流，供反馈类决策注入。 */
  feedback?: string;
}

type ApprovalResponder = (requestId: number | string, response: unknown) => Promise<void>;

export type { ApprovalAction } from '../runner/types.js';

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
  private readonly approvalTimeoutMs: number;
  private readonly responder: ApprovalResponder;
  private readonly interruptTurn: () => Promise<void>;
  private readonly pushToCard: (events: AgentEvent[]) => Promise<void>;

  constructor(opts: {
    approvalTimeoutMs: number;
    responder: ApprovalResponder;
    interruptTurn: () => Promise<void>;
    pushToCard: (events: AgentEvent[]) => Promise<void>;
  }) {
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

    // 事件级 timeoutMs 优先（Codex autoResolutionMs / Pi extension timeout），
    // 缺省回落 run 级默认超时。放在事件上而非桥按 agentKind 分支，公共层
    // 保持无 agent 分支。
    const timer = setTimeout(() => {
      this.expireApproval(event.requestId);
    }, event.timeoutMs ?? this.approvalTimeoutMs);

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
   * Submit an approval decision.
   */
  async submit(
    action: ApprovalAction,
    ctx: { requestId: number | string; nonce?: string },
  ): Promise<void> {
    const tracked = this.approvals.get(ctx.requestId);
    if (!tracked) {
      throw new Error(`Approval request ${ctx.requestId} not found`);
    }
    // nonce 去重：同一张卡片渲染出的按钮连续点击（或飞书重投递）携带相同
    // nonce，只允许生效一次；不同渲染的按钮 nonce 不同，状态机（pending →
    // submitting）仍然兜底防二次提交。
    this.assertFreshNonce(ctx.requestId, ctx.nonce);
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

    // 反馈类决策：注入用户已填写的修改意见（卡片输入框经 planFeedback 回流到
    // coordinator）。decisionToApprovalAction 只带决策名，payload 在此补齐；
    // 调用方直接传完整 payload 时以显式值为准。
    let effectiveAction: ApprovalAction = action;
    if (action.action === 'decline_with_feedback' || action.action === 'accept_with_feedback') {
      const explicit = action.action === 'decline_with_feedback' ? action.message : action.plan;
      const text = explicit.trim() || tracked.feedback?.trim() || '';
      if (!text) {
        throw new Error('请先填写修改意见');
      }
      effectiveAction =
        action.action === 'decline_with_feedback'
          ? { action: 'decline_with_feedback', message: text }
          : {
              action: 'accept_with_feedback',
              // 批准并采纳修改：新计划 = 原计划 + 用户意见（无原计划时意见即计划）。
              plan: tracked.view.plan?.trim()
                ? `${tracked.view.plan.trim()}\n\n## 用户修改意见\n${text}`
                : `# 用户修改意见\n\n${text}`,
            };
    }

    // Atomic state transition: pending → submitting（同步，无 await）
    tracked.state = 'submitting';
    this.clearTimer(tracked);

    // Send response via the responder
    try {
      await this.responder(ctx.requestId, effectiveAction);
      tracked.state = 'resolved';
      // 提交成功后立即从卡片移除审批区（agent 无关）：claude 控制协议没有
      // resolved 回发，不推就会「已点允许按钮仍在」残留 UI；codex 的 server
      // 稍后也会发 approval_resolved，reducer 按 requestId 过滤幂等。
      this.pushResolved(ctx.requestId);
    } catch {
      tracked.state = 'failed';
    }
  }

  /**
   * Toggle a permission item's selected state.
   */
  async togglePerm(
    action: ApprovalToggleAction,
    ctx: { requestId: number | string },
  ): Promise<void> {
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
  }

  /**
   * Claude AskUserQuestion 选项点击。
   *
   * - 单选：点击即选中该选项；全部问题答完时自动通过 responder 提交答案。
   * - 多选：切换 selected 并推 approval_view_updated 重渲染，等待
   *   submitAnswers() 显式提交。
   */
  async toggleAnswer(
    action: { questionIndex: number; option: string },
    ctx: { requestId: number | string; nonce?: string },
  ): Promise<void> {
    const tracked = this.getPendingQuestion(ctx.requestId);
    const questions = tracked.view.questions!;
    const q = questions[action.questionIndex];
    if (!q) {
      throw new Error(`Question ${action.questionIndex} not found in request ${ctx.requestId}`);
    }
    const option = q.options.find((o) => o.label === action.option);
    if (!option) {
      throw new Error(`Option "${action.option}" not found in question ${action.questionIndex}`);
    }

    const selected = new Set(q.selected ?? []);
    if (q.multiSelect) {
      // review P2-1：多选切换按钮同一 nonce 重复投递（双击/飞书重投递）只应
      // toggle 一次，否则勾选会被二次 toggle 抵消。单选用例的重复防护在
      // respondQuestionAnswers（提交即幂等，选中是 set 语义）。
      this.assertFreshNonce(ctx.requestId, ctx.nonce);
      if (selected.has(action.option)) {
        selected.delete(action.option);
      } else {
        selected.add(action.option);
      }
      q.selected = [...selected];
      this.pushQuestionViewUpdate(ctx.requestId, tracked);
      return;
    }

    // 单选：替换选择；全部问题答完立即提交，否则等待后续问题。
    q.selected = [action.option];
    this.recordAnswer(tracked, action.questionIndex, [action.option]);
    if (this.allQuestionsAnswered(tracked)) {
      return this.respondQuestionAnswers(tracked, ctx);
    }
    this.pushQuestionViewUpdate(ctx.requestId, tracked);
  }

  /**
   * Claude AskUserQuestion 多选问题的「提交答案」按钮。
   * 提交该问题当前勾选的选项；全部问题答完时通过 responder 提交。
   */
  async submitAnswers(
    action: { questionIndex: number },
    ctx: { requestId: number | string; nonce?: string },
  ): Promise<void> {
    const tracked = this.getPendingQuestion(ctx.requestId);
    const questions = tracked.view.questions!;
    const q = questions[action.questionIndex];
    if (!q) {
      throw new Error(`Question ${action.questionIndex} not found in request ${ctx.requestId}`);
    }
    if (!q.multiSelect) {
      throw new Error('该问题为单选，请直接点击选项');
    }
    const selected = q.selected ?? [];
    if (selected.length === 0) {
      throw new Error('请先选择至少一个选项');
    }
    this.recordAnswer(tracked, action.questionIndex, selected);
    if (this.allQuestionsAnswered(tracked)) {
      return this.respondQuestionAnswers(tracked, ctx);
    }
  }

  /**
   * AskUserQuestion 自定义答案（Other，review P3-4）：自由文本直接作为该
   * 单选问题的答案。与单选 toggle 同语义：全部问题答完自动提交。
   */
  async answerCustom(
    action: { questionIndex: number; text: string },
    ctx: { requestId: number | string; nonce?: string },
  ): Promise<void> {
    const tracked = this.getPendingQuestion(ctx.requestId);
    const questions = tracked.view.questions!;
    const q = questions[action.questionIndex];
    if (!q) {
      throw new Error(`Question ${action.questionIndex} not found in request ${ctx.requestId}`);
    }
    if (q.multiSelect) {
      throw new Error('自定义答案仅支持单选');
    }
    const text = action.text.trim();
    if (!text) {
      throw new Error('请输入自定义答案');
    }
    q.selected = [text];
    this.recordAnswer(tracked, action.questionIndex, [text]);
    if (this.allQuestionsAnswered(tracked)) {
      return this.respondQuestionAnswers(tracked, ctx);
    }
    this.pushQuestionViewUpdate(ctx.requestId, tracked);
  }

  /**
   * AskUserQuestion 补充说明（Codex user_note）：选项之外的可选文本，随答案
   * 提交；不单独构成答案（仍需选项/自定义答案才能完成该问题）。note 更新
   * 后回流视图（卡片回显），同一请求可多次修改（新 nonce 来自新渲染）。
   */
  async answerNote(
    action: { questionIndex: number; text: string },
    ctx: { requestId: number | string; nonce?: string },
  ): Promise<void> {
    const tracked = this.getPendingQuestion(ctx.requestId);
    const questions = tracked.view.questions!;
    const q = questions[action.questionIndex];
    if (!q) {
      throw new Error(`Question ${action.questionIndex} not found in request ${ctx.requestId}`);
    }
    const text = action.text.trim();
    if (!text) {
      throw new Error('请输入补充说明');
    }
    this.assertFreshNonce(ctx.requestId, ctx.nonce);
    tracked.notes ??= new Map();
    tracked.notes.set(action.questionIndex, text);
    q.note = text;
    this.pushQuestionViewUpdate(ctx.requestId, tracked);
  }

  /**
   * 计划审批修改意见（ExitPlanMode）：输入框提交 → coordinator 记录并回流
   * 卡片回显，随后「拒绝并附意见」/「批准并采纳修改」按钮复用该文本。
   * 同一请求可多次修改（新 nonce 来自新渲染）。
   */
  async planFeedback(
    action: { text: string },
    ctx: { requestId: number | string; nonce?: string },
  ): Promise<void> {
    const tracked = this.approvals.get(ctx.requestId);
    if (!tracked) {
      throw new Error(`Approval request ${ctx.requestId} not found`);
    }
    if (tracked.state !== 'pending') {
      throw new Error(`Approval request ${ctx.requestId} is no longer pending`);
    }
    const text = action.text.trim();
    if (!text) {
      throw new Error('请输入修改意见');
    }
    this.assertFreshNonce(ctx.requestId, ctx.nonce);
    tracked.feedback = text;
    tracked.view.planFeedback = text;
    this.pushApprovalViewUpdate(ctx.requestId, tracked);
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

  // =========================================================================
  // Internal
  // =========================================================================

  private clearTimer(tracked: TrackedApproval): void {
    if (tracked.timeoutTimer !== null) {
      clearTimeout(tracked.timeoutTimer);
      tracked.timeoutTimer = null;
    }
  }

  /** nonce 去重：同一 nonce 只允许生效一次（防连点/飞书重投递）。 */
  private assertFreshNonce(requestId: number | string, nonce?: string): void {
    if (nonce === undefined) return;
    const seen = this.submittedNonces.get(requestId) ?? new Set<string>();
    if (seen.has(nonce)) {
      throw new Error(`Approval request ${requestId} already submitted (duplicate nonce)`);
    }
    seen.add(nonce);
    this.submittedNonces.set(requestId, seen);
  }

  /** 记录问题答案到 tracked.answers（懒初始化 Map）。 */
  private recordAnswer(tracked: TrackedApproval, questionIndex: number, values: string[]): void {
    tracked.answers ??= new Map();
    tracked.answers.set(questionIndex, values);
  }

  private getPendingQuestion(requestId: number | string): TrackedApproval {
    const tracked = this.approvals.get(requestId);
    if (!tracked) {
      throw new Error(`Approval request ${requestId} not found`);
    }
    if (tracked.kind !== 'question') {
      throw new Error(`Approval request ${requestId} is not a question request`);
    }
    if (tracked.state !== 'pending') {
      throw new Error(`Approval request ${requestId} is no longer pending`);
    }
    return tracked;
  }

  private allQuestionsAnswered(tracked: TrackedApproval): boolean {
    const questions = tracked.view.questions ?? [];
    if (questions.length === 0) return false;
    for (let i = 0; i < questions.length; i++) {
      const answered = (tracked.answers?.get(i)?.length ?? 0) > 0;
      if (!answered) return false;
    }
    return true;
  }

  /** 推送审批卡视图更新（approval_view_updated 重渲染；失败仅记日志）。 */
  private pushApprovalViewUpdate(requestId: number | string, tracked: TrackedApproval): void {
    void this.pushToCard([
      {
        type: 'approval_view_updated',
        requestId,
        view: tracked.view,
        timestamp: new Date().toISOString(),
      },
    ]).catch((err: unknown) => {
      getLogger().warn(
        `[approval-coordinator] question view update failed requestId=${requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /** 推送 question 卡片视图更新（选项勾选状态变化）。 */
  private pushQuestionViewUpdate(requestId: number | string, tracked: TrackedApproval): void {
    this.pushApprovalViewUpdate(requestId, tracked);
  }

  /** 全部问题已答：构建 answers 并提交（非空校验 + 原子状态迁移）。 */
  private async respondQuestionAnswers(
    tracked: TrackedApproval,
    ctx: { requestId: number | string; nonce?: string },
  ): Promise<void> {
    this.assertFreshNonce(ctx.requestId, ctx.nonce);
    if (tracked.state !== 'pending') {
      throw new Error(
        `Approval request ${ctx.requestId} is no longer pending (state=${tracked.state})`,
      );
    }

    const questions = tracked.view.questions ?? [];
    const answers: Record<string, string | string[]> = {};
    const notes: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const selected = tracked.answers?.get(i) ?? [];
      answers[questions[i].question] = questions[i].multiSelect ? selected : selected[0];
      const note = tracked.notes?.get(i);
      if (note) notes[questions[i].question] = note;
    }

    tracked.state = 'submitting';
    this.clearTimer(tracked);
    try {
      await this.responder(ctx.requestId, {
        action: 'answer',
        answers,
        ...(Object.keys(notes).length > 0 ? { notes } : {}),
      });
      tracked.state = 'resolved';
      this.pushResolved(ctx.requestId);
    } catch {
      tracked.state = 'failed';
    }
  }

  /** 推 approval_resolved 到卡片（移除审批区；幂等，失败仅记日志）。 */
  private pushResolved(requestId: number | string): void {
    void this.pushToCard([
      {
        type: 'approval_resolved',
        requestId,
        outcome: 'resolved',
        timestamp: new Date().toISOString(),
      },
    ]).catch((err: unknown) => {
      getLogger().warn(
        `[approval-coordinator] resolved card event failed requestId=${requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
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
      case 'accept_all':
        return 'acceptAll';
      case 'answer':
        return 'answer';
      case 'decline_with_feedback':
        return 'declineWithFeedback';
      case 'accept_with_feedback':
        return 'acceptWithFeedback';
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
    case 'acceptAll':
      return { action: 'accept_all' };
    case 'declineWithFeedback':
      return { action: 'decline_with_feedback', message: '' };
    case 'acceptWithFeedback':
      return { action: 'accept_with_feedback', plan: '' };
    case 'decline':
      return { action: 'decline' };
    case 'cancel':
      return { action: 'cancel' };
    default:
      return { action: 'decline' };
  }
}
