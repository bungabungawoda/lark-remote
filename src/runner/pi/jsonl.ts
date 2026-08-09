import type { RunnerTranslator } from '../common/spawning-runner.js';
import type { AgentEvent, AssistantContent } from '../types.js';

// --- pi JSON event types (subset we care about) ---

interface PiSessionEvent {
  type: 'session';
  id: string;
  cwd: string;
  model?: string;
}

interface PiMessageStartEvent {
  type: 'message_start';
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content?: unknown[];
    model?: string;
    usage?: PiUsage;
  };
}

interface PiMessageUpdateEvent {
  type: 'message_update';
  assistantMessageEvent: {
    type:
      | 'text_start'
      | 'text_delta'
      | 'text_end'
      | 'thinking_start'
      | 'thinking_delta'
      | 'thinking_end'
      | 'toolcall_start'
      | 'toolcall_delta'
      | 'toolcall_end';
    contentIndex?: number;
    delta?: string;
    content?: string;
    toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  };
}

interface PiMessageEndEvent {
  type: 'message_end';
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content?: unknown[];
    usage?: PiUsage;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    /** pi reports provider/LLM failures via stopReason="error" + errorMessage
     * (content empty, usage zeros). e.g. "Connection error." on transient
     * provider outage. */
    stopReason?: string;
    errorMessage?: string;
  };
}

interface PiTurnEndEvent {
  type: 'turn_end';
  message?: { usage?: PiUsage };
}

interface PiAgentEndEvent {
  type: 'agent_end';
  messages?: unknown[];
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  /** Reasoning tokens (display-only, not added to total). */
  reasoning?: number;
}

type PiEvent =
  | PiSessionEvent
  | PiMessageStartEvent
  | PiMessageUpdateEvent
  | PiMessageEndEvent
  | PiTurnEndEvent
  | PiAgentEndEvent
  | { type: string };

// --- Event Normalization Accumulator ---

/** ccusage-aligned usage: pi's `input` is non-cached; cacheRead/cacheWrite map to cache read/creation. */
type PiResultUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens?: number;
};

/**
 * Accumulates pi's incremental message_update events and emits normalized
 * AgentEvents. Content mapping: text→TextContent, thinking→ThinkingContent,
 * toolCall→ToolUseContent (input:arguments), toolResult→ToolResultContent.
 *
 * Implements RunnerTranslator so the base SpawningRunner can drive it
 * uniformly. pi has no agent-reported terminal error (no equivalent of codex
 * `turn.failed`), so isTerminal/finish/getTerminalError/hasAgentTerminalError
 * are no-ops — pi relies entirely on the base class's signal/code-based
 * result event classification.
 */
export class PiEventAccumulator implements RunnerTranslator {
  private content: AssistantContent[] = [];
  private currentContentIndex = -1;
  private sessionId = '';
  /**
   * Accumulated (summed) token usage across all assistant messages in this run.
   * pi emits per-message (non-cumulative) usage on each assistant `message_end`;
   * summing yields the run's total consumption, aligned with ccusage (which sums
   * per-message entries).
   * `totalTokens` is NOT summed: it tracks the last message's total as the
   * context-length water level (summing would overcount - design.md §usage:
   * "N turn 累加得 N×context 虚假巨值").
   */
  private accInput = 0;
  private accOutput = 0;
  private accCacheRead = 0;
  private accCacheCreation = 0;
  private lastTotalTokens: number | undefined;
  /** stopReason of the most recent assistant message_end. "error" indicates a
   * provider/LLM failure (pi retries internally; a later message_end may
   * overwrite this with "stop" on eventual success). */
  private lastAssistantStopReason: string | undefined;
  /** errorMessage paired with the last assistant message_end whose
   * stopReason==="error". Surfaces the provider's failure text (e.g.
   * "Connection error.") to the user via the result event. */
  private lastAssistantErrorMessage: string | undefined;

  translate(raw: unknown): AgentEvent | null {
    return this.normalize(raw as PiEvent);
  }

  isTerminal(): boolean {
    // pi has no terminal event — agent_end is non-terminal (the process
    // continues until exit). The base class's result event is the terminal.
    return false;
  }

  finish(_reason: 'failed' | 'interrupted' | 'timeout'): void {
    // No-op: pi has no stream-ended-early terminal error to record.
    // The base class's signal/code-based result event handles all cases.
  }

  getTerminalError(): string | undefined {
    // Surface provider/LLM failures reported via stopReason="error" on the
    // final assistant message_end. pi has no other agent-reported terminal
    // error; this lets SpawningRunner produce an error result event instead
    // of a silent "success" with empty content.
    // Empty-string errorMessage is treated as missing (defensive against
    // providers that return stopReason="error" with no message) — fall back
    // to a non-empty sentinel so the run card never shows an empty error.
    if (this.lastAssistantStopReason === 'error') {
      const msg = this.lastAssistantErrorMessage;
      return msg && msg.trim() ? msg : 'pi reported an error';
    }
    return undefined;
  }

