/**
 * Tests for ApprovalCoordinator.
 *
 * 17 tests covering: constructor, onRequested, submit valid/invalid, onResolved,
 * pendingCount, onTurnEnded, togglePerm, timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalCoordinator, decisionToApprovalAction } from './approval-coordinator.js';
import type { ApprovalRequestedEvent, ApprovalView } from '../runner/types.js';

describe('ApprovalCoordinator', () => {
  let coordinator: ApprovalCoordinator;
  let responder: ReturnType<typeof vi.fn>;
  let interruptTurn: ReturnType<typeof vi.fn>;
  let pushToCard: ReturnType<typeof vi.fn>;

  function makeCommandEvent(
    overrides: Partial<ApprovalRequestedEvent> = {},
  ): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId: 1001,
      kind: 'command',
      threadId: 'th-aaa-222',
      turnId: 'tn-222',
      itemId: 'item-2',
      view: {
        requestId: 1001,
        kind: 'command',
        command: 'rm -rf /tmp/test',
        commandCwd: '/home/user/project',
        reason: 'Test approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
      ...overrides,
    };
  }

  function makeFileEvent(overrides: Partial<ApprovalRequestedEvent> = {}): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId: 1002,
      kind: 'file',
      threadId: 'th-aaa-333',
      turnId: 'tn-333',
      itemId: 'item-3',
      view: {
        requestId: 1002,
        kind: 'file',
        fileChanges: [{ path: 'src/main.ts', kind: 'update', diff: '...' }],
        reason: 'File change approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
      ...overrides,
    };
  }

  function makePermissionsEvent(
    overrides: Partial<ApprovalRequestedEvent> = {},
  ): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId: 1003,
      kind: 'permissions',
      threadId: 'th-aaa-444',
      turnId: 'tn-444',
      itemId: 'item-4',
      view: {
        requestId: 1003,
        kind: 'permissions',
        reason: 'Permissions approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
        permissions: {
          items: [
            {
              id: 'net:api.example.com:443',
              label: 'https://api.example.com:443',
              target: { kind: 'network' },
              selected: false,
            },
            {
              id: 'fs-read:/home/user/project',
              label: 'Read: /home/user/project',
              target: { kind: 'fsRead', path: '/home/user/project' },
              selected: false,
            },
          ],
        },
      },
      ...overrides,
    };
  }

  function makePlanExitEvent(
    overrides: Partial<ApprovalRequestedEvent> = {},
  ): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId: 2001,
      kind: 'tool',
      threadId: 'th-plan-555',
      turnId: 'tn-plan-555',
      itemId: 'item-plan-555',
      view: {
        requestId: 2001,
        kind: 'tool',
        toolName: 'ExitPlanMode',
        reason: '已按计划准备好实施方案，请审批',
        plan: '# 原计划\n\n1. 步骤一',
        planFilePath: '/home/user/.claude/plans/mock-plan.md',
        availableDecisions: [
          'accept',
          'acceptAll',
          'declineWithFeedback',
          'acceptWithFeedback',
          'decline',
        ],
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    responder = vi.fn().mockResolvedValue(undefined);
    interruptTurn = vi.fn().mockResolvedValue(undefined);
    pushToCard = vi.fn().mockResolvedValue(undefined);

    coordinator = new ApprovalCoordinator({
      approvalTimeoutMs: 30000,
      responder,
      interruptTurn,
      pushToCard,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates an instance with zero pending approvals', () => {
      expect(coordinator.pendingCount()).toBe(0);
    });
  });

  describe('onRequested', () => {
    it('tracks a new approval request', () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      expect(coordinator.pendingCount()).toBe(1);
    });

    it('updates existing approval on duplicate requestId', () => {
      const event1 = makeCommandEvent({ requestId: 1001 });
      const event2 = makeCommandEvent({
        requestId: 1001,
        view: { ...event1.view, command: 'new command' },
      });
      coordinator.onRequested(event1);
      coordinator.onRequested(event2);
      expect(coordinator.pendingCount()).toBe(1);
      // duplicate requestId 更新 view 而非新增：submit 后 responder 收到更新后的 command
      coordinator.submit({ action: 'accept' }, { requestId: 1001 });
      expect(responder).toHaveBeenCalledWith(1001, { action: 'accept' });
    });
  });

  describe('submit', () => {
    it('accepts a valid approval', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      await coordinator.submit({ action: 'accept' }, { requestId: 1001 });
      expect(responder).toHaveBeenCalledWith(1001, { action: 'accept' });
      expect(coordinator.pendingCount()).toBe(0);
    });

    it('rejects a duplicate nonce (same rendered button clicked twice)', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      await coordinator.submit({ action: 'accept' }, { requestId: 1001, nonce: 'n1' });
      await expect(
        coordinator.submit({ action: 'decline' }, { requestId: 1001, nonce: 'n1' }),
      ).rejects.toThrow(/duplicate nonce/);
    });

    it('accepts string requestIds from the wire (schema: string | integer)', async () => {
      const event = makeCommandEvent({ requestId: 'req-abc-42' });
      event.view.requestId = 'req-abc-42';
      coordinator.onRequested(event);
      await coordinator.submit({ action: 'accept' }, { requestId: 'req-abc-42', nonce: 'n-str' });
      expect(responder).toHaveBeenCalledWith('req-abc-42', { action: 'accept' });
    });

    it('throws for unknown requestId', async () => {
      await expect(coordinator.submit({ action: 'accept' }, { requestId: 9999 })).rejects.toThrow(
        'not found',
      );
    });

    it('throws for non-pending approval', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      await coordinator.submit({ action: 'accept' }, { requestId: 1001 });
      await expect(coordinator.submit({ action: 'accept' }, { requestId: 1001 })).rejects.toThrow(
        'no longer pending',
      );
    });

    it('cancel is always allowed as safety override', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.submit({ action: 'cancel' }, { requestId: 1001 }),
      ).resolves.toBeUndefined();
      expect(responder).toHaveBeenCalledWith(1001, { action: 'cancel' });
    });
  });

  describe('onResolved', () => {
    it('marks approval as resolved', () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      expect(coordinator.pendingCount()).toBe(1);
      coordinator.onResolved(1001);
      expect(coordinator.pendingCount()).toBe(0);
    });

    it('handles unknown requestId gracefully', () => {
      expect(() => coordinator.onResolved(9999)).not.toThrow();
    });
  });

  describe('pendingCount', () => {
    it('returns zero when no approvals', () => {
      expect(coordinator.pendingCount()).toBe(0);
    });

    it('returns correct count with multiple approvals', () => {
      coordinator.onRequested(makeCommandEvent({ requestId: 1001 }));
      coordinator.onRequested(makeFileEvent({ requestId: 1002 }));
      expect(coordinator.pendingCount()).toBe(2);
    });

    it('excludes resolved approvals', async () => {
      coordinator.onRequested(makeCommandEvent({ requestId: 1001 }));
      coordinator.onRequested(makeFileEvent({ requestId: 1002 }));
      await coordinator.submit({ action: 'accept' }, { requestId: 1001 });
      expect(coordinator.pendingCount()).toBe(1);
    });
  });

  describe('togglePerm', () => {
    it('toggles a permission item', async () => {
      const event = makePermissionsEvent();
      coordinator.onRequested(event);
      await coordinator.togglePerm(
        { permId: 'net:api.example.com:443', selected: true },
        { requestId: 1003 },
      );
      expect(event.view.permissions!.items[0].selected).toBe(true);
    });

    it('throws for non-permissions request', async () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.togglePerm({ permId: 'test', selected: true }, { requestId: 1001 }),
      ).rejects.toThrow('not a permissions request');
    });

    it('throws for unknown permId', async () => {
      const event = makePermissionsEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.togglePerm({ permId: 'unknown', selected: true }, { requestId: 1003 }),
      ).rejects.toThrow('not found');
    });
  });

  describe('timeout', () => {
    it('expires approval after timeout', () => {
      const event = makeCommandEvent();
      coordinator.onRequested(event);
      expect(coordinator.pendingCount()).toBe(1);
      vi.advanceTimersByTime(30000);
      expect(coordinator.pendingCount()).toBe(0);
    });

    it('expires immediately when approvalTimeoutMs is 0', () => {
      // review P3-1：schema 允许 0，语义为「立即过期」（fail-fast，避免审批
      // 永久挂起）；文档在 config schema 注释中明确，测试固化该语义。
      coordinator = new ApprovalCoordinator({
        approvalTimeoutMs: 0,
        responder,
        interruptTurn,
        pushToCard,
      });
      coordinator.onRequested(makeCommandEvent());
      expect(coordinator.pendingCount()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(coordinator.pendingCount()).toBe(0);
      expect(responder).toHaveBeenCalledWith(1001, { action: 'cancel' });
    });

    it('test_anchor_prefers_event_timeout_override_over_run_default', () => {
      // Codex autoResolutionMs / Pi extension timeout 经事件 timeoutMs 下传：
      // 默认 30s 未到、事件 5s 先到时应按事件超时过期并回 cancel。
      coordinator.onRequested(makeCommandEvent({ timeoutMs: 5000 }));
      expect(coordinator.pendingCount()).toBe(1);
      vi.advanceTimersByTime(5001);
      expect(coordinator.pendingCount()).toBe(0);
      expect(responder).toHaveBeenCalledWith(1001, { action: 'cancel' });
    });
  });

  describe('protocol decision space (real availableDecisions)', () => {
    function makeProtocolCommandEvent(
      overrides: Partial<ApprovalRequestedEvent> = {},
    ): ApprovalRequestedEvent {
      return {
        ...makeCommandEvent(),
        view: {
          ...makeCommandEvent().view,
          // 真实协议：服务端只列 accept / acceptWithExecpolicyAmendment / cancel
          availableDecisions: ['accept', 'acceptWithExecpolicyAmendment', 'cancel'],
          decisionPayloads: {
            acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm', '/tmp/test'] },
          },
        },
        ...overrides,
      };
    }

    it('test_anchor_coordinator_accepts_listed_amendment_decision', async () => {
      const event = makeProtocolCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.submit({ action: 'accept_with_execpolicy_amendment' }, { requestId: 1001 }),
      ).resolves.toBeUndefined();
      expect(responder).toHaveBeenCalledWith(
        1001,
        expect.objectContaining({ action: 'accept_with_execpolicy_amendment' }),
      );
    });

    it('test_anchor_coordinator_always_allows_deny_even_when_unlisted', async () => {
      // 服务端列表不含 decline 时，拒绝仍必须可用（安全兜底：真人拒绝是普适语义，
      // 实测服务端也接受 decline）。
      const event = makeProtocolCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.submit({ action: 'decline' }, { requestId: 1001 }),
      ).resolves.toBeUndefined();
    });

    it('test_anchor_coordinator_rejects_unlisted_positive_decision', async () => {
      // 未列出的正向决策（acceptForSession）不得通过校验。
      const event = makeProtocolCommandEvent();
      coordinator.onRequested(event);
      await expect(
        coordinator.submit({ action: 'accept_for_session' }, { requestId: 1001 }),
      ).rejects.toThrow('not in available decisions');
    });

    it('test_anchor_coordinator_update_view_only_while_pending', async () => {
      const event = makeFileEvent();
      coordinator.onRequested(event);
      const updatedView: ApprovalView = {
        ...event.view,
        fileChanges: [{ path: '/home/user/project/a.txt', kind: 'update', diff: '+hello' }],
      };
      coordinator.updateView(1002, updatedView);
      // updateView 后 view 已更新：submit 会调用 responder
      await coordinator.submit({ action: 'accept' }, { requestId: 1002 });
      expect(responder).toHaveBeenCalledWith(1002, { action: 'accept' });
      expect(coordinator.pendingCount()).toBe(0);

      // 已响应后 updateView 不得复活/改写
      coordinator.updateView(1002, { ...updatedView, fileChanges: [] });
      expect(coordinator.pendingCount()).toBe(0);
    });
  });

  describe('decisionToApprovalAction mapping', () => {
    it('test_anchor_decision_to_action_maps_protocol_decisions', () => {
      expect(decisionToApprovalAction('accept')).toEqual({ action: 'accept' });
      expect(decisionToApprovalAction('acceptForSession')).toEqual({
        action: 'accept_for_session',
      });
      expect(decisionToApprovalAction('acceptWithExecpolicyAmendment')).toEqual({
        action: 'accept_with_execpolicy_amendment',
      });
      expect(decisionToApprovalAction('decline')).toEqual({ action: 'decline' });
      expect(decisionToApprovalAction('cancel')).toEqual({ action: 'cancel' });
      // Claude「允许所有」：acceptAll → accept_all（会话级自动放行）。
      expect(decisionToApprovalAction('acceptAll')).toEqual({ action: 'accept_all' });
      // 计划审批反馈类决策：decisionToApprovalAction 只带决策名，payload 由
      // coordinator.submit 从已填写的修改意见补齐。
      expect(decisionToApprovalAction('declineWithFeedback')).toEqual({
        action: 'decline_with_feedback',
        message: '',
      });
      expect(decisionToApprovalAction('acceptWithFeedback')).toEqual({
        action: 'accept_with_feedback',
        plan: '',
      });
    });
  });

  // =========================================================================
  // ExitPlanMode 计划审批（kind === 'tool' 反馈类决策）
  // =========================================================================

  describe('ExitPlanMode plan feedback', () => {
    it('test_anchor_plan_feedback_stores_and_echoes_view', async () => {
      coordinator.onRequested(makePlanExitEvent());
      await coordinator.planFeedback(
        { text: '  先补测试再写实现  ' },
        { requestId: 2001, nonce: 'fb-1' },
      );
      expect(pushToCard).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'approval_view_updated',
            requestId: 2001,
          }),
        ]),
      );
      // 空意见拒绝保存
      await expect(
        coordinator.planFeedback({ text: '   ' }, { requestId: 2001, nonce: 'fb-2' }),
      ).rejects.toThrow('请输入修改意见');
    });

    it('test_anchor_plan_decline_with_feedback_injects_stored_feedback', async () => {
      coordinator.onRequested(makePlanExitEvent());
      await coordinator.planFeedback(
        { text: '先把测试写了再实施' },
        { requestId: 2001, nonce: 'fb-1' },
      );
      await coordinator.submit(
        { action: 'decline_with_feedback', message: '' },
        { requestId: 2001, nonce: 'd-1' },
      );
      expect(responder).toHaveBeenCalledWith(2001, {
        action: 'decline_with_feedback',
        message: '先把测试写了再实施',
      });
    });

    it('test_anchor_plan_accept_with_feedback_appends_feedback_to_plan', async () => {
      coordinator.onRequested(makePlanExitEvent());
      await coordinator.planFeedback({ text: '补测试' }, { requestId: 2001, nonce: 'fb-1' });
      await coordinator.submit(
        { action: 'accept_with_feedback', plan: '' },
        { requestId: 2001, nonce: 'a-1' },
      );
      expect(responder).toHaveBeenCalledWith(
        2001,
        expect.objectContaining({
          action: 'accept_with_feedback',
          plan: expect.stringContaining('# 原计划'),
        }),
      );
      const payload = (responder.mock.calls[0] as unknown[])[1] as {
        action: string;
        plan: string;
      };
      expect(payload.plan).toContain('## 用户修改意见');
      expect(payload.plan).toContain('补测试');
    });

    it('test_anchor_plan_feedback_decisions_require_feedback', async () => {
      coordinator.onRequested(makePlanExitEvent());
      await expect(
        coordinator.submit(
          { action: 'decline_with_feedback', message: '' },
          { requestId: 2001, nonce: 'd-1' },
        ),
      ).rejects.toThrow('请先填写修改意见');
      expect(responder).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Claude AskUserQuestion（kind === 'question'）
  // =========================================================================

  function makeQuestionEvent(
    overrides: Partial<ApprovalRequestedEvent> = {},
  ): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId: 2001,
      kind: 'question',
      threadId: 'th-qqq-1',
      turnId: 'tn-qqq-1',
      itemId: 'item-qqq-1',
      view: {
        requestId: 2001,
        kind: 'question',
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            options: [{ label: 'Red' }, { label: 'Blue' }],
          },
          {
            question: 'Pick toppings',
            header: 'Toppings',
            multiSelect: true,
            options: [{ label: 'Cheese' }, { label: 'Bacon' }],
          },
        ],
        availableDecisions: [],
      },
      ...overrides,
    };
  }

  describe('AskUserQuestion answers', () => {
    it('test_anchor_single_select_auto_submits_when_all_answered', async () => {
      coordinator.onRequested(makeQuestionEvent());

      await coordinator.toggleAnswer(
        { questionIndex: 0, option: 'Red' },
        { requestId: 2001, nonce: 'n1' },
      );
      // 单选已答但多选未提交 → 不触发 responder
      expect(responder).not.toHaveBeenCalled();

      // 多选勾选 + 提交
      await coordinator.toggleAnswer(
        { questionIndex: 1, option: 'Cheese' },
        { requestId: 2001, nonce: 'n2' },
      );
      await coordinator.toggleAnswer(
        { questionIndex: 1, option: 'Bacon' },
        { requestId: 2001, nonce: 'n3' },
      );
      await coordinator.submitAnswers({ questionIndex: 1 }, { requestId: 2001, nonce: 'n4' });

      expect(responder).toHaveBeenCalledTimes(1);
      expect(responder).toHaveBeenCalledWith(2001, {
        action: 'answer',
        answers: { 'Pick a color': 'Red', 'Pick toppings': ['Cheese', 'Bacon'] },
      });
      expect(coordinator.pendingCount()).toBe(0);
    });

    it('test_anchor_submit_pushes_resolved_card_event_agent_agnostic', async () => {
      // review P2-3：提交成功后的 approval_resolved 由 coordinator 统一推送
      // （claude 无 server 回发；codex 幂等），不再由 bridge responder 顺带做。
      coordinator.onRequested(makeCommandEvent());
      await coordinator.submit({ action: 'accept' }, { requestId: 1001, nonce: 'n1' });

      expect(pushToCard).toHaveBeenCalled();
      const events = pushToCard.mock.calls.flat(2) as Array<{ type: string; requestId: number }>;
      const resolved = events.find((e) => e.type === 'approval_resolved');
      expect(resolved).toBeDefined();
      expect(resolved?.requestId).toBe(1001);
    });

    it('test_anchor_submit_failure_does_not_push_resolved', async () => {
      responder.mockRejectedValue(new Error('connection closed'));
      coordinator.onRequested(makeCommandEvent());
      await coordinator.submit({ action: 'accept' }, { requestId: 1001, nonce: 'n1' });

      const events = pushToCard.mock.calls.flat(2) as Array<{ type?: string }>;
      expect(events.some((e) => e.type === 'approval_resolved')).toBe(false);
    });

    it('test_anchor_answer_path_pushes_resolved_after_respond', async () => {
      coordinator.onRequested(makeQuestionEvent());
      await coordinator.toggleAnswer(
        { questionIndex: 0, option: 'Red' },
        { requestId: 2001, nonce: 'n1' },
      );
      await coordinator.toggleAnswer(
        { questionIndex: 1, option: 'Cheese' },
        { requestId: 2001, nonce: 'n2' },
      );
      await coordinator.submitAnswers({ questionIndex: 1 }, { requestId: 2001, nonce: 'n3' });

      const events = pushToCard.mock.calls.flat(2) as Array<{ type?: string; requestId?: number }>;
      const resolved = events.find((e) => e.type === 'approval_resolved');
      expect(resolved?.requestId).toBe(2001);
    });

    it('test_anchor_multi_select_toggle_does_not_submit_until_submit_answers', async () => {
      coordinator.onRequested(makeQuestionEvent());
      await coordinator.toggleAnswer(
        { questionIndex: 1, option: 'Cheese' },
        { requestId: 2001, nonce: 'n1' },
      );
      expect(responder).not.toHaveBeenCalled();

      // 单选未答 → 即使多选提交也不触发 responder
      await coordinator.submitAnswers({ questionIndex: 1 }, { requestId: 2001, nonce: 'n2' });
      expect(responder).not.toHaveBeenCalled();

      // 取消勾选后提交 → 拒绝（未选任何选项）
      await coordinator.toggleAnswer(
        { questionIndex: 1, option: 'Cheese' },
        { requestId: 2001, nonce: 'n3' },
      );
      await expect(
        coordinator.submitAnswers({ questionIndex: 1 }, { requestId: 2001, nonce: 'n4' }),
      ).rejects.toThrow('请先选择至少一个选项');
    });

    it('test_anchor_multi_select_toggle_duplicate_nonce_rejected', async () => {
      // review P2-1：多选切换按钮同一 nonce 重复投递（双击/飞书重投递）只应
      // toggle 一次，不能二次 toggle 抵消勾选。
      const event = makeQuestionEvent();
      coordinator.onRequested(event);
      await coordinator.toggleAnswer(
        { questionIndex: 1, option: 'Cheese' },
        { requestId: 2001, nonce: 'n-dup' },
      );
      expect(event.view.questions![1].selected).toEqual(['Cheese']);

      await expect(
        coordinator.toggleAnswer(
          { questionIndex: 1, option: 'Cheese' },
          { requestId: 2001, nonce: 'n-dup' },
        ),
      ).rejects.toThrow(/duplicate nonce/);
      expect(event.view.questions![1].selected).toEqual(['Cheese']);
    });

    it('test_anchor_answer_custom_submits_free_text', async () => {
      // review P3-4：AskUserQuestion 隐式 Other 自由文本——自定义答案文本
      // 直接作为该单选问题的答案提交。
      coordinator.onRequested(makeQuestionEvent());
      await coordinator.answerCustom(
        { questionIndex: 0, text: '自定义紫色' },
        { requestId: 2001, nonce: 'n-c1' },
      );
      // 单选已答但多选未提交 → 不触发 responder
      expect(responder).not.toHaveBeenCalled();

      await coordinator.toggleAnswer(
        { questionIndex: 1, option: 'Cheese' },
        { requestId: 2001, nonce: 'n-c2' },
      );
      await coordinator.submitAnswers({ questionIndex: 1 }, { requestId: 2001, nonce: 'n-c3' });

      expect(responder).toHaveBeenCalledTimes(1);
      expect(responder).toHaveBeenCalledWith(2001, {
        action: 'answer',
        answers: { 'Pick a color': '自定义紫色', 'Pick toppings': ['Cheese'] },
      });

      // 多选问题不支持自定义答案（Other 仅单选）
      const multiEvent = makeQuestionEvent({ requestId: 2002 });
      coordinator.onRequested(multiEvent);
      await expect(
        coordinator.answerCustom(
          { questionIndex: 1, text: 'x' },
          { requestId: 2002, nonce: 'n-c4' },
        ),
      ).rejects.toThrow('自定义答案仅支持单选');

      // 空白文本拒绝
      await expect(
        coordinator.answerCustom(
          { questionIndex: 0, text: '   ' },
          { requestId: 2002, nonce: 'n-c5' },
        ),
      ).rejects.toThrow('请输入自定义答案');
    });

    it('test_anchor_answer_submit_then_duplicate_click_rejected', async () => {
      coordinator.onRequested(makeQuestionEvent());
      await coordinator.toggleAnswer(
        { questionIndex: 0, option: 'Red' },
        { requestId: 2001, nonce: 'n1' },
      );
      await coordinator.toggleAnswer(
        { questionIndex: 1, option: 'Cheese' },
        { requestId: 2001, nonce: 'n2' },
      );
      await coordinator.submitAnswers({ questionIndex: 1 }, { requestId: 2001, nonce: 'n3' });
      expect(responder).toHaveBeenCalledTimes(1);

      // 已提交（state=resolved）后再点任何选项 → 拒绝，答案不得重复提交
      await expect(
        coordinator.toggleAnswer(
          { questionIndex: 0, option: 'Red' },
          { requestId: 2001, nonce: 'n1' },
        ),
      ).rejects.toThrow('no longer pending');
      expect(responder).toHaveBeenCalledTimes(1);
    });

    it('test_anchor_answer_unknown_question_or_option_rejected', async () => {
      coordinator.onRequested(makeQuestionEvent());
      await expect(
        coordinator.toggleAnswer({ questionIndex: 5, option: 'X' }, { requestId: 2001 }),
      ).rejects.toThrow('not found');
      await expect(
        coordinator.toggleAnswer({ questionIndex: 0, option: 'Missing' }, { requestId: 2001 }),
      ).rejects.toThrow('not found');
    });

    it('test_anchor_answer_note_attaches_note_to_submitted_answer', async () => {
      // Codex user_note：选项之外的补充说明，随答案一起提交（runner 编码为
      // "user_note: <text>" 条目）。note 本身不构成「已答」，仍需选项/自定义答案。
      const event = makeQuestionEvent();
      coordinator.onRequested(event);
      await coordinator.answerNote(
        { questionIndex: 0, text: '先验证 PostgreSQL 17 兼容性' },
        { requestId: 2001, nonce: 'n-note1' },
      );
      // note 已记录并回流视图（卡片回显）
      expect(event.view.questions![0].note).toBe('先验证 PostgreSQL 17 兼容性');
      expect(responder).not.toHaveBeenCalled();

      await coordinator.toggleAnswer(
        { questionIndex: 0, option: 'Red' },
        { requestId: 2001, nonce: 'n-note2' },
      );
      await coordinator.toggleAnswer(
        { questionIndex: 1, option: 'Cheese' },
        { requestId: 2001, nonce: 'n-note3' },
      );
      await coordinator.submitAnswers({ questionIndex: 1 }, { requestId: 2001, nonce: 'n-note4' });

      expect(responder).toHaveBeenCalledTimes(1);
      expect(responder).toHaveBeenCalledWith(2001, {
        action: 'answer',
        answers: { 'Pick a color': 'Red', 'Pick toppings': ['Cheese'] },
        notes: { 'Pick a color': '先验证 PostgreSQL 17 兼容性' },
      });
    });

    it('test_anchor_answer_note_validates_question_and_blank_text', async () => {
      coordinator.onRequested(makeQuestionEvent());
      await expect(
        coordinator.answerNote(
          { questionIndex: 99, text: 'x' },
          { requestId: 2001, nonce: 'n-note5' },
        ),
      ).rejects.toThrow(/Question 99 not found/);
      await expect(
        coordinator.answerNote(
          { questionIndex: 0, text: '   ' },
          { requestId: 2001, nonce: 'n-note6' },
        ),
      ).rejects.toThrow('请输入补充说明');
    });
  });
});
