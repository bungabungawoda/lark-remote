/**
 * 审批过期后 run card 的 reducer 语义（合并自 card-render + reducer-mismatch）。
 *
 * ① 过期事件（requestId 匹配）→ approval.expired=true，run-renderer 据此渲染
 *    「⏰ 审批已过期」并隐藏按钮。
 * ② 守卫：requestId 不匹配不改；审批已 resolved（approval 已清除）时事件不复活。
 */
import { describe, expect, it } from 'vitest';
import { createInitialRunState, reduceRunState } from '../../../src/card/run-state.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

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
      command: 'mv /tmp/a.txt /tmp/b.txt',
      commandCwd: '/home/user/project',
      reason: 'Test approval',
      availableDecisions: ['accept', 'decline', 'cancel'],
    },
  };
}

describe('anchor: approval expiry reducer', () => {
  it('test_anchor_approval_expired_sets_card_expired_state', () => {
    let state = reduceRunState(createInitialRunState('run-aaa-111'), makeRequestedEvent());
    expect(state.approvals?.[0]?.expired).toBe(false);

    state = reduceRunState(state, { type: 'approval_expired', requestId: 1001 });

    expect(state.approvals?.[0]?.expired).toBe(true);
  });

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
