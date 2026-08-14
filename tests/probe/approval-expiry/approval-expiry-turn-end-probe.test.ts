/**
 * P3 probe: onTurnEnded / onConnectionLost 只标记 expired，不调 responder。
 *
 * ① 验证什么：turn 结束或连接断开时，所有 pending 审批被标记为 expired 且
 *    timer 清除；之后即使时间流逝，也不会向 server 发送 cancel——turn 已结束，
 *    server 不再等待审批响应，重复响应是错误的。
 * ② 缺失/错误会导致什么：终局事件若触发 responder，会对已结束的 turn 发送
 *    多余的 cancel，污染请求日志甚至影响后续 turn。
 * ③ 依据：bug spec R1——「onTurnEnded / onConnectionLost 只标记 expired，
 *    不调 responder」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../../../src/bridge/approval-coordinator.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

describe('probe: approval expiry turn end', () => {
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

  it('test_probe_turn_ended_marks_expired_without_responder', async () => {
    coordinator.onRequested(makeCommandEvent());
    coordinator.onTurnEnded();

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).not.toHaveBeenCalled();
    expect(pushToCard).not.toHaveBeenCalled();
    await expect(coordinator.submit({ action: 'accept' }, { requestId: 1001 })).rejects.toThrow(
      /state=expired/,
    );
  });

  it('test_probe_connection_lost_marks_expired_without_responder', async () => {
    coordinator.onRequested(makeCommandEvent());
    coordinator.onConnectionLost();

    vi.advanceTimersByTime(approvalTimeoutMs);

    expect(responder).not.toHaveBeenCalled();
    expect(pushToCard).not.toHaveBeenCalled();
    await expect(coordinator.submit({ action: 'accept' }, { requestId: 1001 })).rejects.toThrow(
      /state=expired/,
    );
  });
});
