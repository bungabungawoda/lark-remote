/**
 * BaseAcpTranslator: shared skeleton for the kimi / opencode ACP translators.
 *
 * Both agents' session/update notification envelopes, prompt-response
 * stopReason mapping, tool_call/tool_call_update normalization, usage_update
 * occupancy bookkeeping and self-produced turn_started events are
 * line-for-line identical — extracted here in the 2026-09 round-2
 * simplification. What genuinely diverges is the content channel:
 * kimi accumulates wire deltas into turn_diff snapshots (snapshot semantics,
 * see KimiAcpTranslator header), opencode forwards `assistant` deltas
 * directly (delta semantics) — those chunk handlers stay abstract.
 *
 * Extension points (all no-op or passthrough by default):
 *   handleAgentMessageChunk / handleAgentThoughtChunk — content channel (abstract)
 *   handleRequestPermission                           — approval rendering (abstract)
 *   handleOtherServerRequest                          — extra reverse RPC (kimi: elicitation)
 *   extractToolResultContent                          — tool_result content (default: rawOutput)
 *   onUsageSample                                     — extra usage bookkeeping (opencode: cost)
 */
import type { AgentEvent, ApprovalRequestedEvent, ResultEvent } from '../../types.js';
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
} from './protocol-types.js';
import { getLogger } from '../../../logger/index.js';

// =============================================================================
// Shared event types (consumed by runners via per-agent re-exports)
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
 * Live usage snapshot from usage_update. The ACP wire carries context
 * occupancy (`used`) and the model context window (`size`) — there is NO
 * input/output token split. input_tokens/output_tokens stay undefined so the
 * bridge falls back to per-agent transcript readback for cumulative stats.
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

// =============================================================================
// Translator base class
// =============================================================================

export abstract class BaseAcpTranslator {
  /** Logger tag, e.g. 'kimi-acp-translator'. */
  protected abstract readonly logTag: string;
  /** Current operation kind (turn vs compact). */
  private operationKind: 'turn' | 'compact' = 'turn';
  /** Live usage snapshot from usage_update events (context occupancy only). */
  protected liveUsage: AcpLiveUsage = {};
  /** Whether any usage_update has been seen this turn (no update → no usage). */
  protected hasLiveUsage = false;
  /** Session cost from usage_update cost.amount (USD). Written by opencode only. */
  protected liveCostUsd?: number;
  /** Current turn id, set by produceTurnStarted. */
  protected currentTurnId = '';

  /**
   * Handle a notification from the ACP server and return translated events.
   * Wire envelope: {sessionId, update: {sessionUpdate: '<kind>', ...}} — the
   * discriminator is `update.sessionUpdate`.
   */
  handleNotification(method: string, params: unknown): AcpTranslatorEvent[] {
    if (method !== NotificationMethod.SESSION_UPDATE) {
      return [];
    }

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
      case SessionEventType.USAGE_UPDATE:
        return this.handleUsageUpdate(update as UsageUpdateEvent);
      case SessionEventType.PLAN:
        getLogger().debug(`[${this.logTag}] discarding plan event`);
        return [];
      default:
        // Control-plane noise (command list, mode/config echoes, user replay)
        // — not content.
        return [];
    }
  }

  /**
   * Handle a server request (reverse RPC from the ACP server). Subclasses
   * hook additional methods via handleOtherServerRequest.
   */
  handleServerRequest(id: number | string, method: string, params: unknown): AcpTranslatorEvent[] {
    if (method === ServerRequestMethod.REQUEST_PERMISSION) {
      return this.handleRequestPermission(id, params as RequestPermissionParams);
    }
    return this.handleOtherServerRequest(id, method, params);
  }

  /** Hook for server requests other than session/request_permission. */
  protected handleOtherServerRequest(
    _id: number | string,
    _method: string,
    _params: unknown,
  ): AcpTranslatorEvent[] {
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
   * Translate a prompt response into a result event.
   * stopReason: end_turn → success; cancelled → interrupted (independent
   * terminal state, must NOT merge into error); anything else
   * (max_tokens / refusal / …) → error.
   */
  handlePromptResponse(sessionId: string, result: { stopReason: string }): AgentEvent {
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
      ...(this.liveCostUsd !== undefined ? { total_cost_usd: this.liveCostUsd } : {}),
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
      ...(this.liveCostUsd !== undefined ? { total_cost_usd: this.liveCostUsd } : {}),
    };
  }

  /**
   * Set the operation kind (turn vs compact).
   */
  setOperationKind(kind: 'turn' | 'compact'): void {
    this.operationKind = kind;
  }

  // =========================================================================
  // Shared notification handlers
  // =========================================================================

  /**
   * tool_call → assistant/tool_use. rawInput normalization is contractual:
   * missing → {} (lazy-create tool_call carries no rawInput field), string →
   * JSON.parse (older agents send JSON strings) — keeps the card from
   * crashing on undefined input.
   */
  protected handleToolCall(event: ToolCallEvent, _sessionId: string): AcpTranslatorEvent[] {
    let input: unknown = event.rawInput ?? {};
    if (typeof event.rawInput === 'string') {
      try {
        input = JSON.parse(event.rawInput);
      } catch {
        // Keep raw string as-is
      }
    }

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

  /**
   * tool_call_update → user/tool_result. status:'failed' → is_error:true.
   */
  protected handleToolCallUpdate(
    event: ToolCallUpdateEvent,
    _sessionId: string,
  ): AcpTranslatorEvent[] {
    const isError = event.status === 'failed';
    const content = this.extractToolResultContent(event);

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

  /**
   * tool_result content extraction. Default: rawOutput passthrough (kimi
   * semantics). opencode overrides — its rawOutput is an OBJECT
   * ({output} / {error}).
   */
  protected extractToolResultContent(event: ToolCallUpdateEvent): unknown {
    return event.rawOutput ?? '';
  }

  /**
   * usage_update → context occupancy bookkeeping. The wire shape is
   * {used, size} (+ opencode: cost:{amount}) — context occupancy, not
   * cumulative tokens.
   */
  protected handleUsageUpdate(event: UsageUpdateEvent): AcpTranslatorEvent[] {
    this.liveUsage = {
      total_tokens: event.used,
      context_limit: event.size,
    };
    this.hasLiveUsage = true;
    this.onUsageSample(event);
    return [];
  }

  /** Extra per-sample usage bookkeeping (opencode: session cost amount). */
  protected onUsageSample(_event: UsageUpdateEvent): void {}

  /**
   * ResultEvent.usage requires input_tokens/output_tokens: number, but the
   * ACP wire has no such split — the live snapshot is context occupancy only.
   * Cast is deliberate: consumers must tolerate undefined input/output.
   */
  protected liveUsageSnapshot(): ResultEvent['usage'] {
    return { ...this.liveUsage } as ResultEvent['usage'];
  }

  // =========================================================================
  // Abstract content/approval handlers
  // =========================================================================

  protected abstract handleAgentMessageChunk(
    event: AgentMessageChunkEvent,
    sessionId: string,
  ): AcpTranslatorEvent[];

  protected abstract handleAgentThoughtChunk(
    event: AgentThoughtChunkEvent,
    sessionId: string,
  ): AcpTranslatorEvent[];

  protected abstract handleRequestPermission(
    requestId: number | string,
    params: RequestPermissionParams,
  ): AcpTranslatorEvent[];
}
