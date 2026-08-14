/**
 * A1 anchor: 审批过期必须自动向 server 发送 cancel 响应（闭环）。
 *
 * ① 验证什么：ApprovalCoordinator 的审批请求在 approvalTimeoutMs 到期（过期）时，
 *    自动通过 responder 发送 { action: 'cancel' }，使 codex server 收到响应、
 *    不再无限等待。
 * ② 缺失/错误会导致什么：当前 expireApproval() 只把内部状态标为 expired，从不调用
 *    responder——server 永远等不到审批响应，只能等 runner 的 10 分钟 turn 超时兜底；
 *    用户「点了允许还超时」（2026-08-12 实录：点击发生在过期后 65 秒，accept 被静默丢弃）。
 * ③ 依据：bug spec 验收标准 A——「审批过期时自动通过 responder 向 server 发送
 *    cancel 响应，server 不再无限等待」。cancel 是真实协议决策空间
 *    （accept / acceptWithExecpolicyAmendment / cancel）中的「停止等待」语义；
 *    decline 仅是本桥的 UI 安全兜底，不在真实协议内（approval-coordinator.test.ts
 *    「真实协议：服务端只列 accept / acceptWithExecpolicyAmendment / cancel」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../../../src/bridge/approval-coordinator.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

describe('anchor: approval expiry closure', () => {
  let coordinator: ApprovalCoordinator;
  let responder: ReturnType<typeof vi.fn>;
  let interruptTurn: ReturnType<typeof vi.fn>;
  let pushToCard: ReturnType<typeof vi.fn>;

  const runId = 'run-aaa-111';
  const userId = 'user-1';
  const chatId = 'chat-1';
  const workspace = '/home/user/project';
  const approvalTimeoutMs = 30000;

  function makeCommandEvent(): ApprovalRequestedEvent {
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
        threadShort: 'th-aaa-2',
        turnShort: 'tn-222',
        workspace,
        command: 'mv /tmp/a.txt /tmp/b.txt',
        commandCwd: workspace,
        reason: 'Test approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
        pendingTotal: 1,
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    responder = vi.fn().mockResolvedValue(undefined);
    interruptTurn = vi.fn().mockResolvedValue(undefined);
    pushToCard = vi.fn().mockResolvedValue(undefined);
    coordinator = new ApprovalCoordinator({
      runId,
      userId,
      chatId,
      workspace,
      approvalTimeoutMs,
      responder,
      interruptTurn,
      pushToCard,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_anchor_approval_expired_auto_cancels_to_server', () => {
    coordinator.onRequested(makeCommandEvent());
    expect(responder).not.toHaveBeenCalled();

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).toHaveBeenCalledTimes(1);
    expect(responder).toHaveBeenCalledWith(1001, { action: 'cancel' });
  });

  it('test_anchor_approval_expired_pushes_expired_event_to_card', () => {
    coordinator.onRequested(makeCommandEvent());

    vi.advanceTimersByTime(approvalTimeoutMs);

    // 过期事件到达卡片后，run-renderer 会显示「⏰ 审批已过期」并隐藏按钮
    //（approval-render.ts 已有 expired UI，但当前没有任何代码推送该状态）。
    expect(pushToCard).toHaveBeenCalledTimes(1);
    const events = pushToCard.mock.calls[0][0] as Array<{
      type: string;
      requestId?: number;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'approval_expired', requestId: 1001 });
  });

  it('test_anchor_approval_expired_cancel_failure_triggers_interrupt_turn', async () => {
    // 过期 cancel 发送失败（responder reject）时必须以 interruptTurn 兜底，
    // 否则 server 仍可能无限等待审批响应（事故路径：10 分钟 turn 超时兜底）。
    responder.mockRejectedValue(new Error('connection closed'));
    coordinator.onRequested(makeCommandEvent());

    vi.advanceTimersByTime(approvalTimeoutMs);

    await vi.waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledTimes(1);
    });
  });
});
