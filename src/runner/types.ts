/**
 * Runner 模块类型定义
 *
 * 本文件包含所有 Agent 相关的类型定义，从 runner/index.ts 提取。
 * 所有下游模块应从本文件 import 类型，而非直接依赖实现。
 */

// =============================================================================
// Agent Event Types
// =============================================================================

export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd: string;
  model: string;
  timestamp?: string;
}

interface SystemCompactEvent {
  type: 'system';
  subtype: 'compact_boundary';
  timestamp?: string;
  compactMetadata?: {
    postTokens: number;
    preTokens: number;
  };
}

export interface ApprovalRequestedEvent {
  type: 'approval_requested';
  /** JSON-RPC id of the server request. Wire type is string | integer — keep raw. */
  requestId: number | string;
  kind: 'command' | 'file' | 'permissions' | 'question' | 'tool';
  threadId: string;
  turnId: string;
  itemId: string;
  view: ApprovalView;
  /**
   * Per-request 审批超时覆盖（毫秒）。由 runner 在翻译时填入
   * （Codex autoResolutionMs），coordinator 优先使用；
   * 缺省回落 run 级默认超时。放在事件上而非桥按 agentKind 分支，
   * 保证公共层无 agent 分支。
   */
  timeoutMs?: number;
  timestamp?: string;
}

export interface ApprovalResolvedEvent {
  type: 'approval_resolved';
  requestId: number | string;
  outcome: 'resolved' | 'expired';
  timestamp?: string;
}

/** Approval card content update (out-of-order item/started arrives late). */
export interface ApprovalViewUpdatedEvent {
  type: 'approval_view_updated';
  requestId: number | string;
  view: ApprovalView;
  timestamp?: string;
}

/** Approval expired locally (bridge-side timeout) — card should show expired UI. */
export interface ApprovalExpiredEvent {
  type: 'approval_expired';
  requestId: number | string;
  timestamp?: string;
}

/** 审批决策（bridge ApprovalCoordinator → runner.respondApproval 的响应载荷）。 */
export type ApprovalAction =
  | { action: 'accept' }
  | { action: 'accept_for_session' }
  | { action: 'accept_with_execpolicy_amendment' }
  /** Claude：允许当前请求 + 本会话后续所有权限请求自动放行（允许所有）。 */
  | { action: 'accept_all' }
  /**
   * 计划审批「拒绝并附修改意见」：deny + message，Claude 留在 plan 模式
   * 按意见修订（等价 TUI「Tell Claude what to change」）。
   */
  | { action: 'decline_with_feedback'; message: string }
  /**
   * 计划审批「批准并采纳修改意见」：allow + updatedInput.plan（原计划追加
   * 意见），触发 Claude 侧 planWasEdited → tool_result 回显
   * "## Approved Plan (edited by user)"（等价 TUI shift+tab approve with feedback）。
   */
  | { action: 'accept_with_feedback'; plan: string }
  | { action: 'decline' }
  | { action: 'cancel' }
  /**
   * AskUserQuestion 答案（question → label 或 label[]）。
   * notes：Codex user_note 补充说明（question → 文本），runner 编码为
   * "user_note: <text>" 条目；其他 agent 忽略该字段。
   */
  | {
      action: 'answer';
      answers: Record<string, string | string[]>;
      notes?: Record<string, string>;
    };

/** AskUserQuestion 公共契约（Agent 无关）的单个选项。 */
export interface UserQuestionOption {
  label: string;
  description?: string;
}

/**
 * AskUserQuestion 公共契约（Agent 无关）的单个问题。
 *
 * 接入约定（新 agent 接入 AskUserQuestion 时在这里扩展，禁止在 coordinator /
 * renderer / router 里写 agent 分支）：
 * 1. 各 agent runner 把协议提问翻译为 `ApprovalView{ kind:'question', questions }`；
 * 2. 用户回答经 ApprovalCoordinator 收集，以 `ApprovalAction{action:'answer',
 *    answers:{问题文本: string|string[]}}` 回传 runner；
 * 3. runner 侧把文本 key 答案翻译回自己协议的 shape（Claude 直接用文本 key；
 *    Codex 需按问题 id 映射）。
 */
