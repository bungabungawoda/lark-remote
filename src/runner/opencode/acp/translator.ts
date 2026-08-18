/**
 * OpencodeAcpTranslator: translates opencode ACP session/update notifications
 * and session/request_permission server requests into AgentEvents.
 *
 * Channel choice (event contract in common/acp/protocol-types.ts header):
 * opencode's wire `content.text` IS an incremental delta
 * (opencode acp/event.ts:231-258 handlePartDelta sends `props.delta`
 * verbatim), so text/thinking chunks go straight onto the `assistant`
 * incremental channel — NO accumulation in the translator, NO turn_diff
 * snapshot. (Contrast kimi: same field is also a delta but kimi's contract
 * accumulates into turn_diff snapshots; both end with exactly one
 * concatenation in run-state, enforced by each side's seam test.)
 *
 * Event mapping (source: opencode acp/service.ts + event.ts + tool.ts,
 * dev@1c965451b5):
 *   agent_message_chunk   → assistant/text delta (content.text passthrough)
 *   agent_thought_chunk   → assistant/thinking delta (content.text passthrough)
 *   tool_call             → assistant/tool_use (rawInput object passthrough;
 *                           missing → {} per contract, string → JSON.parse)
 *   tool_call_update      → user/tool_result (status:'failed' → is_error:true;
 *                           rawOutput is an OBJECT: {output} / {error})
 *   usage_update          → live context occupancy {used, size} + cost →
 *                           {total_tokens, context_limit, total_cost_usd}
 *   available_commands_update / plan / session_info_update /
 *   current_mode_update / config_option_update / user_message_chunk → discard
 *   prompt stopReason:'end_turn'   → result success
 *   prompt stopReason:'cancelled'  → result interrupted (独立终态)
 *   prompt other stopReason/error  → result error
 *   session/request_permission     → approval_requested (optionId echo)
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
export interface OpencodeAcpTurnStartedEvent {
  type: 'turn_started';
  threadId: string;
  turnId: string;
  operationKind: 'turn' | 'compaction';
  timestamp?: string;
}

/**
 * Live usage snapshot from usage_update. The wire carries context occupancy
 * (`used`), the model context window (`size`) and session cost
 * (`cost.amount`) — there is NO input/output token split.
 */
export interface OpencodeAcpLiveUsage {
  total_tokens?: number;
  context_limit?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/** Usage update event for live token display. */
export interface OpencodeAcpUsageEvent {
  type: 'usage';
  usage: OpencodeAcpLiveUsage;
  timestamp?: string;
}

export type OpencodeAcpTranslatorEvent =
  AgentEvent | OpencodeAcpTurnStartedEvent | OpencodeAcpUsageEvent | ApprovalRequestedEvent;

// =============================================================================
// Translator
// =============================================================================

export class OpencodeAcpTranslator {
  /** Pending tool calls keyed by toolCallId (for matching tool_call_update). */
  private pendingToolCalls = new Map<string, { id: string; name: string; input: unknown }>();
  /** Current operation kind (turn vs compact). */
  private operationKind: 'turn' | 'compact' = 'turn';
  /** Live usage snapshot from usage_update events (context occupancy only). */
  private liveUsage: OpencodeAcpLiveUsage = {};
  /** Session cost from usage_update cost.amount (USD). */
  private liveCostUsd?: number;
  /** Whether any usage_update has been seen this turn (no update → no usage). */
  private hasLiveUsage = false;
  /** Current turn id, set by produceTurnStarted. */
  private currentTurnId = '';

  /**
   * Handle a notification from the ACP server and return translated events.
   */
  handleNotification(method: string, params: unknown): OpencodeAcpTranslatorEvent[] {
    if (method !== NotificationMethod.SESSION_UPDATE) {
      return [];
    }

    // Envelope: {sessionId, update: {sessionUpdate: ...}} (same as kimi).
    const notif = params as SessionUpdateNotification['params'];
    const update = notif.update;

    switch (update.sessionUpdate) {
      case SessionEventType.AGENT_MESSAGE_CHUNK:
        return this.handleAgentMessageChunk(update as AgentMessageChunkEvent);
      case SessionEventType.AGENT_THOUGHT_CHUNK:
        return this.handleAgentThoughtChunk(update as AgentThoughtChunkEvent);
      case SessionEventType.TOOL_CALL:
        return this.handleToolCall(update as ToolCallEvent);
      case SessionEventType.TOOL_CALL_UPDATE:
        return this.handleToolCallUpdate(update as ToolCallUpdateEvent);
      case SessionEventType.USAGE_UPDATE:
        return this.handleUsageUpdate(update as UsageUpdateEvent);
      case SessionEventType.PLAN:
        getLogger().debug(`[opencode-acp-translator] discarding plan event`);
        return [];
      default:
        // Control-plane noise (command list, mode/config echoes, user replay)
        // — not content.
        return [];
    }
  }

