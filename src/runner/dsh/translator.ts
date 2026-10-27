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
 * Token accounting (ccusage 口径): DSH emits ONE usage per model
 * call (per step) — a tool-looping turn has several `assistant/message` events.
 * The result event therefore carries **the sum of the turn's samplings**, not the
 * last one (codex `token_count` has the same shape). `lastUsage` is kept only as
 * the message/stream watermark and as a fallback when no durable message usage
 * was persisted (e.g. an interrupted attempt).
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
} from '../../dsh/types.js';

/** 本 turn 各采样用量之和（input 是非缓存输入，与 ccusage/ResultEvent 口径一致）。 */
interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export class DshTranslator {
  /** 本 turn 累计用量：DSH 每次模型调用（step）一条 usage，工具往返 = 多条。 */
  private turnUsage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** 末次采样的 usage：上下文水位，或只有 live chunk 时的兜底值。 */
  private lastUsage?: DshTokenUsage;
  /** 是否收到过 durable assistant/message.usage（唯一累加来源）。 */
  private hasMessageUsage = false;
  /** 是否只收到过 live usage chunk（无 durable message usage 时的兜底）。 */
  private hasStreamUsage = false;
  /** 当前 attempt 的 id（start 帧携带，chunk 帧也带；断开重连重放时不变）。 */
  private attemptId = '0';

  /** Translate one live assistant-stream chunk into AgentEvents. */
  streamFrameToAgentEvents(frame: DshAssistantStreamFrame, _sessionId: string): AgentEvent[] {
    if (frame.type === 'start') {
      if (frame.attemptId) this.attemptId = frame.attemptId;
      return [];
    }
    if (frame.type !== 'chunk' || !frame.chunk) return [];
    return this.chunkToAgentEvents(
      frame.chunk,
      frame.time ?? Date.now(),
      frame.attemptId ?? this.attemptId,
    );
  }

  /**
   * Record durable per-step usage — the accumulation source. assistant/message
   * carries exactly one usage per model call and is seq-deduped by the client,
   * so summing it gives the turn total without double counting.
   */
  private recordMessageUsage(usage: DshTokenUsage): void {
    this.turnUsage.input += usage.inputTokens ?? 0;
    this.turnUsage.output += usage.outputTokens ?? 0;
    this.turnUsage.cacheRead += usage.cacheReadTokens ?? 0;
    this.turnUsage.cacheWrite += usage.cacheWriteTokens ?? 0;
    this.lastUsage = usage;
    this.hasMessageUsage = true;
  }

  /**
   * Record a live usage chunk. Never summed: the same step also arrives as a
   * durable assistant/message.usage, so summing both would double count. It only
   * refreshes the watermark and covers a turn whose messages never persisted.
   */
  private recordStreamUsage(usage: DshTokenUsage): void {
    this.lastUsage = usage;
    this.hasStreamUsage = true;
  }

  private chunkToAgentEvents(chunk: DshStreamChunk, time: number, attemptId = '0'): AgentEvent[] {
    if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
      this.recordStreamUsage(chunk.usage as DshTokenUsage);
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
          message: {
            content: [
              {
                type: 'thinking',
                thinking: chunk.text,
                // 同一 attempt 的同一 reasoning block：token delta 共享 itemId。
                itemId: `r:${attemptId}:${chunk.index}`,
              },
            ],
          },
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
          this.recordMessageUsage(raw);
        }
        return [];
      }
      case 'tool/call': {
        // DSH 把「模型发起调用」落成独立事件（name/arguments 是模型原始输出）。
        // 这是卡片工具行的唯一来源：assistant/message 里只有完成后的正文块，
        // 不含调用轨迹。
        const call = ev.data as { callId?: unknown; name?: unknown; arguments?: unknown };
        const id = typeof call.callId === 'string' ? call.callId : '';
        const name = typeof call.name === 'string' ? call.name : '';
        if (!id || !name) return [];
        return [
          {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id, name, input: parseToolArguments(call.arguments) }],
            },
            timestamp: new Date(ev.time).toISOString(),
          },
        ];
      }
      case 'tool/result': {
        const data = ev.data as {
          message?: { toolCallId?: unknown; content?: unknown; isError?: unknown };
          error?: unknown;
        };
        const msg = data.message;
        const toolCallId = typeof msg?.toolCallId === 'string' ? msg.toolCallId : '';
        if (!toolCallId) return [];
        return [
          {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolCallId,
                  content: toolResultText(msg?.content, data.error),
                  is_error: msg?.isError === true,
                },
              ],
            },
            timestamp: new Date(ev.time).toISOString(),
          },
        ];
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
        if (this.hasMessageUsage) {
          // 本 turn 各采样之和（多步工具往返 = 多条 assistant/message）。
          result.usage = mapAggregatedUsage(this.turnUsage);
        } else if (this.hasStreamUsage && this.lastUsage) {
          // 只有 live usage chunk（消息未落盘，如启动期中断）：退回末次采样。
          result.usage = mapUsage(this.lastUsage);
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

/**
 * Parse a `tool/call.arguments` payload (a JSON string on the wire) into the
 * object shape the card renderer consumes. Non-JSON arguments (a truncated or
 * provider-mangled payload) are kept verbatim so the header can still show
 * something instead of silently rendering an empty summary.
 */
function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

/**
 * Flatten a `tool/result.message.content` block list into display text.
 *
 * DSH content is a block array (`{type:'text',text}` / `{type:'image',...}`),
 * the same shape the LLM sees. Images collapse to a marker: the card cannot
 * render them and the raw base64 would blow the byte budget.
 */
function toolResultText(content: unknown, error?: unknown): string {
  const err = error as { message?: unknown } | undefined;
  const errorHint = typeof err?.message === 'string' ? err.message : '';
  if (content == null) return errorHint;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== 'object') continue;
      const rec = block as Record<string, unknown>;
      if (typeof rec.text === 'string') {
        parts.push(rec.text);
      } else if (rec.type === 'image') {
        parts.push('[image]');
      }
    }
    const text = parts.join('\n');
    return text || errorHint;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Map DSH TokenUsage → ResultEvent.usage (cacheWrite = cache creation). */
export function mapUsage(u: DshTokenUsage): NonNullable<ResultEvent['usage']> {
  return mapAggregatedUsage({
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheRead: u.cacheReadTokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? 0,
  });
}

/** Map a turn's summed usage → ResultEvent.usage (cacheWrite = cache creation). */
function mapAggregatedUsage(t: UsageTotals): NonNullable<ResultEvent['usage']> {
  return {
    input_tokens: t.input,
    output_tokens: t.output,
    cache_read_tokens: t.cacheRead,
    cache_creation_tokens: t.cacheWrite,
    total_tokens: t.input + t.output + t.cacheRead + t.cacheWrite,
  };
}