export interface UserQuestion {
  /** Agent 侧问题唯一标识（Codex request_user_input 的 id 预留；Claude 无此字段）。 */
  id?: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: UserQuestionOption[];
  /** 是否允许自定义答案（Codex isOther 预留；当前单选渲染层恒提供 Other 输入）。 */
  isOther?: boolean;
  /** 敏感输入（Codex isSecret 预留）。 */
  isSecret?: boolean;
  /** 自由文本题的输入框占位提示（渲染层自由文本题 input）。 */
  placeholder?: string;
  /**
   * 是否渲染「补充说明（可选）」输入（Codex user_note；数据驱动无 agent 分支）。
   * note 是选项之外的附加文本，随答案提交，不单独构成答案。
   */
  allowNote?: boolean;
  /** 当前已填写的补充说明（卡片回显；coordinator answerNote 回流）。 */
  note?: string;
  /**
   * 当前已选选项 label（卡片渲染与多选切换用；单选在协调器内即时提交）。
   * 与 permissions.items.selected 同模式：协调器原地更新后以
   * approval_view_updated 重新渲染。
   */
  selected?: string[];
}

export interface ApprovalView {
  requestId: number | string;
  kind: 'command' | 'file' | 'permissions' | 'question' | 'tool';
  reason?: string;
  /**
   * 提问卡顶部概要行（数据驱动，无 agent 分支）：Kimi elicitation form 的
   * 题面只在 form 级 message 里合并出现，逐字段 title 可能只是短 header，
   * 概要行用于展示完整题干。
   */
  intro?: string;
  command?: string;
  commandCwd?: string;
  /**
   * 被审批的工具名（kind === 'tool' 时展示，如 ExitPlanMode）。非命令工具的
   * 权限请求（plan 退出/通知型工具）input 无 command 语义，用工具名 + reason
   * 表达审批内容，避免落入 command 槽位显示无意义 `{}`。
   */
  toolName?: string;
  /**
   * 计划全文（kind === 'tool' 且 toolName === 'ExitPlanMode' 时存在）。
   * 来源：control_request input.plan（CLI normalizeToolInput 从磁盘注入，
   * 非稳定）→ 计划文件读取（input.planFilePath / 会话内 Write/Edit 跟踪）。
   */
  plan?: string;
  /** 计划文件路径（ExitPlanMode；input.planFilePath 或会话内跟踪所得）。 */
  planFilePath?: string;
  /**
   * 用户已填写的计划修改意见（ExitPlanMode 反馈输入框；coordinator
   * planFeedback 回流，卡片回显）。供「拒绝并附意见」/「批准并采纳修改」
   * 两个决策复用。
   */
  planFeedback?: string;
  /** 原始 input 的 JSON 字符串（kind === 'tool' 且 input 非空时展示）。 */
  toolInput?: string;
  fileChanges?: Array<{ path: string; kind: 'add' | 'update' | 'delete'; diff?: string }>;
  permissions?: {
    items: Array<{
      id: string;
      label: string;
      target: { kind: 'network' } | { kind: 'fsRead' | 'fsWrite'; path: string };
      selected: boolean;
    }>;
  };
  /** Claude AskUserQuestion 问题列表（kind === 'question' 时存在）。 */
  questions?: UserQuestion[];
  availableDecisions: string[];
  /** Raw payloads for structured decisions (e.g. acceptWithExecpolicyAmendment). */
  decisionPayloads?: Record<string, unknown>;
}

interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

interface TextContent {
  type: 'text';
  text: string;
}

interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
}

export type AssistantContent = ThinkingContent | TextContent | ToolUseContent;

export interface AssistantEvent {
  type: 'assistant';
  timestamp?: string;
  message: {
    content: AssistantContent[];
  };
}

export interface UserEvent {
  type: 'user';
  timestamp?: string;
  message: {
    content: ToolResultContent[];
  };
}

export interface ResultEvent {
  type: 'result';
  subtype: 'success' | 'error' | 'interrupted';
  session_id: string;
  timestamp?: string;
  usage?: {
    /** Non-cached input tokens. For codex this is raw `input_tokens` minus
     *  `cached_input_tokens`; for pi/claude/opencode the raw value is already
     *  non-cached. Aligns with ccusage's displayed-input semantics. */
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    /** Cache-write (prompt-cache creation) tokens. Codex has none (0). */
    cache_creation_tokens?: number;
    /** Anthropic 原生命名，claude CLI 的 result 事件使用此字段名。 */
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** Agent-declared total; when present the display uses max(total, sum of parts). */
    total_tokens?: number;
    /** 当前模型 context window 上限（codex app-server tokenUsage.modelContextWindow
     *  透传）。仅 app-server 提供；缺省时卡片只显示绝对量、不显示百分比。 */
    context_limit?: number;
  };
  total_cost_usd?: number;
  errorMessage?: string; // For auth errors and other run failures
}

