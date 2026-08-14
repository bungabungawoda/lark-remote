/**
 * A3 anchor 补强: run-state reducer 对 approval_expired 的守卫语义。
 *
 * ① 验证什么：approval_expired 事件仅当 requestId 与当前审批匹配时置
 *    expired:true；不匹配不改；审批已 resolved（approval 已清除）时事件
 *    不复活审批。
 * ② 缺失/错误会导致什么：reducer 无守卫时，错位/迟到的事件会把不相干的
 *    审批标成过期，或让已结束的审批「复活」成过期态。
 * ③ 依据：bug spec R2——「仅当 requestId 与对应审批槽匹配时置 expired，
 *    不匹配不改；已 resolved 时事件不复活审批」（多槽后逐槽守卫语义不变）。
 */
import { describe, expect, it } from 'vitest';
import { createInitialRunState, reduceRunState } from '../../../src/card/run-state.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

describe('anchor: approval expiry reducer guards', () => {
  function makeRequestedEvent(requestId = 1001): ApprovalRequestedEvent {
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
        threadShort: 'th-aaa-2',
        turnShort: 'tn-222',
        workspace: '/home/user/project',
        command: 'mv /tmp/a.txt /tmp/b.txt',
        commandCwd: '/home/user/project',
        reason: 'Test approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
        pendingTotal: 1,
      },
    };
  }

  it('test_anchor_approval_expired_wrong_request_id_not_marked', () => {
    let state = reduceRunState(createInitialRunState('run-aaa-111'), makeRequestedEvent());

    state = reduceRunState(state, { type: 'approval_expired', requestId: 9999 });

    expect(state.approvals?.[0]?.expired).toBe(false);
  });

  it('test_anchor_approval_expired_after_resolved_does_not_revive', () => {
    let state = reduceRunState(createInitialRunState('run-aaa-111'), makeRequestedEvent());
    state = reduceRunState(state, { type: 'approval_resolved', requestId: 1001 });
    expect(state.approvals ?? []).toHaveLength(0);

    state = reduceRunState(state, { type: 'approval_expired', requestId: 1001 });

    expect(state.approvals ?? []).toHaveLength(0);
  });
});
