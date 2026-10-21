/**
 * ApprovalCoordinator 过期语义（合并自 idempotency / expire-decline /
 * multiple-pending / responder-failure / turn-end 五个探针）。
 *
 * ① 过期：responder 收到一次 cancel，卡片收到 approval_expired 事件。
 * ② 幂等：已过期/已响应/已 resolved 不重复触发 responder；过期后 submit 报错。
 * ③ 多 pending：各自独立 timer，一个 resolved 不影响其余过期。
 * ④ responder 失败：状态置 failed 并 interruptTurn() 兜底。
 * ⑤ turn 结束：只标记 expired、清 timer，不调 responder。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../../../src/bridge/approval-coordinator.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

describe('anchor: approval expiry coordinator', () => {
  let coordinator: ApprovalCoordinator;
  let responder: ReturnType<typeof vi.fn>;
  let interruptTurn: ReturnType<typeof vi.fn>;
  let pushToCard: ReturnType<typeof vi.fn>;

  const cwd = '/home/user/project';
  const approvalTimeoutMs = 30000;

  function makeCommandEvent(requestId = 1001): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId,
      kind: 'command',
      threadId: 'th-aaa-222',
      turnId: 'tn-222',
      itemId: `item-${requestId}`,
      view: {
        requestId,
        kind: 'command',
        command: 'mv /tmp/a.txt /tmp/b.txt',
        commandCwd: cwd,
        reason: 'Test approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    responder = vi.fn().mockResolvedValue(undefined);
    interruptTurn = vi.fn().mockResolvedValue(undefined);
    pushToCard = vi.fn().mockResolvedValue(undefined);
    coordinator = new ApprovalCoordinator({
      approvalTimeoutMs,
      responder,
      interruptTurn,
      pushToCard,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_anchor_approval_expired_pushes_expired_event_to_card', () => {
    coordinator.onRequested(makeCommandEvent());

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(pushToCard).toHaveBeenCalledTimes(1);
    const events = pushToCard.mock.calls[0][0] as Array<{
      type: string;
      requestId?: number;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'approval_expired', requestId: 1001 });
  });

  it('test_anchor_approval_expired_double_timeout_responder_once', () => {
    coordinator.onRequested(makeCommandEvent());

    vi.advanceTimersByTime(approvalTimeoutMs);
    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).toHaveBeenCalledTimes(1);
    expect(responder).toHaveBeenCalledWith(1001, { action: 'cancel' });
  });

  it('test_anchor_approval_expired_submit_after_expiry_no_responder', async () => {
    coordinator.onRequested(makeCommandEvent());

    vi.advanceTimersByTime(approvalTimeoutMs);
    expect(responder).toHaveBeenCalledTimes(1);

    await expect(coordinator.submit({ action: 'accept' }, { requestId: 1001 })).rejects.toThrow(
      /state=expired/,
    );

    vi.advanceTimersByTime(approvalTimeoutMs);
    expect(responder).toHaveBeenCalledTimes(1);
  });

  it('test_anchor_approval_resolved_before_timeout_no_responder', () => {
    coordinator.onRequested(makeCommandEvent());
    coordinator.onResolved(1001);

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).not.toHaveBeenCalled();
    expect(pushToCard).not.toHaveBeenCalled();
  });

  it('test_anchor_multiple_pending_expire_independently', () => {
    coordinator.onRequested(makeCommandEvent(1001));
    coordinator.onRequested(makeCommandEvent(1002));

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).toHaveBeenCalledTimes(2);
    expect(responder).toHaveBeenCalledWith(1001, { action: 'cancel' });
    expect(responder).toHaveBeenCalledWith(1002, { action: 'cancel' });

    const events = pushToCard.mock.calls.map(
      (call) => (call[0] as Array<{ type: string; requestId: number }>)[0],
    );
    expect(events).toEqual([
      { type: 'approval_expired', requestId: 1001 },
      { type: 'approval_expired', requestId: 1002 },
    ]);
  });

  it('test_anchor_resolved_one_does_not_expire_other', () => {
    coordinator.onRequested(makeCommandEvent(1001));
    coordinator.onRequested(makeCommandEvent(1002));
    coordinator.onResolved(1001);

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).toHaveBeenCalledTimes(1);
    expect(responder).toHaveBeenCalledWith(1002, { action: 'cancel' });
  });

  it('test_anchor_approval_expired_responder_failure_marks_failed_and_interrupts', async () => {
    responder.mockRejectedValue(new Error('connection closed'));
    coordinator.onRequested(makeCommandEvent());

    vi.advanceTimersByTime(approvalTimeoutMs);

    await vi.waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledTimes(1);
    });

    // 响应失败后状态必须从 expired 升级为 failed（可通过 submit 的报错观察到），
    // 不能停留在 expired 假装「正常过期」。
    await expect(coordinator.submit({ action: 'accept' }, { requestId: 1001 })).rejects.toThrow(
      /state=failed/,
    );
  });

  it('test_anchor_turn_ended_marks_expired_without_responder', async () => {
    coordinator.onRequested(makeCommandEvent());
    coordinator.onTurnEnded();

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).not.toHaveBeenCalled();
    expect(pushToCard).not.toHaveBeenCalled();
    await expect(coordinator.submit({ action: 'accept' }, { requestId: 1001 })).rejects.toThrow(
      /state=expired/,
    );
  });
});
