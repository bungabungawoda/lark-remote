import type { TurnStartedEvent } from '../types.js';

export function makeTurnStartedEvent(
  sessionId: string,
  turnId: string,
  operationKind: 'turn' | 'compact',
): TurnStartedEvent {
  return {
    type: 'turn_started',
    threadId: sessionId,
    turnId,
    operationKind: operationKind === 'compact' ? 'compaction' : 'turn',
    timestamp: new Date().toISOString(),
  };
}

/**
 * 自产 turn_started 事件的完整序列：先让调用方记录 per-turn 状态，再构造事件。
 *
 * ACP（`BaseAcpTranslator`）与 pi（`PiRpcTranslator`）的 `produceTurnStarted`
 * 曾是逐字同形的两段；唯一差异是记录的字段（currentTurnId / sessionId），
 * 由 `recordState` 注入，共同序列收编在此，避免两处方法体漂移。
 */
export function produceTurnStartedEvent(
  sessionId: string,
  turnId: string,
  operationKind: 'turn' | 'compact',
  recordState: (sessionId: string, turnId: string) => void,
): TurnStartedEvent {
  recordState(sessionId, turnId);
  return makeTurnStartedEvent(sessionId, turnId, operationKind);
}
