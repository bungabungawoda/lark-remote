/**
 * KimiAcpTranslator: translates ACP session/update notifications and
 * session/request_permission server requests into AgentEvents.
 *
 * Extends BaseAcpTranslator (shared envelope dispatch, prompt-response
 * stopReason mapping, tool_call normalization, usage occupancy). Kimi's
 * divergence from opencode is the content channel: per-turn stateful —
 * accumulates text/thinking deltas and emits turn_diff snapshots (NOT
 * assistant deltas — see handleAgentMessageChunk), plus question elicitation.
 *
 * Wire envelope (R1, source: kimi-code packages/acp-server/src/events-map.ts,
 * verified live 2026-08-15/16 against kimi 0.36.0):
 *   session/update params = {sessionId, update: {sessionUpdate: '<kind>', ...}}
 *   — the discriminator is `update.sessionUpdate`, NOT a nested `event.type`.
 *
 * Event mapping (design doc §4.2):
 *   agent_message_chunk   → turn_diff text snapshot (content.text accumulation)
 *   agent_thought_chunk   → turn_diff reasoning snapshot (content.text accumulation)
 *   tool_call / tool_call_update / usage_update / plan / control-plane noise →
 *                         base class (BaseAcpTranslator)
 *   prompt stopReason:'end_turn'   → result success
 *   prompt stopReason:'cancelled'  → result interrupted (独立终态)
 *   prompt other stopReason/error  → result error
 *   turn_started (self-produced)   → operationKind 'turn'/'compaction'
 *   session/request_permission     → approval_requested（含 question 桥）
 *   elicitation/create             → question approval event
 */

import type { ApprovalRequestedEvent, ApprovalView, UserQuestion } from '../../types.js';
import { makeQuestionApprovalEvent } from '../../question-common.js';
import {
  ServerRequestMethod,
  type RequestPermissionParams,
  type ElicitationCreateParams,
  type ElicitationPropertySchema,
  type ElicitationEnumOption,
  type AgentMessageChunkEvent,
  type AgentThoughtChunkEvent,
} from '../../common/acp/protocol-types.js';
import {
  deriveAcpAvailableDecisions,
  truncateWithEllipsis,
} from '../../common/acp/protocol-helpers.js';
import { getLogger } from '../../../logger/index.js';
import { BaseAcpTranslator, type AcpTranslatorEvent } from '../../common/acp/base-translator.js';

// Shared translator event types — re-exported under their established kimi
// names so runner/reader imports stay stable.
export type {
  AcpTurnStartedEvent,
  AcpLiveUsage,
  AcpUsageEvent,
  AcpTranslatorEvent,
} from '../../common/acp/base-translator.js';

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

export class KimiAcpTranslator extends BaseAcpTranslator {
  protected readonly logTag = 'kimi-acp-translator';

  /** Accumulated text per tool-call or message (keyed by a logical item id). */
  private textByItem = new Map<string, string>();
  /** Accumulated thinking per item. */
  private thinkingByItem = new Map<string, string>();

  // =========================================================================
  // Content channel: wire deltas → turn_diff snapshots
  // =========================================================================

