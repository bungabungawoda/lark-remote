/**
 * P1 probe: 过期幂等——已过期/已响应/已 resolved 的请求不得重复触发 responder。
 *
 * ① 验证什么：ApprovalCoordinator 超时只触发一次 cancel；过期后 submit 不会
 *    再次触发 responder；审批已 resolved 后超时也不触发 responder。
 * ② 缺失/错误会导致什么：过期回调重复执行（timer 未清）会向 server 发送多条
 *    响应；过期后 submit 若还能走 responder，会与「已过期」状态冲突。
 * ③ 依据：bug spec R1——「已过期/已响应/已 resolved 的请求不得重复触发 responder」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../../../src/bridge/approval-coordinator.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

describe('probe: approval expiry idempotency', () => {
  let coordinator: ApprovalCoordinator;
  let responder: ReturnType<typeof vi.fn>;
  let interruptTurn: ReturnType<typeof vi.fn>;
  let pushToCard: ReturnType<typeof vi.fn>;

  const workspace = '/home/user/project';
  const approvalTimeoutMs = 30000;

  function makeCommandEvent(requestId = 1001): ApprovalRequestedEvent {
    return {
      type: 'approval_requested',
      requestId,
      kind: 'command',
      threadId: 'th-aaa-222',
      turnId: 'tn-222',
      itemId: 'item-2',
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

  it('test_probe_approval_expired_double_timeout_responder_once', () => {
    coordinator.onRequested(makeCommandEvent());

    vi.advanceTimersByTime(approvalTimeoutMs);
    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).toHaveBeenCalledTimes(1);
    expect(responder).toHaveBeenCalledWith(1001, { action: 'cancel' });
  });

  it('test_probe_approval_expired_submit_after_expiry_no_responder', async () => {
    coordinator.onRequested(makeCommandEvent());

    vi.advanceTimersByTime(approvalTimeoutMs);
    expect(responder).toHaveBeenCalledTimes(1);

    await expect(coordinator.submit({ action: 'accept' }, { requestId: 1001 })).rejects.toThrow(
      /state=expired/,
    );

    vi.advanceTimersByTime(approvalTimeoutMs);
    expect(responder).toHaveBeenCalledTimes(1);
  });

  it('test_probe_approval_resolved_before_timeout_no_responder', () => {
    coordinator.onRequested(makeCommandEvent());
    coordinator.onResolved(1001);

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).not.toHaveBeenCalled();
    expect(pushToCard).not.toHaveBeenCalled();
  });
});
