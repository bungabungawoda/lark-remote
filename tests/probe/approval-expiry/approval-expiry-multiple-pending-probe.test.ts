/**
 * P4 probe: 多个 pending 审批各自独立过期。
 *
 * ① 验证什么：多个审批各自持有独立 timer——到期后各自触发一次 responder
 *    （requestId 一一对应）；其中一个提前 resolved 不影响其余审批过期。
 * ② 缺失/错误会导致什么：timer 共享或清理错乱时，一个审批过期会连带误响应
 *    其他审批，或已 resolved 的审批仍被重复响应。
 * ③ 依据：bug spec R1——每个 pending 审批独立走「过期 → cancel → 卡片事件」闭环。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../../../src/bridge/approval-coordinator.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

describe('probe: approval expiry multiple pending', () => {
  let coordinator: ApprovalCoordinator;
  let responder: ReturnType<typeof vi.fn>;
  let interruptTurn: ReturnType<typeof vi.fn>;
  let pushToCard: ReturnType<typeof vi.fn>;

  const workspace = '/home/user/project';
  const approvalTimeoutMs = 30000;

  function makeCommandEvent(requestId: number): ApprovalRequestedEvent {
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
        commandCwd: workspace,
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

  it('test_probe_multiple_pending_expire_independently', () => {
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

  it('test_probe_resolved_one_does_not_expire_other', () => {
    coordinator.onRequested(makeCommandEvent(1001));
    coordinator.onRequested(makeCommandEvent(1002));
    coordinator.onResolved(1001);

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).toHaveBeenCalledTimes(1);
    expect(responder).toHaveBeenCalledWith(1002, { action: 'cancel' });
  });
});
