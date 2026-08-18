/**
 * A2 anchor: 审批过期后 run card 必须进入「审批已过期」状态。
 *
 * ① 验证什么：reduceRunState 收到 approval_expired 事件（requestId 匹配当前审批）后，
 *    状态里 approval.expired 变为 true——run-renderer 据此渲染「⏰ 审批已过期」
 *    并隐藏操作按钮（approval-render.ts 已有 expired UI 分支，但无人驱动）。
 * ② 缺失/错误会导致什么：coordinator 已推送 approval_expired 事件，但 reducer 不处理则
 *    卡片仍显示可点的「✅ 允许」按钮，用户误以为还能审批，点击后静默失败（「点了允许还超时」）。
 * ③ 依据：bug spec 验收标准 B——「过期后卡片进入『审批已过期』状态，按钮不再可点」。
 */
import { describe, expect, it } from 'vitest';
import { createInitialRunState, reduceRunState } from '../../../src/card/run-state.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

describe('anchor: approval expiry card state', () => {
  function makeRequestedEvent(): ApprovalRequestedEvent {
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
        commandCwd: '/home/user/project',
        reason: 'Test approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    };
  }

  it('test_anchor_approval_expired_sets_card_expired_state', () => {
    let state = reduceRunState(createInitialRunState('run-aaa-111'), makeRequestedEvent());
    expect(state.approvals?.[0]?.expired).toBe(false);

    state = reduceRunState(state, { type: 'approval_expired', requestId: 1001 });

    expect(state.approvals?.[0]?.expired).toBe(true);
  });
});
