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
