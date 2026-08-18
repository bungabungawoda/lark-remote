/**
 * P2 probe: responder 抛错时状态置 failed，且调用 interruptTurn() 兜底。
 *
 * ① 验证什么：过期 cancel 发送失败（responder reject）时，协调器把审批状态
 *    从 expired 改为 failed，并调用 interruptTurn() 终止 turn——杜绝
 *    「server 永远等」的死路。
 * ② 缺失/错误会导致什么：cancel 未送达且不中断 turn 时，server 只能等 10 分钟
 *    turn 超时兜底；状态停留在 expired 会掩盖「响应失败」这一事实。
 * ③ 依据：bug spec R1——「responder 抛错时状态置 failed，且调用 interruptTurn()
 *    兜底（best-effort）」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../../../src/bridge/approval-coordinator.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

describe('probe: approval expiry responder failure', () => {
  let coordinator: ApprovalCoordinator;
  let responder: ReturnType<typeof vi.fn>;
  let interruptTurn: ReturnType<typeof vi.fn>;
  let pushToCard: ReturnType<typeof vi.fn>;

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

  it('test_probe_approval_expired_responder_failure_marks_failed_and_interrupts', async () => {
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
});
