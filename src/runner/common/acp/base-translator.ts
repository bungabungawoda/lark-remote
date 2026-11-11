/**
 * BaseAcpTranslator: shared skeleton for the kimi / opencode ACP translators.
 *
 * Both agents' session/update notification envelopes, prompt-response
 * stopReason mapping, tool_call/tool_call_update normalization, usage_update
 * occupancy bookkeeping and self-produced turn_started events are
 * line-for-line identical — extracted here in the round-2
 * simplification. What genuinely diverges is the content channel:
 * kimi accumulates wire deltas into turn_diff snapshots (snapshot semantics,
 * see KimiAcpTranslator header), opencode / codebuddy forward `assistant`
 * deltas directly — that is the DEFAULT handleAgentMessageChunk here; kimi
 * overrides it. thought chunks stay abstract (codebuddy reads the block id
 * from `_meta['codebuddy.ai/messageId']`).
 *
 * Extension points (all no-op or passthrough by default):
 *   handleAgentMessageChunk  — assistant text delta (default; kimi overrides)
 *   handleAgentThoughtChunk  — thinking delta (abstract)
 *   handleRequestPermission  — approval rendering (abstract)
 *   handleOtherServerRequest                          — extra reverse RPC (kimi: elicitation)
 *   extractToolResultContent                          — tool_result content (default: rawOutput)
 *   extractToolCallArgsText                           — streaming-args source (opencode: none)
 *   buildToolUseUpdate                                — tool_use patch from tool_call_update
 *   onUsageSample                                     — extra usage bookkeeping (opencode: cost)
 */
import type {
  AgentEvent,
  ApprovalRequestedEvent,
  ApprovalView,
  ResultEvent,
  SessionInfoEvent,
  TurnStartedEvent,
  UserQuestion,
} from '../../types.js';
import { makeQuestionApprovalEvent } from '../../question-common.js';
import { produceTurnStartedEvent } from '../turn-started.js';
import { truncateWithEllipsis } from './acp-approval.js';
import {
  describePromptError,
  isAuthenticationFailure,
  isPromptAuthenticationFailure,
  type PromptErrorDetail,
} from './prompt-error.js';
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
  type ElicitationCreateParams,
  type ElicitationPropertySchema,
  type SessionPromptResult,
  type AcpPlanEvent,
  type SessionInfoUpdateEvent,
  type CurrentModeUpdateEvent,
} from './protocol-types.js';
import { getLogger } from '../../../logger/index.js';

/**
 * ACP tool kind → 常用工具名映射（信息保真，数据驱动无 agent 分支）。
 * kind 命中映射时用映射名渲染结构化面板；否则回落 title（维持现状）。
 */
const KIND_TO_TOOL: Record<string, string> = {
  execute: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  search: 'Grep',
  fetch: 'WebFetch',
};

/**
 * Plan 条目 status → 渲染图标。未知/缺省 status 一律按 pending 渲染——
 * 两处调用点（ACP handlePlan / codex handleTurnPlanUpdated）注释都点名防
 * wire 枚举漂移，新增枚举值时只改这张表。
 */
const PLAN_STATUS_ICONS = {
  completed: '✅',
  in_progress: '🔄',
  pending: '⬜',
  error: '❌',
} as const;
type PlanIconStatus = keyof typeof PLAN_STATUS_ICONS;

/**
 * Plan entries → 「图标 + 标题」markdown 清单（每行一条，`\n` join）。
 * ACP 与 codex 双抄收编（R5）；subtitle 拼接、trim、空清单语义等差异留在
 * 各自调用点。
 */
export function renderPlanMarkdown(
  entries: ReadonlyArray<{ title: string; subtitle?: string; status?: string }>,
): string {
  return entries
    .map((entry) => {
      const status: PlanIconStatus =
        entry.status && entry.status in PLAN_STATUS_ICONS
          ? (entry.status as PlanIconStatus)
          : 'pending';
      return `${PLAN_STATUS_ICONS[status]} ${entry.title}${entry.subtitle ? ` — ${entry.subtitle}` : ''}`;
    })
    .join('\n');
}

