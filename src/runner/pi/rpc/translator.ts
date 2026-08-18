/**
 * PiRpcTranslator: maps pi RPC events into AgentEvents for the PiRpcRunner.
 *
 * Content mapping accumulates pi's incremental message_start/update/end events
 * into assistant/user events with text/thinking/tool content, and drives the
 * turn lifecycle differently:
 *   - `prompt` is fire-and-ack, so the runner produces a `result` on the
 *     `agent_settled` event (turn completion), not on a prompt response.
 *   - `compact` returns a response at completion; the runner produces the
 *     `result` from that response.
 *   - `agent_settled` is ignored for compaction turns (no double result).
 */

import type { AgentEvent, AssistantContent, ResultEvent } from '../../types.js';
import {
  type PiRpcEvent,
  type PiRpcMessageEndEvent,
  type PiRpcMessageStartEvent,
  type PiRpcMessageUpdateEvent,
  type PiRpcResponse,
  type PiRpcUsage,
} from './protocol-types.js';

export interface PiRpcTurnStartedEvent {
  type: 'turn_started';
  threadId: string;
  turnId: string;
  operationKind: 'turn' | 'compaction';
  timestamp?: string;
}

export type PiRpcTranslatorEvent = AgentEvent | PiRpcTurnStartedEvent;

export class PiRpcTranslator {
  private content: AssistantContent[] = [];
  private currentContentIndex = -1;
  private sessionId = '';
  private operationKind: 'turn' | 'compact' = 'turn';
  private currentTurnId = '';

  // ccusage-aligned usage accumulation (per-message, summed across the turn).
  private accInput = 0;
  private accOutput = 0;
  private accCacheRead = 0;
  private accCacheCreation = 0;
  private lastTotalTokens: number | undefined;
  private hasUsage = false;

  /** Provider failure (stopReason="error") on the final assistant message. */
  private lastAssistantStopReason: string | undefined;
  private lastAssistantErrorMessage: string | undefined;

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  setOperationKind(kind: 'turn' | 'compact'): void {
    this.operationKind = kind;
  }

  getUsage(): ResultEvent['usage'] | undefined {
    if (
      !this.hasUsage &&
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

  /** Translate an incoming pi RPC event into AgentEvents to push. */
  handleEvent(evt: PiRpcEvent): PiRpcTranslatorEvent[] {
    switch (evt.type) {
      case 'session': {
        const s = evt as { type: 'session'; id: string; cwd: string; model?: string };
        this.sessionId = s.id;
        return [
          {
            type: 'system',
            subtype: 'init',
            session_id: s.id,
            cwd: s.cwd,
            model: s.model ?? '',
            timestamp: new Date().toISOString(),
          },
        ];
      }
      case 'message_start': {
        const m = (evt as PiRpcMessageStartEvent).message;
        if (m.role === 'assistant') {
          this.content = [];
          this.currentContentIndex = -1;
        }
        return [];
      }
      case 'message_update': {
        this.applyUpdate((evt as PiRpcMessageUpdateEvent).assistantMessageEvent);
        return [];
      }
      case 'message_end': {
        return this.handleMessageEnd(evt as PiRpcMessageEndEvent);
      }
      case 'agent_settled': {
        // Normal-turn completion signal. Compaction turns finish via the
        // compact response, not agent_settled.
        if (this.operationKind === 'turn') {
          return [this.produceResultFromSettled()];
        }
        return [];
      }
      default:
        // turn_start/turn_end, agent_start/agent_end, compaction_start/end,
        // tool_execution_*, and unknown types are ignored.
        return [];
    }
  }

  /** Self-produced turn_started (no wire equivalent). */
  produceTurnStarted(sessionId: string, turnId: string): PiRpcTurnStartedEvent {
    this.sessionId = sessionId;
    this.currentTurnId = turnId;
    return {
      type: 'turn_started',
      threadId: sessionId,
      turnId,
      operationKind: this.operationKind === 'compact' ? 'compaction' : 'turn',
      timestamp: new Date().toISOString(),
    };
  }

  /** Result for a completed normal turn (agent_settled). */
  produceResultFromSettled(): AgentEvent {
    const usage = this.getUsage();
    return {
      type: 'result',
      subtype: this.lastAssistantStopReason === 'error' ? 'error' : 'success',
      session_id: this.sessionId,
      ...(this.lastAssistantStopReason === 'error'
        ? { errorMessage: this.lastAssistantErrorMessage?.trim() || 'pi reported an error' }
        : {}),
      ...(usage ? { usage } : {}),
    };
  }

  /** Result from a compact command response (completion signal for compaction). */
  produceCompactResult(sessionId: string, response: PiRpcResponse): AgentEvent {
    if (response.success) {
      return {
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
      };
    }
    return {
      type: 'result',
      subtype: 'error',
      session_id: sessionId,
      errorMessage: response.error,
    };
  }

  /** Error result (for setup/request failures). */
  produceErrorResult(sessionId: string, errorMessage: string): AgentEvent {
    return {
      type: 'result',
      subtype: 'error',
      session_id: sessionId,
      errorMessage,
    };
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private handleMessageEnd(evt: PiRpcMessageEndEvent): PiRpcTranslatorEvent[] {
    const m = evt.message;
    if (m.role === 'assistant') {
      this.lastAssistantStopReason = m.stopReason;
      this.lastAssistantErrorMessage = m.stopReason === 'error' ? m.errorMessage : undefined;
      if (m.usage) this.addUsage(m.usage);
      const event: AgentEvent = {
        type: 'assistant',
        message: { content: this.content },
        timestamp: new Date().toISOString(),
      };
      this.content = [];
      this.currentContentIndex = -1;
      return [event];
    }
    if (m.role === 'toolResult') {
      return [
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.toolCallId ?? '',
                content: m.content ?? '',
                is_error: m.isError ?? false,
              },
            ],
          },
          timestamp: new Date().toISOString(),
        },
      ];
    }
    return [];
  }

  private addUsage(u: PiRpcUsage): void {
    this.hasUsage = true;
    this.accInput += u.input ?? 0;
    this.accOutput += u.output ?? 0;
    this.accCacheRead += u.cacheRead ?? 0;
    this.accCacheCreation += u.cacheWrite ?? 0;
    if (u.totalTokens != null) this.lastTotalTokens = u.totalTokens;
  }

  private applyUpdate(evt: PiRpcMessageUpdateEvent['assistantMessageEvent']): void {
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
        // toolcall_delta: pi provides complete arguments at toolcall_end, ignore.
        break;
    }
  }
}
