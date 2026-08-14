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
  kind: 'command' | 'file' | 'permissions';
  threadId: string;
  turnId: string;
  itemId: string;
  view: ApprovalView;
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

export interface ApprovalView {
  requestId: number | string;
  kind: 'command' | 'file' | 'permissions';
  reason?: string;
  threadShort: string;
  turnShort: string;
  workspace: string;
  command?: string;
  commandCwd?: string;
  fileChanges?: Array<{ path: string; kind: 'add' | 'update' | 'delete'; diff?: string }>;
  network?: { host: string; protocol: string };
  permissions?: {
    networkEnabled?: boolean;
    fileSystemRead?: string[];
    fileSystemWrite?: string[];
    items: Array<{
      id: string;
      label: string;
      target: { kind: 'network' } | { kind: 'fsRead' | 'fsWrite'; path: string };
      selected: boolean;
    }>;
  };
  availableDecisions: string[];
  /** Raw payloads for structured decisions (e.g. acceptWithExecpolicyAmendment). */
  decisionPayloads?: Record<string, unknown>;
  pendingTotal: number;
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

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'pi' | 'kimi';

/** Unified session descriptor returned by every AgentSessionReader. */
export interface AgentSession {
  sessionId: string;
  summary: string;
  mtime: number;
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
