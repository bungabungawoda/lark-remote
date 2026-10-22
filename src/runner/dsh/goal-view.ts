/**
 * DSH `goal` 域 → 卡片用的 {@link GoalView} 解析。
 *
 * 两个来源、同一个目标类型：
 * 1. 投影值：`session/projections` 的 `values.goal` 与 `session/control` 的
 *    `{key:'goal'}` 帧，宿主状态包一层 `current`（`{current:{goal,roundsStarted
 *    ,createdAt,updatedAt},seenGoalIds,failure}`）；
 * 2. 会话事件 `goal/change`：create/edit/pause/resume/complete/block 携带完整
 *    snapshot + roundsStarted；clear 是墓碑，表示"现在没有 goal"。
 *
 * 解析失败返回 `undefined`，表示**读不懂**——它与"没有 goal"（`null`）必须区分：
 * 把读不懂当成没有 goal，就会在 goal 还在自动续跑时收尾卡片。
 */

import type { GoalView } from '../types.js';

const PHASES = new Set(['active', 'paused', 'blocked', 'complete']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseSnapshot(value: unknown, roundsStarted: unknown): GoalView | undefined {
  if (!isRecord(value)) return undefined;
  const phase = value.phase;
  if (typeof phase !== 'string' || !PHASES.has(phase)) return undefined;
  if (typeof value.objective !== 'string') return undefined;
  if (typeof value.id !== 'string' || value.id.length === 0) return undefined;
  const max = nonNegativeInt(value.maxGoalRounds);
  if (max === undefined) return undefined;

  const reason = value.blockedReason;
  const blockedReason =
    isRecord(reason) && typeof reason.code === 'string' && typeof reason.message === 'string'
      ? { code: reason.code, message: reason.message }
      : undefined;

  return {
    id: value.id,
    objective: value.objective,
    // 上面已按白名单校验，这里收窄回联合类型。
    phase: phase as GoalView['phase'],
    roundsStarted: nonNegativeInt(roundsStarted) ?? 0,
    maxGoalRounds: max,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

/**
 * 解析投影里的 goal 状态。
 *
 * @returns `GoalView` = 有 goal；`null` = 宿主明确没有 goal；`undefined` = 读不懂。
 */
export function goalFromProjection(value: unknown): GoalView | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  // 宿主状态信封：{current:{goal,roundsStarted,...}, seenGoalIds, failure}
  if ('current' in value) {
    const current = value.current;
    if (current === null) return null;
    if (!isRecord(current)) return undefined;
    if (current.goal === undefined || current.goal === null) return null;
    return parseSnapshot(current.goal, current.roundsStarted);
  }

  // 兼容直接投递 GoalProjection 的形态：{goal, roundsStarted, ...}
  if (value.goal === undefined || value.goal === null) return null;
  return parseSnapshot(value.goal, value.roundsStarted);
}

/**
 * 解析 `goal/change` 事件 payload。
 *
 * @returns `GoalView` = 变更后的 goal；`null` = clear（现在没有 goal）；
 *   `undefined` = 读不懂。
 */
export function goalFromChange(data: unknown): GoalView | null | undefined {
  if (!isRecord(data)) return undefined;
  if (data.operation === 'clear') return null;
  if (typeof data.operation !== 'string') return undefined;
  return parseSnapshot(data.goal, data.roundsStarted);
}

/** 便利构造：把解析结果包成 runner 事件。 */
export function goalStateEvent(
  goal: GoalView | null,
  known: boolean,
): {
  type: 'goal_state';
  goal: GoalView | null;
  known: boolean;
  timestamp: string;
} {
  return { type: 'goal_state', goal, known, timestamp: new Date().toISOString() };
}

/** 两次观测是否等价（用于抑制重复帧，不触发重渲染）。 */
export function sameGoal(a: GoalView | null | undefined, b: GoalView | null | undefined): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return (
    a.id === b.id &&
    a.phase === b.phase &&
    a.roundsStarted === b.roundsStarted &&
    a.maxGoalRounds === b.maxGoalRounds &&
    a.objective === b.objective &&
    a.blockedReason?.code === b.blockedReason?.code
  );
}
