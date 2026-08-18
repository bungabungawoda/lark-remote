/**
 * KimiAcpTranslator: translates ACP session/update notifications and
 * session/request_permission server requests into AgentEvents.
 *
 * Per-turn stateful: accumulates text/thinking deltas, tracks tool calls,
 * and produces turn_started events with operationKind.
 *
 * Wire envelope (R1, source: kimi-code packages/acp-server/src/events-map.ts,
 * verified live 2026-08-15/16 against kimi 0.36.0):
 *   session/update params = {sessionId, update: {sessionUpdate: '<kind>', ...}}
 *   — the discriminator is `update.sessionUpdate`, NOT a nested `event.type`.
 *
 * Event mapping (design doc §4.2):
 *   agent_message_chunk   → turn_diff text snapshot (content.text accumulation)
 *   agent_thought_chunk   → turn_diff reasoning snapshot (content.text accumulation)
 *   tool_call             → assistant/tool_use (rawInput object passthrough,
 *                           string → JSON.parse fallback)
 *   tool_call_update      → user/tool_result (status:'failed' → is_error:true)
 *   plan / available_commands_update / session_info_update /
 *   current_mode_update / config_option_update → discard
 *   usage_update          → live context occupancy {used, size} →
 *                           {total_tokens, context_limit}; NO input/output
 *                           split exists on the wire — cumulative token stats
 *                           fall back to wire.jsonl usage.record (dual path)
 *   prompt stopReason:'end_turn'   → result success
 *   prompt stopReason:'cancelled'  → result interrupted (独立终态)
 *   prompt other stopReason/error  → result error
 *   turn_started (self-produced)   → operationKind 'turn'/'compaction'
 *   session/request_permission     → approval_requested
 */

import type { AgentEvent, ApprovalView, ResultEvent } from '../../types.js';
import type { ApprovalRequestedEvent } from '../../types.js';
import {
  NotificationMethod,
  ServerRequestMethod,
  SessionEventType,
  type AgentMessageChunkEvent,
  type AgentThoughtChunkEvent,
  type ToolCallEvent,
  type ToolCallUpdateEvent,
  type UsageUpdateEvent,
  type SessionUpdateNotification,
  type RequestPermissionParams,
} from '../../common/acp/protocol-types.js';
import { getLogger } from '../../../logger/index.js';

// =============================================================================
// Local event types
// =============================================================================

/** Self-produced turn_started event (no wire equivalent — produced on prompt start). */
export interface AcpTurnStartedEvent {
  type: 'turn_started';
  threadId: string;
  turnId: string;
  operationKind: 'turn' | 'compaction';
  timestamp?: string;
}

/**
 * Live usage snapshot from usage_update. The wire only carries context
 * occupancy (`used`) and the model context window (`size`) — there is NO
 * input/output token split (events-map.ts:505-516). input_tokens/output_tokens
 * stay undefined so the bridge falls back to wire.jsonl usage.record for
 * cumulative token stats (R1 dual path).
 */
export interface AcpLiveUsage {
  total_tokens?: number;
  context_limit?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/** Usage update event for live token display. */
export interface AcpUsageEvent {
  type: 'usage';
  usage: AcpLiveUsage;
  timestamp?: string;
}

export type AcpTranslatorEvent =
  AgentEvent | AcpTurnStartedEvent | AcpUsageEvent | ApprovalRequestedEvent;

/**
 * Fixed snapshot item ids: ACP has exactly one text stream and one thinking
 * stream per turn (no itemId on the wire), so turn_diff snapshots use these
 * stable ids for in-place block replacement.
 */
const TEXT_ITEM_ID = 'text';
const THINKING_ITEM_ID = 'thinking';

// =============================================================================
// Translator
// =============================================================================

export class KimiAcpTranslator {
  /** Accumulated text per tool-call or message (keyed by a logical item id). */
  private textByItem = new Map<string, string>();
  /** Accumulated thinking per item. */
  private thinkingByItem = new Map<string, string>();
  /** Pending tool calls keyed by toolCallId (for matching tool_call_update). */
  private pendingToolCalls = new Map<string, { id: string; name: string; input: unknown }>();
  /** Current operation kind (turn vs compact). */
  private operationKind: 'turn' | 'compact' = 'turn';
  /** Live usage snapshot from usage_update events (context occupancy only). */
  private liveUsage: AcpLiveUsage = {};
  /** Whether any usage_update has been seen this turn (no update → no usage). */
  private hasLiveUsage = false;
  /** Current turn id, set by produceTurnStarted; carried on turn_diff events. */
  private currentTurnId = '';

