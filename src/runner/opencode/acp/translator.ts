/**
 * OpencodeAcpTranslator: translates opencode ACP session/update notifications
 * and session/request_permission server requests into AgentEvents.
 *
 * Extends BaseAcpTranslator (shared envelope dispatch, prompt-response
 * stopReason mapping, tool_call normalization, usage occupancy). opencode's
 * divergence from kimi is the content channel: wire `content.text` IS an
 * incremental delta (opencode acp/event.ts:231-258 handlePartDelta sends
 * `props.delta` verbatim), so text/thinking chunks go straight onto the
 * `assistant` incremental channel — NO accumulation, NO turn_diff snapshot.
 * (Contrast kimi: same field is also a delta but kimi's contract accumulates
 * into turn_diff snapshots; both end with exactly one concatenation in
 * run-state, enforced by each side's seam test.)
 *
 * Event mapping (source: opencode acp/service.ts + event.ts + tool.ts,
 * dev@1c965451b5):
 *   agent_message_chunk   → assistant/text delta (content.text passthrough)
 *   agent_thought_chunk   → assistant/thinking delta (content.text passthrough)
 *   tool_call / tool_call_update / usage_update / plan / control-plane noise →
 *                         base class (BaseAcpTranslator; opencode overrides
 *                         tool_result content extraction + session cost)
 *   prompt stopReason:'end_turn'   → result success
 *   prompt stopReason:'cancelled'  → result interrupted (独立终态)
 *   prompt other stopReason/error  → result error
 *   session/request_permission     → approval_requested (optionId echo)
 */

import type { AgentEvent, ApprovalView } from '../../types.js';
import type { ApprovalRequestedEvent } from '../../types.js';
import type {
  RequestPermissionParams,
  AgentMessageChunkEvent,
  AgentThoughtChunkEvent,
  ToolCallEvent,
  ToolCallUpdateEvent,
  UsageUpdateEvent,
} from '../../common/acp/protocol-types.js';
import {
  deriveAcpAvailableDecisions,
  truncateWithEllipsis,
} from '../../common/acp/protocol-helpers.js';
import { getLogger } from '../../../logger/index.js';
import { BaseAcpTranslator, type AcpTranslatorEvent } from '../../common/acp/base-translator.js';

// =============================================================================
// Translator
// =============================================================================

export class OpencodeAcpTranslator extends BaseAcpTranslator {
  protected readonly logTag = 'opencode-acp-translator';

  // =========================================================================
  // Content channel: wire deltas → assistant incremental channel
  // =========================================================================

  protected override handleAgentMessageChunk(
    event: AgentMessageChunkEvent,
    _sessionId: string,
  ): AcpTranslatorEvent[] {
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

  protected override handleAgentThoughtChunk(
    event: AgentThoughtChunkEvent,
    _sessionId: string,
  ): AcpTranslatorEvent[] {
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

  // =========================================================================
  // opencode-specific hooks
  // =========================================================================

  /**
   * opencode rawOutput is an OBJECT (tool.ts): completed →
   * {output, metadata?}; failed → {error, metadata}; in_progress →
   * content[] with shell output snapshot.
   */
  protected override extractToolResultContent(event: ToolCallUpdateEvent): unknown {
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

  /**
   * opencode tool args always arrive as rawInput (`XC`/`BP`), never as content
   * text. A tool_call_update's content is the shell OUTPUT snapshot (`WP`), so
   * inheriting the base args-tracking would record output as if it were the
   * command — the corruption this override prevents. Return undefined: nothing
   * to track from content (rawInput tracking in the base still applies).
   */
  protected override extractToolCallArgsText(
    _event: ToolCallEvent | ToolCallUpdateEvent,
  ): string | undefined {
    return undefined;
  }

  /**
   * opencode emits the tool_call while args are still streaming: the part is
   * created with `state:{status:'pending',input:{}}` (decompiled acp service),
   * so the initial title falls back to the tool name (e.g. `bash`) and the card
   * shows no command. The real identity arrives in later tool_call_updates:
   *   - running (`BP`): full rawInput + title = command/path
   *   - completed (`HP`): title only (no kind, no rawInput)
   * Emit a tool_use patch when either carries usable data; the reducer merges
   * it into the existing block by id. Name resolves from kind (`BP`) or the
   * name recorded at tool_call time (`HP`).
   */
  protected override buildToolUseUpdate(event: ToolCallUpdateEvent): AgentEvent | null {
    const raw = event.rawInput;
    let input: unknown = {};
    if (raw !== undefined && raw !== null) {
      if (typeof raw === 'string') {
        try {
          input = JSON.parse(raw);
        } catch {
          input = raw;
        }
      } else {
        input = raw;
      }
    }
    const inputHasKeys =
      input !== null && typeof input === 'object' && Object.keys(input as object).length > 0;
    const title =
      typeof event.title === 'string' && event.title.length > 0 ? event.title : undefined;
    if (!inputHasKeys && !title) return null;

    const kind = typeof event.kind === 'string' ? event.kind : undefined;
    const name = this.toolNameFromKind(kind) ?? this.getToolCallName(event.toolCallId) ?? '';
    const summary = title && title !== name ? title : undefined;
    return {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        content: [
          {
            type: 'tool_use',
            id: event.toolCallId,
            name,
            input: inputHasKeys ? input : {},
            ...(summary !== undefined ? { summary } : {}),
          },
        ],
      },
    };
  }

  /** opencode usage_update also carries session cost: {cost:{amount}} (USD). */
  protected override onUsageSample(event: UsageUpdateEvent): void {
    const cost = (event as { cost?: { amount?: number } }).cost;
    if (typeof cost?.amount === 'number') {
      this.liveCostUsd = cost.amount;
    }
  }

  // =========================================================================
  // Approval
  // =========================================================================

  protected override handleRequestPermission(
    requestId: number | string,
    params: RequestPermissionParams,
  ): AcpTranslatorEvent[] {
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
      reason: rawInput ? truncateWithEllipsis(stringify(rawInput), 200) : undefined,
      // §P4: 从服务端 options kind 派生——带 allow_always（或 approve_always）
      // 才提供「本会话总是允许」（acceptForSession）。
      availableDecisions: deriveAcpAvailableDecisions(params.options ?? []),
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
}

// =============================================================================
// Helpers
// =============================================================================

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