/**
 * Join the text payloads of a tool_call(/_update) content array
 * (`[{type:'content', content:{type:'text', text}}]` entries). Returns
 * undefined when no text entry exists (diff/terminal-only content).
 */
function extractToolCallContentText(content: unknown[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  let text = '';
  let found = false;
  for (const entry of content) {
    const e = entry as { type?: string; content?: { type?: string; text?: unknown } } | null;
    if (e?.type === 'content' && e.content?.type === 'text' && typeof e.content.text === 'string') {
      text += e.content.text;
      found = true;
    }
  }
  return found ? text : undefined;
}

/**
 * agent_message_chunk / agent_thought_chunk 的 content 文本提取。
 *
 * 契约形状是对象 `{type:'text', text}`。CodeBuddy 的 compact 广播
 * （`_meta['codebuddy.ai/isCompactInternal']`）把 content 发成数组
 * `[{type:'text', text}]`——translator 直接取 `.text` 得到 undefined，
 * 进 run-state 后成为 `content: undefined` 的 text 块，卡片截断层
 * `Buffer.byteLength(undefined)` 抛 TypeError 并经 fatal 通道退出进程。
 * 不符合契约的帧一律丢弃。
 */
function acpChunkText(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return undefined;
  const text = (content as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * Best-effort stringify for tracked rawInput objects (never throws).
 * 导出供各 translator 的审批 reason 复用（opencode / codebuddy 原各有一份
 * 逐字相同的本地 stringify）。
 */
export function acpStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * tool_result rawOutput 的文本提取兜底链：对象取 `.text` 字符串、字符串原样、
 * 其余空串。codebuddy/qoder 的 tool_result 形状口径（qoder 沿用 codebuddy
 * 已验证的链，两份覆写原来逐字相同）。
 */
export function textFromRawOutput(rawOutput: unknown): unknown {
  if (rawOutput && typeof rawOutput === 'object') {
    const text = (rawOutput as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  if (typeof rawOutput === 'string') return rawOutput;
  return '';
}

/**
 * 审批 reason（codebuddy/qoder 同款）：优先 rawInput.description，
 * 否则 rawInput 序列化后截断到 200 兜底；最终统一再截断到 200。
 */
export function approvalReasonFrom(rawInput: Record<string, unknown>): string | undefined {
  const reason =
    (typeof rawInput.description === 'string' && rawInput.description) ||
    (Object.keys(rawInput).length > 0
      ? truncateWithEllipsis(acpStringify(rawInput), 200)
      : undefined);
  return reason ? truncateWithEllipsis(reason, 200) : undefined;
}

/**
 * 审批卡片 command 候选回退链 + 300 字截断（codebuddy/qoder 同款）。
 * 真机形状：Bash rawInput={command,description}、Read rawInput={file_path,limit}；
 * 卡片 command 列优先真实命令/文件路径（title 是带反引号的 shell 呈现串），
 * qoder 无 toolName 兜底（传 undefined 即可）。
 */
export function approvalCommandFrom(
  rawInput: Record<string, unknown>,
  title: string | undefined,
  toolName?: string | undefined,
): string | undefined {
  const command =
    (typeof rawInput.command === 'string' && rawInput.command) ||
    (typeof rawInput.file_path === 'string' && rawInput.file_path) ||
    title ||
    toolName ||
    undefined;
  return command ? truncateWithEllipsis(command, 300) : undefined;
}

/**
 * 记录最新值并给 map 封顶（删最老 key，近似 LRU）。
 * `trackToolCallArgs` 与 `trackToolCallName` 曾是逐字相同的两段，合并到这里。
 */
function trackBounded(map: Map<string, string>, key: string, value: string): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 100) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

// =============================================================================
// Shared event types (consumed by runners via per-agent re-exports)
// =============================================================================

/** Self-produced turn_started event (no wire equivalent — produced on prompt start). */
type AcpTurnStartedEvent = TurnStartedEvent;

/**
 * Live usage snapshot from usage_update. The ACP wire carries context
 * occupancy (`used`) and the model context window (`size`) — there is NO
 * input/output token split. input_tokens/output_tokens stay undefined so the
 * bridge falls back to per-agent transcript readback for cumulative stats.
 */
interface AcpLiveUsage {
  total_tokens?: number;
  context_limit?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/** Usage update event for live token display. */
interface AcpUsageEvent {
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
  /** Current turn id, set by produceTurnStarted. */
  protected currentTurnId = '';

  /**
   * Latest streaming-args text per tool call (keyed by wire toolCallId).
   * kimi ACP sends the permission request BEFORE tool.call.started (verified
   * against kimi 0.42.0): the request_permission toolCall
   * carries only title + a truncated summary in content, NO rawInput — the
   * full args only ever reach the client as accumulated text in the
   * tool_call/tool_call_update streaming deltas. Tracking them here lets the
   * approval handler correlate by toolCallId and recover the real command.
   */
  private toolCallArgsByCallId = new Map<string, string>();

  /**
   * tool_use name recorded at tool_call time (kind mapping wins, else title).
   * A later tool_call_update may carry only a title (opencode's completed
   * update has neither kind nor rawInput); pairing it with the recorded name
   * lets a tool_use patch render the original title as a subtitle.
   */
  private toolCallNameByCallId = new Map<string, string>();

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

    // 文本类 chunk 帧先验 content 形状（见 acpChunkText）：数组/缺失 text 的
    // 帧在这里丢弃，不让 undefined 流进 run-state。
    if (
      (update.sessionUpdate === SessionEventType.AGENT_MESSAGE_CHUNK ||
        update.sessionUpdate === SessionEventType.AGENT_THOUGHT_CHUNK) &&
      acpChunkText((update as { content?: unknown }).content) === undefined
    ) {
      getLogger().warn(
        `[${this.logTag}] dropped ${update.sessionUpdate} without object content.text`,
      );
      return [];
    }

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
        return this.handlePlan(update as AcpPlanEvent);
      case SessionEventType.SESSION_INFO_UPDATE: {
        // 会话标题更新 → session_info 事件（title 缺省时不发，避免空事件噪声）。
        const info = update as SessionInfoUpdateEvent;
        if (!info.title) return [];
        const event: SessionInfoEvent = {
          type: 'session_info',
          title: info.title,
          timestamp: new Date().toISOString(),
        };
        return [event];
      }
      case SessionEventType.CURRENT_MODE_UPDATE: {
        // 模式切换 → session_info 事件（mode 字段）。
        const mode = update as CurrentModeUpdateEvent;
        const event: SessionInfoEvent = {
          type: 'session_info',
          mode: mode.currentModeId,
          timestamp: new Date().toISOString(),
        };
        return [event];
      }
      default:
        // Control-plane noise (config echoes, user replay) — not content.
        // available_commands_update / config_option_update 维持丢弃：
        // 控制面回显，无用户价值。
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

  /**
   * Hook for server requests other than session/request_permission.
   * 默认只路由 elicitation/create（AskUserQuestion form）；其他扩展方法
   * （codebuddy 的 `_codebuddy.ai/*` 等）由子类整体覆写本钩子处理。
   */
  protected handleOtherServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): AcpTranslatorEvent[] {
    if (method === ServerRequestMethod.ELICITATION_CREATE) {
      return this.handleElicitationCreate(id, params as ElicitationCreateParams);
    }
    return [];
  }

  /**
   * elicitation/create（AskUserQuestion form）默认不处理：返回空数组交还
   * runner 自动兜底（不悬挂服务端）。支持 form 的 agent（kimi/qoder）覆写
   * 本钩子，用 buildElicitationQuestionEvent 承载公共脚手架。
   */
  protected handleElicitationCreate(
    _requestId: number | string,
    _params: ElicitationCreateParams,
  ): AcpTranslatorEvent[] {
    return [];
  }

  /**
   * elicitation form 公共脚手架（kimi/qoder 原两份逐字相同，仅属性解析器
   * 与日志前缀不同）：requestedSchema.properties 按顺序经 toQuestion 解析
   * 为 UserQuestion[]，解析失败的逐题 warn 跳过；全失败返回 []（交还
   * runner 自动兜底）；form 级 message 作为卡片概要行（view.intro）透传，
   * 单题且 message 与题面相同时不重复。isOther=false 由各 parser 决定
   * （form 只接受声明选项，卡片隐藏自定义答案输入）。
   */
  protected buildElicitationQuestionEvent(
    requestId: number | string,
    params: ElicitationCreateParams,
    toQuestion: (prop: ElicitationPropertySchema) => UserQuestion | null,
  ): AcpTranslatorEvent[] {
    const properties = params.requestedSchema?.properties ?? {};
    const questions: UserQuestion[] = [];
    for (const [key, prop] of Object.entries(properties)) {
      const q = toQuestion(prop);
      if (!q) {
        getLogger().warn(`[${this.logTag}] elicitation property skipped: key=${key}`);
        continue;
      }
      questions.push(q);
    }
    if (questions.length === 0) {
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
   * Produce a turn_started event. Called by the runner when session/prompt
   * is sent (no wire notification for this — self-produced).
   */
  produceTurnStarted(sessionId: string, turnId: string): AcpTurnStartedEvent {
    return produceTurnStartedEvent(sessionId, turnId, this.operationKind, (_sessionId, t) => {
      this.currentTurnId = t;
    });
  }

  protected approvalRequestedEvents(
    requestId: number | string,
    sessionId: string,
    view: ApprovalView,
  ): ApprovalRequestedEvent[] {
    return [
      {
        type: 'approval_requested',
        requestId,
        kind: 'command',
        threadId: sessionId,
        turnId: '',
        itemId: '',
        view,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  /**
   * Translate a prompt response into a result event.
   * stopReason: end_turn → success; cancelled → interrupted (independent
   * terminal state, must NOT merge into error); anything else
   * (max_tokens / refusal / …) → error.
   *
   * Error text comes from the upstream payload when the server forwarded one
   * (`error` / `_meta`), otherwise from the stopReason itself. See
   * prompt-error.ts for why no cause is inferred.
   */
  handlePromptResponse(sessionId: string, result: SessionPromptResult): AgentEvent {
    const subtype =
      result.stopReason === 'end_turn'
        ? 'success'
        : result.stopReason === 'cancelled'
          ? 'interrupted'
          : 'error';

    let errorText: string | undefined;
    let authFailure = false;
    if (subtype === 'error') {
      const detail = describePromptError(result);
      errorText = detail.text;
      this.logPromptError(result, detail);
      // 401 是身份失效的唯一可信信号：打标让 runner / bridge 一次性清掉
      // 长驻连接、模型目录快照和持久会话，而不是只把错误文本贴到卡片上。
      authFailure = isPromptAuthenticationFailure(result);
    }

    return {
      type: 'result',
      subtype,
      session_id: sessionId,
      ...(this.hasLiveUsage ? { usage: this.liveUsageSnapshot() } : {}),
      ...(errorText ? { errorMessage: errorText } : {}),
      ...(authFailure ? { authFailure: true } : {}),
    };
  }

  /**
   * One warn line per failed prompt: the raw stopReason plus whether the server
   * forwarded a real message. Without it the card is the only record of a
   * failure, and a wrong card text cannot be traced back.
   */
  private logPromptError(result: SessionPromptResult, detail: PromptErrorDetail): void {
    getLogger().warn(
      `[${this.logTag}] prompt error stopReason=${result.stopReason} ` +
        `upstream=${detail.upstream ? truncateWithEllipsis(detail.upstream, 300) : '(none)'} ` +
        `metaKeys=${result._meta ? Object.keys(result._meta).join(',') : '(none)'}`,
    );
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
      // JSON-RPC 层直接抛错时没有 SessionPromptResult 可解析，只能按文本判定。
      ...(isAuthenticationFailure(errorMessage) ? { authFailure: true } : {}),
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
  // Shared notification handlers
  // =========================================================================

  /**
   * plan update → PlanEvent（信息保真 不再显式丢弃）。
   * ACP PlanEntry: { content, priority, status }（status: pending/in_progress/
   * completed）。基类具体方法：kimi/opencode wire 结构相同，直接复用。
   */
  protected handlePlan(event: AcpPlanEvent): AcpTranslatorEvent[] {
    const entries = Array.isArray(event.entries) ? event.entries : [];
    const markdown = renderPlanMarkdown(
      entries.map((e) => {
        const entry = e as { content?: string; status?: string };
        // ACP 条目的正文字段是 content（codex 是 title），无 subtitle。
        return { title: entry.content ?? '', status: entry.status };
      }),
    ).trim();
    if (!markdown) return [];
    return [{ type: 'plan', plan: markdown, timestamp: new Date().toISOString() }];
  }

  /**
   * tool_call → assistant/tool_use. rawInput normalization is contractual:
   * missing → {} (lazy-create tool_call carries no rawInput field), string →
   * JSON.parse (older agents send JSON strings) — keeps the card from
   * crashing on undefined input.
   *
   * 信息保真 kind 命中 KIND_TO_TOOL 时用映射名渲染结构化面板；
   * title 与 name 不同时把 title 存到 content block 的 summary 字段
   * （渲染层做面板副标题）。
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

    const argsText = this.extractToolCallArgsText(event);
    if (argsText !== undefined) {
      this.trackToolCallArgs(event.toolCallId, argsText);
    } else if (event.rawInput !== undefined && event.rawInput !== null) {
      this.trackToolCallArgs(event.toolCallId, acpStringify(event.rawInput));
    }

    const mapped = this.toolNameFromKind(event.kind);
    const name = mapped ?? event.title;
    this.trackToolCallName(event.toolCallId, name);
    const summary = mapped && event.title && event.title !== name ? event.title : undefined;

    return [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: event.toolCallId,
              name,
              input,
              ...(summary !== undefined ? { summary } : {}),
            },
          ],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  /**
   * tool_call_update → user/tool_result. status:'failed' → is_error:true.
   *
   * 终态（completed/failed）产出 tool_result；非终态的 tool_result 由
   * {@link emitToolResultForNonTerminalUpdate} 裁定（reducer 见到 tool_result
   * 即置 status:'ok'——无内容的非终态 tool_result 会把运行中的工具提前翻成 ✅）。
   */
  protected handleToolCallUpdate(
    event: ToolCallUpdateEvent,
    _sessionId: string,
  ): AcpTranslatorEvent[] {
    const isError = event.status === 'failed';
    const content = this.extractToolResultContent(event);

    // Patch the existing tool block with identity that was not available at the
    // initial tool_call (opencode streams args after emitting tool_call). The
    // reducer merges by id, so this never duplicates the panel. Built before
    // the terminal cleanup below so it can still resolve the recorded name.
    const useUpdate = this.buildToolUseUpdate(event);

    // Terminal updates end the args-streaming phase — drop the tracked entry.
    // In-progress delta text is cumulative (events-map.ts
    // toolCallDeltaToSessionUpdate: content.text = accumulator.args), so the
    // latest text replaces the previous one rather than appending.
    if (event.status === 'completed' || event.status === 'failed') {
      this.toolCallArgsByCallId.delete(event.toolCallId);
    } else {
      const argsText = this.extractToolCallArgsText(event);
      if (argsText !== undefined) {
        this.trackToolCallArgs(event.toolCallId, argsText);
      } else if (event.rawInput !== undefined && event.rawInput !== null) {
        this.trackToolCallArgs(event.toolCallId, acpStringify(event.rawInput));
      }
      // 非终态是否发 tool_result 由子类裁定（emitToolResultForNonTerminalUpdate）：
      // opencode 的 in-progress 带输出快照，seam 契约钉死「patch + tool_result」
      // 都要发（面板在工具运行时显示部分输出）；kimi 的 in-progress 只带流式
      // args，空 tool_result 会让 reducer 把运行中的工具提前置 ✅ + 空输出。
      if (!this.emitToolResultForNonTerminalUpdate(content)) {
        return useUpdate ? [useUpdate] : [];
      }
    }

    const events: AcpTranslatorEvent[] = [];
    if (useUpdate) events.push(useUpdate);
    events.push({
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
    });
    return events;
  }

  /**
   * Latest tracked streaming-args text for a tool call (undefined when never
   * seen or already terminated). Approval handlers correlate
   * request_permission's toolCall.toolCallId against this to recover the real
   * command (see toolCallArgsByCallId).
   */
  protected getTrackedToolCallArgs(toolCallId: string): string | undefined {
    return this.toolCallArgsByCallId.get(toolCallId);
  }

  /** tool_use name recorded at tool_call time (kind mapping wins, else title). */
  protected getToolCallName(toolCallId: string): string | undefined {
    return this.toolCallNameByCallId.get(toolCallId);
  }

  /**
   * kind → canonical tool name (信息保真). Shared by the initial tool_call
   * handler and the tool_call_update patch builder so both agree on the name.
   */
  protected toolNameFromKind(kind: string | undefined): string | undefined {
    return kind ? KIND_TO_TOOL[kind] : undefined;
  }

  /**
   * Streaming-args text carried by a tool_call/_update notification.
   *
   * Default: the notification's content text — kimi's events-map.ts encodes the
   * accumulated args there (toolCallDeltaToSessionUpdate: content.text =
   * accumulator.args), and the approval handler relies on it.
   *
   * opencode overrides this to return undefined: its tool_call/_update content
   * is the shell OUTPUT snapshot (decompiled acp service `WP`), never args
   * (args ride rawInput in `XC`/`BP`). Treating that output as args would
   * corrupt approval command recovery — the hazard this hook exists to close.
   */
  protected extractToolCallArgsText(
    event: ToolCallEvent | ToolCallUpdateEvent,
  ): string | undefined {
    return extractToolCallContentText(event.content);
  }

  /**
   * tool_call_update → optional tool_use patch event. When an update carries
   * richer identity than the initial tool_call did (opencode emits the
   * tool_call while args are still streaming, then delivers the real title /
   * rawInput in later updates), the returned `assistant`/`tool_use` block is
   * merged into the existing tool block by the card reducer (matched by id)
   * instead of creating a duplicate panel.
   *
   * Default: null (kimi self-produces its Bash tool_use from terminal/create
   * with the real command, so it needs no patch). opencode overrides.
   */
  protected buildToolUseUpdate(_event: ToolCallUpdateEvent): AgentEvent | null {
    return null;
  }

  /** Record latest args text, bounded so a long session cannot grow it forever. */
  private trackToolCallArgs(toolCallId: string, argsText: string): void {
    trackBounded(this.toolCallArgsByCallId, toolCallId, argsText);
  }

  /** Record tool_use name, bounded to keep a long session from growing it. */
  private trackToolCallName(toolCallId: string, name: string): void {
    trackBounded(this.toolCallNameByCallId, toolCallId, name);
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
   * 非终态 tool_call_update 是否附带 tool_result。默认 true（opencode seam
   * 契约：in-progress 的输出快照随 tool_result 进面板）。kimi 覆写为
   * 「有内容才发」——它的 in-progress 只带流式 args，空 tool_result 会让
   * reducer 把运行中的工具提前置 ✅ + 空输出（终态丢失时面板停在错误的
   * 「已完成」）。
   */
  protected emitToolResultForNonTerminalUpdate(content: unknown): boolean {
    void content;
    return true;
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

  /**
   * wire `content.text` → assistant 增量通道。opencode / codebuddy 语义相同
   * （delta 直通，无累积、无 turn_diff）；kimi 有自己的累积语义，覆写本方法。
   */
  protected handleAgentMessageChunk(
    event: AgentMessageChunkEvent,
    _sessionId: string,
  ): AcpTranslatorEvent[] {
    return [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: event.content.text }] },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  protected abstract handleAgentThoughtChunk(
    event: AgentThoughtChunkEvent,
    sessionId: string,
  ): AcpTranslatorEvent[];

  protected abstract handleRequestPermission(
    requestId: number | string,
    params: RequestPermissionParams,
  ): AcpTranslatorEvent[];
}