/** TokenUsage = ResultEvent['usage'] without the optional wrapper.
 *
 *  Usage sites that have already checked `event.usage` is present can type the
 *  value as `TokenUsage` to avoid repeated `!` assertions.
 */
export type TokenUsage = NonNullable<ResultEvent['usage']>;

/** Plan event — for agents that report execution plans (e.g. Codex). */
export interface PlanEvent {
  type: 'plan';
  plan: string; // delta-accumulated plan text
  timestamp?: string;
}

/** File change event — for agents that report file modifications (e.g. Codex). */
export interface FileChangeEvent {
  type: 'file_change';
  path: string;
  diff?: string; // optional diff text
  operation: 'create' | 'edit' | 'delete' | 'read';
  timestamp?: string;
}

export interface TurnStartedEvent {
  type: 'turn_started';
  threadId: string;
  turnId: string;
  operationKind: 'turn' | 'compaction';
  timestamp?: string;
}

export interface TurnDiffEvent {
  type: 'turn_diff';
  /**
   * Thread item id this snapshot belongs to (app-server item-scoped stream).
   * Each content item (reasoning / agentMessage / commandExecution / plan /
   * fileChange) is tracked independently, so interleaved items keep their
   * real chronology and update their own block instead of a shared one.
   */
  itemId: string;
  /** Full accumulated assistant text snapshot for this item (replaces previous). */
  text?: string;
  /** Full accumulated reasoning snapshot for this item (replaces previous). */
  reasoning?: string;
  /** Full accumulated tool output snapshot for this item (replaces previous). */
  toolOutput?: string;
  /** Full accumulated plan text snapshot for this item (replaces previous). */
  plan?: string;
  /** Current set of file changes for this item (replaces previous). */
  fileChanges?: Array<{ path: string; kind: 'add' | 'update' | 'delete'; diff?: string }>;
  /**
   * Authoritative completion snapshot (item/completed or turn/completed).
   * The reducer finalizes the block in place: thinking/plan active=false,
   * tool status ok, completedAt stamped. Never reorders blocks.
   */
  complete?: boolean;
  /** Authoritative tool status at completion (commandExecution item). */
  toolStatus?: 'ok' | 'error';
  threadId: string;
  turnId: string;
  timestamp?: string;
}

export type RunnerLifetime = 'turn' | 'workspace';

export type AgentEvent =
  | SystemInitEvent
  | SystemCompactEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalViewUpdatedEvent
  | ApprovalExpiredEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | PlanEvent
  | FileChangeEvent
  | TurnStartedEvent
  | TurnDiffEvent;

// =============================================================================
// Runner Interface
// =============================================================================

export interface SpawnOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  /** Codex reasoning effort override (per-run, takes precedence over constructor default). */
  reasoningEffort?: string;
  settings?: string;
}

/**
 * Seam (§3): the contract any agent runner (claude/codex/opencode/pi/kimi)
 * must satisfy for the router/bridge.
 * Declared here so callers depend on the interface, not the concrete
 * runner classes — test stubs satisfy this structurally.
 */
export interface Runner {
  readonly isRunning: boolean;
  readonly lifetime?: RunnerLifetime;
  dispose?(): Promise<void>;
  run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent>;
  /**
   * Stop the running process. SIGTERM → grace → SIGKILL on the per-workspace
   * proc. `immediate: true` skips the grace period and SIGKILLs directly
   * (used by user-initiated `/stop`).
   */
  stop(opts?: { immediate?: boolean }): Promise<void>;
  killOrphan(): void;
  registerExitHandlers(): void;
  /**
   * Remove the runner from the process-level exit dispatcher (P1-1). Called by
   * the bridge when the (cwd, kind) cache slot is evicted so the instance is
   * not retained by the singleton dispatcher. Optional so test stubs that only
   * satisfy `registerExitHandlers` remain structurally valid.
   */
  unregisterExitHandlers?(): void;
}

// =============================================================================
// Multi-Agent Adapter Types
// =============================================================================

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'pi' | 'kimi' | 'dsh';

/** Unified session descriptor returned by every AgentSessionReader. */
export interface AgentSession {
  sessionId: string;
  summary: string;
  mtime: number;
  /** DSH：session 创建时固定的 preset；其他 agent 无此概念（undefined）。 */
  agentPreset?: string;
}

/** A single renderable event from session history. */
export interface AgentSessionContentEvent {
  type: string;
  content: string;
  timestamp?: string;
}