  /**
   * Handle a server request (reverse RPC from the ACP server).
   */
  handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): OpencodeAcpTranslatorEvent[] {
    if (method === ServerRequestMethod.REQUEST_PERMISSION) {
      return this.handleRequestPermission(id, params as RequestPermissionParams);
    }

    return [];
  }

  /**
   * Produce a turn_started event. Called by the runner when session/prompt
   * is sent (no wire notification for this — self-produced).
   */
  produceTurnStarted(sessionId: string, turnId: string): OpencodeAcpTurnStartedEvent {
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
   * stopReason: end_turn → success; cancelled → interrupted; anything else
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
  // Private notification handlers
  // =========================================================================

  private handleAgentMessageChunk(event: AgentMessageChunkEvent): OpencodeAcpTranslatorEvent[] {
    // opencode wire delta → assistant incremental channel directly
    // (event.ts handlePartDelta: content.text = props.delta). The reducer
    // appends assistant text — no accumulation here, no turn_diff.
    return [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: event.content.text }],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private handleAgentThoughtChunk(event: AgentThoughtChunkEvent): OpencodeAcpTranslatorEvent[] {
    return [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: event.content.text }],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private handleToolCall(event: ToolCallEvent): OpencodeAcpTranslatorEvent[] {
    // opencode pendingToolCall always carries rawInput as an object
    // (tool.ts:124-138), but the event contract requires defensive
    // normalization: missing → {} (lazy-create), string → JSON.parse.
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

  private handleToolCallUpdate(event: ToolCallUpdateEvent): OpencodeAcpTranslatorEvent[] {
    const isError = event.status === 'failed';
    const content = extractToolResultContent(event);

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

  private handleUsageUpdate(event: UsageUpdateEvent): OpencodeAcpTranslatorEvent[] {
    // opencode usage_update: {used, size, cost:{amount, currency:'USD'}}
    // (service.ts:653-663) — context occupancy + session cost, no
    // input/output split.
    this.liveUsage = {
      total_tokens: event.used,
      context_limit: event.size,
    };
    const cost = (event as { cost?: { amount?: number } }).cost;
    if (typeof cost?.amount === 'number') {
      this.liveCostUsd = cost.amount;
    }
    this.hasLiveUsage = true;
    return [];
  }

  // =========================================================================
  // Private approval handlers
  // =========================================================================

  private handleRequestPermission(
    requestId: number | string,
    params: RequestPermissionParams,
  ): OpencodeAcpTranslatorEvent[] {
    // opencode always sends a toolCall (permission.ts:62-70 — built via
    // permissionToolCall) and has no question elicitation; absent toolCall
    // is treated as unsupported and left to the runner's reject fallback.
    if (!params.toolCall) {
      getLogger().info(
        `[opencode-acp-translator] permission request without toolCall, leaving to runner fallback (requestId=${requestId})`,
      );
      return [];
    }

    const rawInput: unknown = params.toolCall.rawInput;
    const view: ApprovalView = {
      requestId,
      kind: 'command',
      command: params.toolCall.title ?? undefined,
      reason: rawInput ? truncate(stringify(rawInput), 200) : undefined,
      // §P4: 从服务端 options kind 派生——带 allow_always（或 approve_always）
      // 才提供「本会话总是允许」（acceptForSession）。
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
   * always-class option (opencode `allow_always`, kimi `approve_always`).
   */
  private deriveAvailableDecisions(params: RequestPermissionParams): string[] {
    const decisions: string[] = ['accept', 'decline', 'cancel'];
    const hasAlwaysOption = (params.options ?? []).some(
      (opt) => opt.kind === 'allow_always' || opt.kind === 'approve_always',
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
   * ResultEvent.usage nominally requires input_tokens/output_tokens, but the
   * ACP wire has no such split — the live snapshot is context occupancy only.
   * Cast is deliberate: consumers must tolerate undefined input/output.
   */
  private liveUsageSnapshot(): ResultEvent['usage'] {
    return { ...this.liveUsage } as ResultEvent['usage'];
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract a display string from a tool_call_update. opencode shapes
 * (tool.ts): completed → rawOutput {output, metadata?}; failed → rawOutput
 * {error, metadata}; in_progress → content[] with shell output snapshot.
 */
function extractToolResultContent(event: ToolCallUpdateEvent): unknown {
  const rawOutput = event.rawOutput;
  if (rawOutput && typeof rawOutput === 'object') {
    const rec = rawOutput as { output?: unknown; error?: unknown };
    if (typeof rec.output === 'string') return rec.output;
    if (typeof rec.error === 'string') return rec.error;
  }
  if (typeof rawOutput === 'string') return rawOutput;
  const content = event.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((item) => {
        const c = (item as { content?: { type?: string; text?: unknown } })?.content;
        return c?.type === 'text' && typeof c.text === 'string' ? c.text : '';
      })
      .filter((t) => t.length > 0);
    if (texts.length > 0) return texts.join('\n');
  }
  return '';
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