  hasAgentTerminalError(): boolean {
    // True when the most recent assistant message_end reported stopReason
    // "error" (provider/LLM failure). pi retries internally; if a later
    // message_end succeeds, lastAssistantStopReason is overwritten to "stop"
    // and this returns false — so transient retries that eventually succeed
    // are NOT misclassified as errors.
    return this.lastAssistantStopReason === 'error';
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getLastUsage(): PiResultUsage | undefined {
    if (
      this.accInput === 0 &&
      this.accOutput === 0 &&
      this.accCacheRead === 0 &&
      this.accCacheCreation === 0 &&
      this.lastTotalTokens === undefined
    ) {
      return undefined;
    }
    return {
      input_tokens: this.accInput,
      output_tokens: this.accOutput,
      cache_read_tokens: this.accCacheRead,
      cache_creation_tokens: this.accCacheCreation,
      ...(this.lastTotalTokens != null ? { total_tokens: this.lastTotalTokens } : {}),
    };
  }

  /** Accumulate a per-message usage record into the run's cumulative totals. */
  private addUsage(u: PiUsage): void {
    this.accInput += u.input ?? 0;
    this.accOutput += u.output ?? 0;
    this.accCacheRead += u.cacheRead ?? 0;
    this.accCacheCreation += u.cacheWrite ?? 0;
    if (u.totalTokens != null) {
      this.lastTotalTokens = u.totalTokens;
    }
  }

  normalize(raw: PiEvent): AgentEvent | null {
    switch (raw.type) {
      case 'session': {
        const s = raw as PiSessionEvent;
        this.sessionId = s.id;
        return {
          type: 'system',
          subtype: 'init',
          session_id: s.id,
          cwd: s.cwd,
          model: s.model ?? '',
          timestamp: new Date().toISOString(),
        };
      }

      case 'message_start': {
        const m = (raw as PiMessageStartEvent).message;
        if (m.role === 'assistant') {
          // Initialize accumulator for new assistant message
          this.content = [];
          this.currentContentIndex = -1;
        }
        return null;
      }

      case 'message_update': {
        const evt = (raw as PiMessageUpdateEvent).assistantMessageEvent;
        this.applyUpdate(evt);
        return null;
      }

      case 'message_end': {
        const m = (raw as PiMessageEndEvent).message;
        if (m.role === 'assistant') {
          // Record provider/LLM failure signal: pi emits stopReason="error"
          // with an errorMessage on transient provider outages. A subsequent
          // successful message_end (stopReason="stop" after internal retry)
          // overwrites these, so only the final state decides terminal error.
          this.lastAssistantStopReason = m.stopReason;
          if (m.stopReason === 'error') {
            this.lastAssistantErrorMessage = m.errorMessage;
          } else {
            this.lastAssistantErrorMessage = undefined;
          }
          // Emit accumulated AssistantEvent
          const event: AgentEvent = {
            type: 'assistant',
            message: { content: this.content },
            timestamp: new Date().toISOString(),
          };
          this.content = [];
          this.currentContentIndex = -1;
          // Accumulate per-message usage (ccusage-aligned: input is non-cached).
          if (m.usage) {
            this.addUsage(m.usage);
          }
          return event;
        }
        if (m.role === 'toolResult') {
          // Emit UserEvent with tool_result content
          const toolResultContent = this.normalizeToolResult(m);
          const event: AgentEvent = {
            type: 'user',
            message: { content: [toolResultContent] },
            timestamp: new Date().toISOString(),
          };
          return event;
        }
        return null;
      }

      case 'turn_end': {
        // pi 0.80+ `message_end` always carries usage; `turn_end` is a no-op.
        return null;
      }

      case 'agent_end': {
        // P2#6: do NOT emit result here — base class emits after exit-code check.
        return null;
      }

      default:
        // Ignore unknown event types (agent_start, turn_start, tool_execution_*, etc.)
        return null;
    }
  }

  private applyUpdate(evt: PiMessageUpdateEvent['assistantMessageEvent']): void {
    switch (evt.type) {
      case 'text_start':
        this.content.push({ type: 'text', text: '' });
        this.currentContentIndex++;
        break;
      case 'text_delta':
        if (
          this.currentContentIndex >= 0 &&
          this.content[this.currentContentIndex]?.type === 'text'
        ) {
          (this.content[this.currentContentIndex] as { text: string }).text += evt.delta ?? '';
        }
        break;
      case 'text_end':
        if (
          this.currentContentIndex >= 0 &&
          this.content[this.currentContentIndex]?.type === 'text' &&
          evt.content
        ) {
          (this.content[this.currentContentIndex] as { text: string }).text = evt.content;
        }
        break;
      case 'thinking_start':
        this.content.push({ type: 'thinking', thinking: '' });
        this.currentContentIndex++;
        break;
      case 'thinking_delta':
        if (
          this.currentContentIndex >= 0 &&
          this.content[this.currentContentIndex]?.type === 'thinking'
        ) {
          (this.content[this.currentContentIndex] as { thinking: string }).thinking +=
            evt.delta ?? '';
        }
        break;
      case 'thinking_end':
        if (
          this.currentContentIndex >= 0 &&
          this.content[this.currentContentIndex]?.type === 'thinking' &&
          evt.content
        ) {
          (this.content[this.currentContentIndex] as { thinking: string }).thinking = evt.content;
        }
        break;
      case 'toolcall_start':
        this.content.push({ type: 'tool_use', id: '', name: '', input: {} });
        this.currentContentIndex++;
        break;
      case 'toolcall_end':
        if (
          this.currentContentIndex >= 0 &&
          this.content[this.currentContentIndex]?.type === 'tool_use' &&
          evt.toolCall
        ) {
          this.content[this.currentContentIndex] = {
            type: 'tool_use',
            id: evt.toolCall.id,
            name: evt.toolCall.name,
            input: evt.toolCall.arguments,
          };
        }
        break;
      default:
        // toolcall_delta: pi provides complete arguments at toolcall_end, ignore delta
        break;
    }
  }

  private normalizeToolResult(msg: PiMessageEndEvent['message']): {
    type: 'tool_result';
    tool_use_id: string;
    content: unknown;
    is_error: boolean;
  } {
    return {
      type: 'tool_result',
      tool_use_id: msg.toolCallId ?? '',
      content: msg.content ?? '',
      is_error: msg.isError ?? false,
    };
  }
}
