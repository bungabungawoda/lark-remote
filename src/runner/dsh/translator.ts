/**
 * DshTranslator — maps DSH SessionEvents to AgentEvents.
 *
 * Per-turn stateful: accumulates usage from assistant/message.usage records and
 * converts assistant/chunk deltas to assistant text/thinking events.
 *
 * Mapping (task spec + DSH SessionEventMap):
 *   assistant/chunk {chunk:{type:'text-delta',text}}     → assistant text (incremental)
 *   assistant/chunk {chunk:{type:'reasoning-delta',text}} → assistant thinking (incremental)
 *   assistant/message {usage?}                            → records usage (no event)
 *   turn/end {reason.kind}                                → result:
 *       completed → success; aborted/interrupted → interrupted;
 *       blocked/error/max-tokens → error (errorMessage carries the reason)
 *
 * DSH TokenUsage: {inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?}
 *   → ResultEvent.usage: input_tokens/output_tokens/cache_read_tokens/
 *     cache_creation_tokens (cacheWrite = cache creation) + total_tokens sum.
 */

import type { AgentEvent, ResultEvent } from '../types.js';
import type {
  DshAssistantStreamFrame,
  DshSessionEvent,
  DshStreamChunk,
  DshTokenUsage,
} from './types.js';

export class DshTranslator {
  private liveUsage?: DshTokenUsage;
  private hasUsage = false;

  /** Translate one live assistant-stream chunk into AgentEvents. */
  streamFrameToAgentEvents(frame: DshAssistantStreamFrame, _sessionId: string): AgentEvent[] {
    if (frame.type !== 'chunk' || !frame.chunk) return [];
    return this.chunkToAgentEvents(frame.chunk, frame.time ?? Date.now());
  }

  private chunkToAgentEvents(chunk: DshStreamChunk, time: number): AgentEvent[] {
    if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
      this.liveUsage = chunk.usage as DshTokenUsage;
      this.hasUsage = true;
      return [];
    }
    const ts = new Date(time).toISOString();
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
      return [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: chunk.text }] },
          timestamp: ts,
        },
      ];
    }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text) {
      return [
        {
          type: 'assistant',
          message: { content: [{ type: 'thinking', thinking: chunk.text }] },
          timestamp: ts,
        },
      ];
    }
    return [];
  }

  /** Translate one session event into AgentEvents (may be empty). */
  eventToAgentEvents(ev: DshSessionEvent, sessionId: string): AgentEvent[] {
    switch (ev.type) {
      case 'assistant/chunk': {
        const chunk = ev.data.chunk as { type?: string; text?: string } | undefined;
        if (!chunk) return [];
        return this.chunkToAgentEvents(chunk as DshStreamChunk, ev.time);
      }
      case 'assistant/message': {
        const raw = ev.data.usage as DshTokenUsage | undefined;
        if (raw && typeof raw === 'object') {
          this.liveUsage = raw;
          this.hasUsage = true;
        }
        return [];
      }
      case 'turn/end': {
        const turnReason = ev.data.reason as
          { kind?: string; error?: { message?: string; name?: string } } | undefined;
        const reason = turnReason?.kind;
        const subtype =
          reason === 'completed'
            ? 'success'
            : reason === 'aborted' || reason === 'interrupted' || reason === 'forked'
              ? 'interrupted'
              : 'error';
        const result: ResultEvent = {
          type: 'result',
          subtype,
          session_id: sessionId,
          timestamp: new Date(ev.time).toISOString(),
        };
        if (this.hasUsage && this.liveUsage) {
          result.usage = mapUsage(this.liveUsage);
        }
        if (subtype === 'error') {
          const detail = turnReason?.error?.message;
          result.errorMessage = detail
            ? `turn ended with reason: ${reason}: ${detail}`
            : `turn ended with reason: ${reason}`;
        }
        return [result];
      }
      default:
        return [];
    }
  }
}

/** Map DSH TokenUsage → ResultEvent.usage (cacheWrite = cache creation). */
export function mapUsage(u: DshTokenUsage): NonNullable<ResultEvent['usage']> {
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheWrite,
    total_tokens: input + output + cacheRead + cacheWrite,
  };
}
