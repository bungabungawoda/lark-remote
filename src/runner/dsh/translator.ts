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

/**
 * 每个 DshTranslator 实例持有的一份可变 turn 状态。
 * 事件 handler 都是模块级命名函数、显式接收 state：决策点不堆在类方法里，
 * 也不存在 `this` 绑定丢失的风险。
 */
interface TurnState {
  /** 本 turn 累计用量：DSH 每次模型调用（step）一条 usage，工具往返 = 多条。 */
  turnUsage: UsageTotals;
  /** 末次采样的 usage：上下文水位，或只有 live chunk 时的兜底值。 */
  lastUsage?: DshTokenUsage;
  /** 是否收到过 durable assistant/message.usage（唯一累加来源）。 */
  hasMessageUsage: boolean;
  /** 是否只收到过 live usage chunk（无 durable message usage 时的兜底）。 */
  hasStreamUsage: boolean;
  /** 当前 attempt 的 id（start 帧携带，chunk 帧也带；断开重连重放时不变）。 */
  attemptId: string;
  /**
   * 本 turn 末条 durable assistant 消息的正文（**完整**、未截断）。
   *
   * live chunk 是逐 delta 拼接、会被状态层的 MAX_TEXT_CHARS 窗口截断；
   * durable `assistant/message` 一次就到齐全文。收 turn 时把它挂在 result 上，
   * 卡片才能渲染完整回答。
   */
  lastMessageText?: string;
}

function newTurnState(): TurnState {
  return {
    turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    hasMessageUsage: false,
    hasStreamUsage: false,
    attemptId: '0',
  };
}

// --- 模块级状态操作原语 ---

/**
 * Record durable per-step usage — the accumulation source. assistant/message
 * carries exactly one usage per model call and is seq-deduped by the client,
 * so summing it gives the turn total without double counting.
 */
function recordMessageUsage(state: TurnState, usage: DshTokenUsage): void {
  state.turnUsage.input += usage.inputTokens ?? 0;
  state.turnUsage.output += usage.outputTokens ?? 0;
  state.turnUsage.cacheRead += usage.cacheReadTokens ?? 0;
  state.turnUsage.cacheWrite += usage.cacheWriteTokens ?? 0;
  state.lastUsage = usage;
  state.hasMessageUsage = true;
}

/**
 * Record a live usage chunk. Never summed: the same step also arrives as a
 * durable assistant/message.usage, so summing both would double count. It only
 * refreshes the watermark and covers a turn whose messages never persisted.
 */
function recordStreamUsage(state: TurnState, usage: DshTokenUsage): void {
  state.lastUsage = usage;
  state.hasStreamUsage = true;
}

function chunkToAgentEvents(
  state: TurnState,
  chunk: DshStreamChunk,
  time: number,
  attemptId = '0',
): AgentEvent[] {
  if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
    recordStreamUsage(state, chunk.usage as DshTokenUsage);
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

/** Translate one live assistant-stream chunk into AgentEvents. */
function translateStreamFrame(
  state: TurnState,
  frame: DshAssistantStreamFrame,
  _sessionId: string,
): AgentEvent[] {
  if (frame.type === 'start') {
    if (frame.attemptId) state.attemptId = frame.attemptId;
    return [];
  }
  if (frame.type !== 'chunk' || !frame.chunk) return [];
  return chunkToAgentEvents(
    state,
    frame.chunk,
    frame.time ?? Date.now(),
    frame.attemptId ?? state.attemptId,
  );
}

// --- 模块级会话事件 handler（Map 查表 + 显式传 state） ---
type SessionEventHandler = (
  state: TurnState,
  ev: DshSessionEvent,
  sessionId: string,
) => AgentEvent[];

function handleAssistantChunk(
  state: TurnState,
  ev: DshSessionEvent,
  _sessionId: string,
): AgentEvent[] {
  const chunk = ev.data.chunk as { type?: string; text?: string } | undefined;
  if (!chunk) return [];
  return chunkToAgentEvents(state, chunk as DshStreamChunk, ev.time);
}

function handleAssistantMessage(
  state: TurnState,
  ev: DshSessionEvent,
  _sessionId: string,
): AgentEvent[] {
  const raw = ev.data.usage as DshTokenUsage | undefined;
  if (raw && typeof raw === 'object') {
    recordMessageUsage(state, raw);
  }
  // 每条 durable 消息都带完整正文；记最后一条非空的就是本轮回答。
  const text = messageText(ev.data.message);
  if (text.trim()) state.lastMessageText = text;
  return [];
}

function handleToolCall(_state: TurnState, ev: DshSessionEvent, _sessionId: string): AgentEvent[] {
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

function handleToolResult(
  _state: TurnState,
  ev: DshSessionEvent,
  _sessionId: string,
): AgentEvent[] {
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

function handleTurnEnd(state: TurnState, ev: DshSessionEvent, sessionId: string): AgentEvent[] {
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
  if (state.hasMessageUsage) {
    // 本 turn 各采样之和（多步工具往返 = 多条 assistant/message）。
    result.usage = mapAggregatedUsage(state.turnUsage);
  } else if (state.hasStreamUsage && state.lastUsage) {
    // 只有 live usage chunk（消息未落盘，如启动期中断）：退回末次采样。
    result.usage = mapUsage(state.lastUsage);
  }
  if (subtype === 'error') {
    const detail = turnReason?.error?.message;
    result.errorMessage = detail
      ? `turn ended with reason: ${reason}: ${detail}`
      : `turn ended with reason: ${reason}`;
  }
  if (state.lastMessageText) {
    result.finalAnswerText = state.lastMessageText;
  }
  return [result];
}

/** 事件类型 → handler。用 Map 而非对象字面量，避免 prototype 键命中。 */
const SESSION_EVENT_HANDLERS = new Map<string, SessionEventHandler>([
  ['assistant/chunk', handleAssistantChunk],
  ['assistant/message', handleAssistantMessage],
  ['tool/call', handleToolCall],
  ['tool/result', handleToolResult],
  ['turn/end', handleTurnEnd],
]);

export class DshTranslator {
  private readonly state = newTurnState();

  /** Translate one live assistant-stream chunk into AgentEvents. */
  streamFrameToAgentEvents(frame: DshAssistantStreamFrame, _sessionId: string): AgentEvent[] {
    return translateStreamFrame(this.state, frame, _sessionId);
  }

  /** Translate one session event into AgentEvents (may be empty). */
  eventToAgentEvents(ev: DshSessionEvent, sessionId: string): AgentEvent[] {
    const handler = SESSION_EVENT_HANDLERS.get(ev.type);
    return handler ? handler(this.state, ev, sessionId) : [];
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
 * 取 `assistant/message.message.content` 里的正文（type==='text' 的块）。
 *
 * 只收 text 块：reasoning 走独立面板（且另有 4000 字符窗口），tool-call 由
 * `tool/call` 事件承载。块之间直接拼接、不插分隔符——同一条消息里的多个 text
 * 块本来就是一段连续回答。
 */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === 'text' && typeof rec.text === 'string') parts.push(rec.text);
  }
  return parts.join('');
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
