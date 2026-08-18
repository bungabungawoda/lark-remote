/**
 * A1 anchor: 审批过期必须推送 expired 事件到卡片。
 *
 * ① 验证什么：ApprovalCoordinator 的审批请求在 approvalTimeoutMs 到期（过期）时，
 *    向卡片推送 approval_expired 事件。
 * ② 缺失/错误会导致什么：过期事件未推送时，卡片不会显示「⏰ 审批已过期」，
 *    按钮仍可见可点击，用户可能在无效状态下误操作。
 * ③ 依据：bug spec 验收标准——「过期事件到达卡片后，run-renderer 会显示
 *    ⏰ 审批已过期并隐藏按钮」。
 *
 * 注：过期时 responder 发送 cancel + 幂等性由 idempotency-probe 覆盖；
 * responder 失败时 interruptTurn 兜底由 responder-failure-probe 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../../../src/bridge/approval-coordinator.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

describe('anchor: approval expiry pushes expired event to card', () => {
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
});