  /**
   * Handle a notification from the ACP server and return translated events.
   */
  handleNotification(method: string, params: unknown): AcpTranslatorEvent[] {
    if (method !== NotificationMethod.SESSION_UPDATE) {
      return [];
    }

    // R1: real envelope is {sessionId, update: {sessionUpdate: ...}}.
    const notif = params as SessionUpdateNotification['params'];
    const update = notif.update;

    switch (update.sessionUpdate) {
      case SessionEventType.AGENT_MESSAGE_CHUNK:
        return this.handleAgentMessageChunk(update as AgentMessageChunkEvent, notif.sessionId);
      case SessionEventType.AGENT_THOUGHT_CHUNK:
        return this.handleAgentThoughtChunk(update as AgentThoughtChunkEvent, notif.sessionId);
      case SessionEventType.TOOL_CALL:
        return this.handleToolCall(update as ToolCallEvent, notif.sessionId);
      case SessionEventType.TOOL_CALL_UPDATE:
        return this.handleToolCallUpdate(update as ToolCallUpdateEvent, notif.sessionId);
      case SessionEventType.PLAN:
        getLogger().debug(`[kimi-acp-translator] discarding plan event`);
        return [];
      case SessionEventType.AVAILABLE_COMMANDS_UPDATE:
      case SessionEventType.SESSION_INFO_UPDATE:
      case SessionEventType.CURRENT_MODE_UPDATE:
      case SessionEventType.CONFIG_OPTION_UPDATE:
        // Control-plane noise (command list, mode/config echoes) — not content.
        return [];
      case SessionEventType.USAGE_UPDATE:
        return this.handleUsageUpdate(update as UsageUpdateEvent);
      default:
        return [];
    }
  }

  /**
   * Handle a server request (reverse RPC from the ACP server).
   */
  handleServerRequest(id: number | string, method: string, params: unknown): AcpTranslatorEvent[] {
    if (method === ServerRequestMethod.REQUEST_PERMISSION) {
      return this.handleRequestPermission(id, params as RequestPermissionParams);
    }

    return [];
  }

