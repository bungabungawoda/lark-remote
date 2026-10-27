/**
 * 审批卡动作分发（Bridge 的终态卡动作侧，审计 #32 的一刀）。
 *
 * 每个方法只做一件事：按 runId 找到那次 run 的 `ApprovalCoordinator`，把卡片
 * payload 翻成一次 coordinator 调用。原先这 7 个 handler 连同「找不到
 * coordinator 怎么回答」的公共前缀平铺在 Bridge 里，占了 160 行却不碰任何
 * Bridge 状态——只碰 `approvalCoordinators` 这一张表。
 *
 * 语义红线（保留原位，别在调用方重新实现）：
 * - run 已结束（coordinator 已释放）时点审批按钮必须给用户明确反馈，不能静默；
 *   router 把这个异常转成 error toast。
 * - `nonce` 原样透传给 coordinator：飞书会重投递同一个按钮回调，去重靠它
 *   （见 approval-coordinator.ts 的状态机注释）。
 */

import { getLogger } from '../logger/index.js';
import { decisionToApprovalAction } from './approval-coordinator.js';
import type {
  ApprovalAction,
  ApprovalCoordinator,
  ApprovalToggleAction,
} from './approval-coordinator.js';

export interface ApprovalActionDeps {
  /** 按 runId 取该 run 的 coordinator；已结束返回 undefined。 */
  coordinatorFor(runId: string): ApprovalCoordinator | undefined;
}

/** 所有 handler 共用的入参形状。 */
interface RunScopedOpts {
  runId: string;
  requestId: number | string;
}

export class ApprovalActions {
  constructor(private deps: ApprovalActionDeps) {}

  /**
   * Resolve the ApprovalCoordinator for a run, or throw the standard
   * "已结束" error. Shared preamble of all approval card-action handlers.
   */
  private withCoordinator<T>(
    runId: string,
    fn: (coordinator: ApprovalCoordinator) => Promise<T>,
  ): Promise<T> {
    const coordinator = this.deps.coordinatorFor(runId);
    if (!coordinator) {
      getLogger().warn(`[lark-remote] no approval coordinator for runId=${runId.slice(0, 8)}`);
      throw new Error('任务已结束，审批无法响应');
    }
    return fn(coordinator);
  }

  private dispatchQuestionAction(
    opts: RunScopedOpts & { questionIndex: number },
    action: string,
    invoke: (coordinator: ApprovalCoordinator) => Promise<void>,
  ): Promise<void> {
    getLogger().info(
      `[lark-remote] ${action} runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} question=${opts.questionIndex}`,
    );
    return this.withCoordinator(opts.runId, invoke);
  }

  /**
   * Handle an approval response from a card button click.
   * Routes to the ApprovalCoordinator for the given run.
   */
  async handleApprovalRespond(
    opts: RunScopedOpts & {
      decision: string;
      nonce: string;
    },
  ): Promise<void> {
    getLogger().info(
      `[lark-remote] handleApprovalRespond runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} decision=${opts.decision}`,
    );
    return this.withCoordinator(opts.runId, async (coordinator) => {
      // Build ApprovalAction from the decision string
      const action: ApprovalAction = decisionToApprovalAction(opts.decision);
      await coordinator.submit(action, { requestId: opts.requestId, nonce: opts.nonce });
    });
  }

  /**
   * 计划审批修改意见（ExitPlanMode 输入框）：记录到 coordinator 并回流卡片。
   * 「拒绝并附意见」/「批准并采纳修改」按钮复用该文本。
   */
  async handleApprovalPlanFeedback(
    opts: RunScopedOpts & {
      text: string;
      nonce: string;
    },
  ): Promise<void> {
    return this.withCoordinator(opts.runId, async (coordinator) => {
      await coordinator.planFeedback(
        { text: opts.text },
        { requestId: opts.requestId, nonce: opts.nonce },
      );
    });
  }

  /**
   * Handle a permission toggle from a card button click.
   * Routes to the ApprovalCoordinator for the given run.
   */
  async handleApprovalToggle(
    opts: RunScopedOpts & {
      permId: string;
      selected?: boolean;
    },
  ): Promise<void> {
    getLogger().info(
      `[lark-remote] handleApprovalToggle runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} permId=${opts.permId}`,
    );

    return this.withCoordinator(opts.runId, async (coordinator) => {
      // selected 由卡片根据当前渲染状态传回（取反），不再硬编码只授不撤。
      const toggleAction: ApprovalToggleAction = {
        permId: opts.permId,
        selected: opts.selected ?? true,
      };
      await coordinator.togglePerm(toggleAction, { requestId: opts.requestId });
    });
  }

  /**
   * Claude AskUserQuestion 选项点击（单选即时提交 / 多选切换勾选）。
   * 路由到 ApprovalCoordinator.toggleAnswer。
   */
  async handleApprovalAnswer(
    opts: RunScopedOpts & {
      questionIndex: number;
      option: string;
      nonce: string;
    },
  ): Promise<void> {
    return this.dispatchQuestionAction(opts, 'handleApprovalAnswer', (coordinator) =>
      coordinator.toggleAnswer(
        { questionIndex: opts.questionIndex, option: opts.option },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }

  /**
   * Claude AskUserQuestion 多选问题的「提交答案」按钮。
   * 路由到 ApprovalCoordinator.submitAnswers。
   */
  async handleApprovalAnswerSubmit(
    opts: RunScopedOpts & {
      questionIndex: number;
      nonce: string;
    },
  ): Promise<void> {
    return this.dispatchQuestionAction(opts, 'handleApprovalAnswerSubmit', (coordinator) =>
      coordinator.submitAnswers(
        { questionIndex: opts.questionIndex },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }

  /**
   * Claude AskUserQuestion 自定义答案（Other）：自由文本直接
   * 作为该单选问题的答案提交。路由到 ApprovalCoordinator.answerCustom。
   */
  async handleApprovalAnswerCustom(
    opts: RunScopedOpts & {
      questionIndex: number;
      text: string;
      nonce: string;
    },
  ): Promise<void> {
    return this.dispatchQuestionAction(opts, 'handleApprovalAnswerCustom', (coordinator) =>
      coordinator.answerCustom(
        { questionIndex: opts.questionIndex, text: opts.text },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }

  /**
   * Codex AskUserQuestion 补充说明（user_note，2026-08-18 live 验证模型理解
   * "user_note: <text>" 条目）：记录到 coordinator，随答案一起提交。
   * 路由到 ApprovalCoordinator.answerNote。
   */
  async handleApprovalAnswerNote(
    opts: RunScopedOpts & {
      questionIndex: number;
      text: string;
      nonce: string;
    },
  ): Promise<void> {
    return this.dispatchQuestionAction(opts, 'handleApprovalAnswerNote', (coordinator) =>
      coordinator.answerNote(
        { questionIndex: opts.questionIndex, text: opts.text },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }
}