  protected override handleAgentMessageChunk(
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
        // 卡片块锚点时间刷新为本次 diff 时间：'text' 是整轮累积流，工具间隙
        // 仍会续写增量；首见时间（如 08:39）会让标题与 move-to-end 后的位置
        // 看起来“乱序”。这里显式声明 diff 时间即块的最新写入时间。
        refreshTimestamp: true,
      },
    ];
  }

  protected override handleAgentThoughtChunk(
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
        refreshTimestamp: true,
      },
    ];
  }

  // =========================================================================
  // Approval + question elicitation
  // =========================================================================

  protected override handleRequestPermission(
    requestId: number | string,
    params: RequestPermissionParams,
  ): AcpTranslatorEvent[] {
    // §5.4 升级：question elicitation 识别（isQuestion 标记 / AskUserQuestion
    // toolCall 标题 / q{n}_opt_* 选项命名空间）→ 渲染为提问卡；无法解析的
    // 退化形态（无 toolCall 也无选项）仍返回 [] 由 runner 自动响应 cancelled。
    const toolCall = params.toolCall;
    const questionMarker =
      params.isQuestion === true ||
      toolCall?.title === 'AskUserQuestion' ||
      optionIdsMatchQuestionNamespace(params.options);
    if (questionMarker) {
      return this.handlePermissionQuestion(requestId, params);
    }
    // §5.4：无 toolCall 且无提问标记 → 无法构成审批视图，返回 [] 由 runner
    // 自动响应 cancelled（服务端不会悬挂）。
    if (!toolCall) {
      getLogger().info(
        `[kimi-acp-translator] permission request without toolCall, auto-responding cancelled (requestId=${requestId})`,
      );
      return [];
    }

    const view: ApprovalView = {
      requestId,
      kind: 'command',
      command: params.toolCall?.title ?? undefined,
      reason: params.toolCall?.rawInput
        ? truncateWithEllipsis(params.toolCall.rawInput, 200)
        : undefined,
      // §P4: 从服务端 options kind 派生——带 approve_always（或 allow_always）
      // 才提供「本会话总是允许」（acceptForSession）；否则与旧行为一致。
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

  protected override handleOtherServerRequest(
    requestId: number | string,
    method: string,
    params: unknown,
  ): AcpTranslatorEvent[] {
    if (method !== ServerRequestMethod.ELICITATION_CREATE) {
      return [];
    }
    return this.handleElicitationCreate(requestId, params as ElicitationCreateParams);
  }

  /**
   * Kimi elicitation form：requestedSchema.properties 按顺序解析为 UserQuestion[]
   * （type:array → 多选；oneOf/anyOf const → 选项 label；title → header??question）。
   * 题面完整文本只在 form 级 message 里合并出现（逐字段 title 可能只是短 header），
   * 因此 message 作为卡片概要行（view.intro）透传。
   * form 会丢弃非声明选项值 → isOther=false（卡片隐藏自定义答案输入）。
   */
  private handleElicitationCreate(
    requestId: number | string,
    params: ElicitationCreateParams,
  ): AcpTranslatorEvent[] {
    const properties = params.requestedSchema?.properties ?? {};
    const questions: UserQuestion[] = [];
    for (const [key, prop] of Object.entries(properties)) {
      const q = elicitationPropertyToQuestion(prop);
      if (!q) {
        getLogger().warn(`[kimi-acp-translator] elicitation property skipped: key=${key}`);
        continue;
      }
      questions.push(q);
    }
    if (questions.length === 0) {
      // 无法解析 → 交还 runner 自动响应（不悬挂服务端）。
      return [];
    }
    const message = params.message?.trim();
    const single = questions.length === 1;
    const intro = message && (!single || message !== questions[0]!.question) ? message : undefined;
    const event = makeQuestionApprovalEvent(requestId, questions, params.sessionId);
    if (intro) event.view.intro = intro;
    return [event];
  }

  /**
   * request_permission 兜底桥（elicitation/create 失败或旧版 kimi）：
   * 选项为 q{n}_opt_{i}（allow_once，label 直取 name）+ q{n}_skip（reject_once，
   * 跳过语义）。单题单选、无 Other（kimi 桥丢弃非声明值）。
   */
  private handlePermissionQuestion(
    requestId: number | string,
    params: RequestPermissionParams,
  ): AcpTranslatorEvent[] {
    const selectable = (params.options ?? []).filter((opt) => /^q\d+_opt_\d+$/.test(opt.optionId));
    if (selectable.length === 0) {
      getLogger().info(
        `[kimi-acp-translator] question elicitation unparseable, auto-responding cancelled (requestId=${requestId})`,
      );
      return [];
    }
    const questionText = extractQuestionText(params.toolCall);
    const questions: UserQuestion[] = [
      {
        question: questionText,
        isOther: false,
        options: selectable.map((opt) => ({ label: opt.name })),
      },
    ];
    return [makeQuestionApprovalEvent(requestId, questions, params.sessionId)];
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** elicitation schema property → UserQuestion（无法解析返回 null）。 */
function elicitationPropertyToQuestion(prop: ElicitationPropertySchema): UserQuestion | null {
  const title = prop.title?.trim();
  if (!title) return null;
  const multiSelect = prop.type === 'array';
  const rawOptions = multiSelect ? prop.items?.anyOf : prop.oneOf;
  const options = (rawOptions ?? [])
    .filter((opt): opt is ElicitationEnumOption => typeof opt?.const === 'string')
    .map((opt) => ({
      label: opt.const,
      ...(opt.description ? { description: opt.description } : {}),
    }));
  if (options.length === 0) return null;
  return {
    question: title,
    header: title,
    multiSelect,
    isOther: false,
    options,
  };
}

/** 选项命名空间是否匹配 kimi question 桥（q{n}_opt_{i} / q{n}_skip）。 */
function optionIdsMatchQuestionNamespace(options?: Array<{ optionId: string }>): boolean {
  return (options ?? []).some((opt) => /^q\d+_(opt_\d+|skip)$/.test(opt.optionId));
}

/** 从 AskUserQuestion toolCall 提取题面（content 文本优先，标题兜底）。 */
function extractQuestionText(toolCall: RequestPermissionParams['toolCall']): string {
  const content = toolCall?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = (block as { content?: { text?: string } }).content?.text;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  return toolCall?.title?.trim() || '请选择';
}
