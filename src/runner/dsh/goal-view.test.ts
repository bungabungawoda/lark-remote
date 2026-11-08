import { describe, expect, it } from 'vitest';
import { goalFromChange, goalFromLiveView, goalFromProjection, sameGoal } from './goal-view.js';

const snapshot = {
  id: 'goal-1',
  revision: 1,
  objective: '完成 notes-app 实时链路 MVP',
  phase: 'active',
  maxGoalRounds: 40,
};

/** 宿主投影状态的信封（`{current:{goal,roundsStarted,...},seenGoalIds,failure}`）。 */
function hostState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    current: { goal: snapshot, roundsStarted: 2, createdAt: 1, updatedAt: 2 },
    seenGoalIds: ['goal-1'],
    failure: null,
    ...overrides,
  };
}

describe('goalFromProjection', () => {
  it('reads the host-state envelope into a GoalView', () => {
    expect(goalFromProjection(hostState())).toMatchObject({
      id: 'goal-1',
      objective: '完成 notes-app 实时链路 MVP',
      phase: 'active',
      roundsStarted: 2,
      maxGoalRounds: 40,
    });
  });

  it('treats current:null as an explicit "no goal"', () => {
    expect(goalFromProjection({ current: null, seenGoalIds: [], failure: null })).toBeNull();
  });

  it('treats a missing projection value as "unknown", not "no goal"', () => {
    // 关键区别：unknown 不能驱动"卡片可以收尾"，否则会退回"任务还在跑却写完成"。
    expect(goalFromProjection(undefined)).toBeUndefined();
    expect(goalFromProjection('nonsense')).toBeUndefined();
    expect(goalFromProjection({ current: { goal: { phase: 'weird' } } })).toBeUndefined();
  });

  it('accepts the bare GoalProjection shape too', () => {
    expect(goalFromProjection({ goal: snapshot, roundsStarted: 3 })).toMatchObject({
      roundsStarted: 3,
    });
  });

  it('carries the blocked reason only while blocked', () => {
    const blocked = {
      ...snapshot,
      phase: 'blocked',
      blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit' },
    };
    expect(
      goalFromProjection(hostState({ current: { goal: blocked, roundsStarted: 40 } })),
    ).toEqual(
      expect.objectContaining({
        phase: 'blocked',
        blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit' },
      }),
    );
  });
});

describe('goalFromChange', () => {
  it('reads a full-snapshot change', () => {
    expect(
      goalFromChange({ operation: 'create', goal: snapshot, roundsStarted: 0, createdAt: 1 }),
    ).toMatchObject({ id: 'goal-1', phase: 'active', roundsStarted: 0 });
  });

  it('maps a clear tombstone to "no goal"', () => {
    expect(goalFromChange({ operation: 'clear', cleared: { id: 'goal-1' } })).toBeNull();
  });

  it('returns undefined for unreadable payloads', () => {
    expect(goalFromChange(undefined)).toBeUndefined();
    expect(goalFromChange({ operation: 'create' })).toBeUndefined();
  });
});

describe('sameGoal', () => {
  it('ignores updates that do not change what the card renders', () => {
    const a = goalFromProjection(hostState());
    const b = goalFromProjection(hostState());
    expect(sameGoal(a, b)).toBe(true);
    expect(sameGoal(a, null)).toBe(false);
  });

  it('detects round and phase changes', () => {
    const a = goalFromProjection(hostState());
    const b = goalFromProjection(
      hostState({ current: { goal: snapshot, roundsStarted: 3, createdAt: 1, updatedAt: 3 } }),
    );
    expect(sameGoal(a, b)).toBe(false);
  });

  it('detects an activation change (armed ↔ disarmed)', () => {
    // 卡片靠这一维决定「会不会自动续跑」：只改 activation 也必须重渲染。
    const armed = goalFromLiveView({ ...snapshot, roundsStarted: 2, activation: 'armed' });
    const disarmed = goalFromLiveView({ ...snapshot, roundsStarted: 2, activation: 'disarmed' });
    expect(sameGoal(armed, disarmed)).toBe(false);
  });
});

describe('goalFromLiveView', () => {
  it('reads the live view including the process-local activation', () => {
    expect(
      goalFromLiveView({
        id: 'goal-1',
        revision: 1,
        objective: '完成 notes-app 实时链路 MVP',
        phase: 'active',
        maxGoalRounds: 40,
        roundsStarted: 0,
        createdAt: 1,
        updatedAt: 2,
        activation: 'disarmed',
      }),
    ).toEqual({
      id: 'goal-1',
      objective: '完成 notes-app 实时链路 MVP',
      phase: 'active',
      roundsStarted: 0,
      maxGoalRounds: 40,
      activation: 'disarmed',
    });
  });

  it('returns undefined for "no goal" and for unreadable values', () => {
    // undefined = 读不到（调用方保持缺省，按"可能续跑"保守处理）；
    // 不能返回一个没有 activation 的 GoalView——那会被误当成「明确 disarmed」。
    expect(goalFromLiveView(undefined)).toBeUndefined();
    expect(goalFromLiveView({})).toBeUndefined();
    expect(goalFromLiveView({ ...snapshot, activation: 'weird' })).not.toHaveProperty('activation');
  });
});