export interface AgentSessionUsage {
  inputTokens: number;
  outputTokens: number;
  contextLength: number;
  /** Agent 上报的当前模型 context window 上限（codex token_count.info.model_context_window）。
   *  仅 codex 提供；缺省时卡片只显示绝对量、不显示百分比。 */
  contextLimit?: number;
  /** Claude auto-compact 次数（数 compact_boundary 事件）；codex/opencode 无此概念，留 undefined。 */
  compactCount?: number;
  /** 压缩前上下文水位（codex compact 后从会话 jsonl 读取，仅会话以压缩收尾时有值）。 */
  compactPreContextLength?: number;
  /** 从缓存读取的 token 数（节省的费用）。 */
  cacheReadTokens?: number;
  /** 新建缓存的 token 数。 */
  cacheCreationTokens?: number;
  /** Agent 声明的总量；展示用 max(total, 分项和)。 */
  totalTokens?: number;

  /** 会话累计 total token（所有 run 之和，含本次）。用于 Run 卡片"累计"展示。 */
  cumulativeTotalTokens?: number;
  /** 会话累计 input token（所有 run 之和，含本次）。用于 Run 卡片"累计"展示。 */
  cumulativeInputTokens?: number;
  /** 会话累计 output token（所有 run 之和，含本次）。 */
  cumulativeOutputTokens?: number;
  /** 会话累计 cache read token（所有 run 之和）。用于 Run 卡片展示累计缓存命中。 */
  cumulativeCacheReadTokens?: number;
  /** 会话累计 cache creation token（所有 run 之和）。 */
  cumulativeCacheCreationTokens?: number;
}

/** Unified session content payload returned by every AgentSessionReader. */
export interface SessionContent {
  events: AgentSessionContentEvent[];
  usage?: AgentSessionUsage;
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
}

/**
 * Reads an agent's session history. Each agent implements its own (Claude reads
 * `~/.claude/projects/`, Codex calls `thread/list`, OpenCode calls `GET /session`).
 *
 * Q-C decision: `projectsDir` and other agent-specific path config live on the
 * concrete reader's constructor, NOT on these method opts. The router/bridge
 * depend only on this interface and never pass path config.
 */
export interface AgentSessionReader {
  /**
   * List sessions for a cwd, newest first by mtime.
   *
   * `sessions` is the page `[offset, offset+limit)` of the full set ordered
   * by mtime desc, with same-mtime ties broken by a deterministic secondary
   * key (sessionId/file path) so ordering is stable across calls. When
   * `limit` is omitted, codex/pi/kimi return their default-sized page
   * (default 20); claude/opencode return the full remaining set from
   * `offset`. `total` is ALWAYS the size of the full cwd-matched set before
   * pagination — never the truncated page length. A negative `offset` is
   * clamped to 0 (first page).
   */
  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number };
  getNewestSession(cwd: string): AgentSession | null;
  readSessionContent(sessionId: string, cwd: string, opts?: { maxEvents?: number }): SessionContent;
  /**
   * Whether a session is still active (process may still be running).
   *
   * Dormant API: no production caller reads this today — the router decides
   * "is an agent running" via the in-memory `bridge.isBusyFor(cwd)` (see
   * `cmdPs`), not by probing session files. Retained on the reader contract
   * because all 5 readers implement it and it is the natural hook if a
   * file-based liveness check is ever needed; not wired into the bridge.
   */
  isSessionActive(sessionId: string, cwd: string): boolean;
}

/**
 * AgentRunner extends Runner with agent identity and a session reader.
 * Bridge/Router depend on this interface so adding a new agent is
 * "implement AgentRunner + register" with zero upstream changes.
 */
export interface AgentRunner extends Runner {
  readonly kind: AgentKind;
  readonly sessionReader: AgentSessionReader;
  /** Return current status info for /status display. */
  getStatusInfo(): AgentStatusInfo;
  /** Whether this runner provides live usage data (vs. file-based). */
  getUsageAuthority?(): 'live' | 'jsonl';
}

/** Agent self-describing status info for /status display. */
export interface AgentStatusInfo {
  /** Agent kind (claude/codex/opencode/pi/kimi). */
  kind: AgentKind;
  /** Display model name. */
  model: string;
  /** Optional provider name. */
  provider?: string;
  /** Reasoning/thinking level. */
  reasoning?: string;
  /** Agent-specific extra fields (e.g. codex.sandbox). */
  extras?: Record<string, string>;
}