  /**
   * Produce a turn_started event. Called by the runner when session/prompt
   * is sent (no wire notification for this — self-produced).
   */
  produceTurnStarted(sessionId: string, turnId: string): AcpTurnStartedEvent {
    this.currentTurnId = turnId;
    return {
      type: 'turn_started',
      threadId: sessionId,
      turnId,
      operationKind: this.operationKind === 'compact' ? 'compaction' : 'turn',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Translate a prompt response into a result event. Carries the live usage
   * snapshot only when a usage_update was seen (otherwise undefined, so the
   * bridge falls back to wire.jsonl usage.record readback).
   */
  handlePromptResponse(sessionId: string, result: { stopReason: string }): AgentEvent {
    // §4.2: cancelled is independent terminal state, must NOT merge into error
    const subtype =
      result.stopReason === 'end_turn'
        ? 'success'
        : result.stopReason === 'cancelled'
          ? 'interrupted'
          : 'error';

    return {
      type: 'result',
      subtype,
      session_id: sessionId,
      ...(this.hasLiveUsage ? { usage: this.liveUsageSnapshot() } : {}),
      ...(subtype === 'error'
        ? { errorMessage: `Prompt ended with stopReason: ${result.stopReason}` }
        : {}),
    };
  }

  /**
   * Produce an error result event (for JSON-RPC errors during prompt).
   */
  produceErrorResult(sessionId: string, errorMessage: string): AgentEvent {
    return {
      type: 'result',
      subtype: 'error',
      session_id: sessionId,
      errorMessage,
      ...(this.hasLiveUsage ? { usage: this.liveUsageSnapshot() } : {}),
    };
  }

  /**
   * Set the operation kind (turn vs compact).
   */
  setOperationKind(kind: 'turn' | 'compact'): void {
    this.operationKind = kind;
  }

  // =========================================================================
  // Private notification handlers
  // =========================================================================

  private handleAgentMessageChunk(
    event: AgentMessageChunkEvent,
    sessionId: string,
  ): AcpTranslatorEvent[] {
    // Use a stable key for the current text stream. Kimi ACP doesn't
    // provide an itemId in agent_message_chunk; we use 'text' as the
    // single logical text accumulator (one text stream per turn).
    // R1: wire chunk text lives at content.text and is a DELTA
    // (kimi-code events-map.ts assistantDeltaToSessionUpdate:
    // content.text = event.delta), so we accumulate here into a full-text
    // snapshot and emit it as turn_diff. The card reducer's turn_diff path
    // REPLACES the block in place (snapshot semantics). Emitting the full
    // text as assistant/text (delta semantics) made the reducer append the
    // full text to itself on every chunk — duplicated card output
    // (2026-08-17 live regression, reproduced with 3 chunks).
    const key = 'text';
    const prev = this.textByItem.get(key) ?? '';
    const next = prev + event.content.text;
    this.textByItem.set(key, next);

    return [
      {
        type: 'turn_diff',
        itemId: TEXT_ITEM_ID,
        text: next,
        threadId: sessionId,
        turnId: this.currentTurnId,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private handleAgentThoughtChunk(
    event: AgentThoughtChunkEvent,
    sessionId: string,
  ): AcpTranslatorEvent[] {
    // Same delta→snapshot contract as handleAgentMessageChunk: accumulate
    // wire deltas and emit a full reasoning snapshot via turn_diff so the
    // reducer replaces the thinking block instead of appending.
    const key = THINKING_ITEM_ID;
    const prev = this.thinkingByItem.get(key) ?? '';
    const next = prev + event.content.text;
    this.thinkingByItem.set(key, next);

    return [
      {
        type: 'turn_diff',
        itemId: THINKING_ITEM_ID,
        reasoning: next,
        threadId: sessionId,
        turnId: this.currentTurnId,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private handleToolCall(event: ToolCallEvent, _sessionId: string): AcpTranslatorEvent[] {
    // rawInput arrives as an object on the wire; older kimi versions sent a
    // JSON string — parse defensively in that case. The acp-server's
    // lazy-create tool_call (first args delta, events-map.ts
    // toolCallLazyCreateToSessionUpdate) carries NO rawInput field at all —
    // normalize to an empty object so the card renders an empty args summary
    // instead of crashing on undefined input (2026-08-17 live TypeError).
    let input: unknown = event.rawInput ?? {};
    if (typeof event.rawInput === 'string') {
      try {
        input = JSON.parse(event.rawInput);
      } catch {
        // Keep raw string as-is
      }
    }

    this.pendingToolCalls.set(event.toolCallId, {
      id: event.toolCallId,
      name: event.title,
      input,
    });

    return [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: event.toolCallId,
              name: event.title,
              input,
            },
          ],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private handleToolCallUpdate(
    event: ToolCallUpdateEvent,
    _sessionId: string,
  ): AcpTranslatorEvent[] {
    // §4.2: status:'failed' → is_error:true (fixes CLI mode's is_error always false)
    const isError = event.status === 'failed';
    const content = event.rawOutput ?? '';

    return [
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: event.toolCallId,
              content,
              is_error: isError,
            },
          ],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private handleUsageUpdate(event: UsageUpdateEvent): AcpTranslatorEvent[] {
    // R1: usage_update is {sessionUpdate:'usage_update', used, size}
    // (events-map.ts:505-516) — context occupancy, not cumulative tokens.
    this.liveUsage = {
      total_tokens: event.used,
      context_limit: event.size,
    };
    this.hasLiveUsage = true;
    return [];
  }

  // =========================================================================
  // Private approval handlers
  // =========================================================================

  private handleRequestPermission(
    requestId: number | string,
    params: RequestPermissionParams,
  ): AcpTranslatorEvent[] {
    // §5.4: Question elicitation auto-respond cancelled
    if (params.isQuestion || !params.toolCall) {
      getLogger().info(
        `[kimi-acp-translator] question elicitation detected, auto-responding cancelled (requestId=${requestId})`,
      );
      return [];
    }

    const view: ApprovalView = {
      requestId,
      kind: 'command',
      command: params.toolCall?.title ?? undefined,
      reason: params.toolCall?.rawInput ? truncate(params.toolCall.rawInput, 200) : undefined,
      // §P4: 从服务端 options kind 派生——带 approve_always（或 allow_always）
      // 才提供「本会话总是允许」（acceptForSession）；否则与旧行为一致。
      availableDecisions: this.deriveAvailableDecisions(params),
    };

    return [
      {
        type: 'approval_requested',
        requestId,
        kind: 'command',
        threadId: params.sessionId,
        turnId: '',
        itemId: '',
        view,
        timestamp: new Date().toISOString(),
      } as ApprovalRequestedEvent,
    ];
  }

  /**
   * Derive the approval decision list from the server's offered options.
   * accept/decline/cancel are universal; acceptForSession requires an
   * always-class option (kimi `approve_always`, opencode `allow_always`).
   */
  private deriveAvailableDecisions(params: RequestPermissionParams): string[] {
    const decisions: string[] = ['accept', 'decline', 'cancel'];
    const hasAlwaysOption = (params.options ?? []).some(
      (opt) => opt.kind === 'approve_always' || opt.kind === 'allow_always',
    );
    if (hasAlwaysOption) {
      decisions.push('acceptForSession');
    }
    return decisions;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * ResultEvent.usage requires input_tokens/output_tokens: number, but the
   * ACP wire has no such split — the live snapshot is context occupancy only.
   * Cast is deliberate: consumers must tolerate undefined input/output (the
   * bridge's kimi path already falls back to wire.jsonl readback).
   */
  private liveUsageSnapshot(): ResultEvent['usage'] {
    return { ...this.liveUsage } as ResultEvent['usage'];
  }
}

// =============================================================================
// Helpers
// =============================================================================

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}
