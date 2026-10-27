/**
 * Runner 模块类型定义
 *
 * 本文件包含所有 Agent 相关的类型定义，从 runner/index.ts 提取。
 * 所有下游模块应从本文件 import 类型，而非直接依赖实现。
 * （例外：`AgentKind` 住在 `src/agent-kinds.ts`，见文件底部说明。）
 */
import type { AgentKind } from '../agent-kinds.js';
import type { AgentSessionReader } from '../session-contract.js';

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
  /**
   * 题面外的补充正文（DSH `AskUserQuestionItem.detail`）：plan-review 提问用它
   * 承载计划全文。渲染层折叠展示并截断，不能与 header / question 混写。
   */
  detail?: string;
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
   * Agent-agnostic scope note rendered at the top of the approval area (e.g. DSH's
   * "this grant applies to one call only"). Keep the audit reason untouched.
   */
  note?: string;
  /**
   * 提问卡顶部概要行（数据驱动，无 agent 分支）：Kimi elicitation form 的
   * 题面只在 form 级 message 里合并出现，逐字段 title 可能只是短 header，
   * 概要行用于展示完整题干。
   */
  intro?: string;
  /**
   * 提问超时后是否还能在别处回答的提示（数据驱动，避免共享渲染层写死某个
   * agent 的语义：DSH 提问超时后 Web UI 仍可回答，Claude/Codex 不能）。
   */
  expiredHint?: string;
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
  /**
   * 最近一次响应发送失败的原因。协调器失败后回滚 pending 并写回
   * 该字段，卡片据此渲染「提交失败，可重试」，不再让用户误以为已提交。
   */
  deliveryError?: string;
}

interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  /**
   * 思考块身份。同一 itemId 的连续 `thinking` 内容是**同一块的增量**，run-state
   * 逐字拼接（不插入任何分隔符）；itemId 变化才开启新块。缺省表示"续写当前块"
   * （块生产者必须显式给 id，避免与上一块粘连）。
   *
   * 来源：opencode `agent_thought_chunk.messageId`（`<msg>:reasoning:<ordinal>`）、
   * DSH `reasoning-delta` 的 attemptId+index、pi 每条消息的块序号。
   */
  itemId?: string;
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
  /**
   * 工具原始 title（ACP kind 映射后与 name 不同时保存；渲染层做面板副标题）。
   */
  summary?: string;
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

/**
 * Authoritative final answer from an agent protocol.
 *
 * This is deliberately separate from ordinary assistant text: progress
 * narration and tool-loop messages have lower display priority than the answer
 * the user actually asked for. Agents without an explicit protocol marker
 * promote their last text block when the turn finishes.
 */
export interface FinalAnswerEvent {
  type: 'final_answer';
  text: string;
  /** Source item id, used to remove the streamed progress copy of the answer. */
  itemId?: string;
  complete?: boolean;
  timestamp?: string;
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
    /** 推理 token（pi 提供）。缺省不展示。 */
    reasoning_tokens?: number;
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

/** 运行期通知（warning、模型重路由、压缩提示等）。translator 产出，公共层无分支渲染。 */
export interface NoticeEvent {
  type: 'notice';
  level: 'info' | 'warn' | 'error';
  code?: string;
  text: string;
  timestamp?: string;
}

/** 会话元信息（ACP session_info_update / current_mode_update）。字段缺省表示本次未变。 */
export interface SessionInfoEvent {
  type: 'session_info';
  title?: string;
  mode?: string;
  timestamp?: string;
}

/**
 * 运行期状态投影（上下文水位 / 会话累计统计）。
 *
 * 不是内容块：卡片把它渲染在状态行（statusRow），不进内容流，因此不参与
 * blocks 分组与 MAX_BLOCKS 裁剪。字段缺省表示该维度本次未变。
 *
 * 数据源是 agent 服务端自己算好的投影（DSH `session/control` 的
 * contextPressure / sessionStats），bridge 不重算口径——百分比只在两端都
 * 有值时才渲染。
 */
export interface RunStatusEvent {
  type: 'run_status';
  /** 已投影 token（官方口径 projectedTokens ?? pressureTokens）。 */
  contextUsed?: number;
  /** 上下文窗口上限（contextWindow）。 */
  contextLimit?: number;
  /** 会话累计步骤数（sessionStats.steps）。 */
  steps?: number;
  /** 会话累计工具耗时（毫秒，sessionStats.toolMs）。 */
  toolMs?: number;
  timestamp?: string;
}

/**
 * 会话级长期目标（DSH `goal` 投影的渲染快照）。
 *
 * 为什么卡片需要它：goal 是**跨 turn** 的自动续跑单元。本轮 turn 结束不等于
 * 任务结束——`goal-round-driver` 会在 quiescence 立刻起下一轮。缺这一维，
 * 卡片只能在"这一轮结束了"时收尾，于是出现"任务还在跑、卡片却写完成"
 * （turn/end 后宿主立刻起 goal round 2，用户点 Compact 被拒）。
 */
export interface GoalView {
  id: string;
  /** 人类写下的目标全文（可能很长，渲染层负责截断/折叠）。 */
  objective: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  /** 已启动的轮次（最高 admitted round）。 */
  roundsStarted: number;
  /** 轮次上限；达到后 driver 把 goal 置为 blocked(round-limit)。 */
  maxGoalRounds: number;
  /** 仅在 phase='blocked' 时存在：阻断分类与人类可读原因。 */
  blockedReason?: { code: string; message: string };
  updatedAt?: number;
}

/**
 * 一次 goal 状态观测（seed / 变更事件 / 收尾复核共用）。
 *
 * `known=false` 表示**读不到**，与"明确没有 goal"（`goal=null`）是两件事。
 * 把探测失败降级成"没有 goal"会退回旧行为（goal 还在跑、卡片却收尾），
 * 所以两者必须分开表达。
 */
export interface GoalStateEvent {
  type: 'goal_state';
  /** null = 宿主明确表示该会话没有 goal。 */
  goal: GoalView | null;
  /** false = 探测失败，`goal` 不具权威性，渲染层不得据此断言"已完成"。 */
  known: boolean;
  timestamp?: string;
}

/**
 * 运行结束后仍在后台运行的任务（终态卡展示 + 逐个停止入口）。
 *
 * 为什么必须出现在 run 卡片上：后台任务的生命周期跨 turn（`bash
 * run_in_background` 起的东西能活过 run 结束），卡片收尾时如果不说，用户就
 * 以为这一轮真的结束了——机器上却还在跑。
 */
export interface BackgroundJobsEvent {
  type: 'background_jobs';
  jobs: Array<{
    id: string;
    label: string;
    status?: string;
    progress?: string;
  }>;
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
  /**
   * Kimi ACP snapshot semantics: replace the existing block's anchor
   * timestamp with THIS diff's timestamp on every update (text/reasoning).
   * Kimi's `'text'`/`'thinking'` are whole-turn accumulators that keep
   * receiving late deltas while tools run, so a first-sight timestamp makes
   * the header (and its position after move-to-bottom) look stale. Other
   * snapshot streams (codex app-server) keep the first-sight timestamp by
   * contract — this flag stays false/undefined for them.
   */
  refreshTimestamp?: boolean;
  /** Authoritative tool status at completion (commandExecution item). */
  toolStatus?: 'ok' | 'error';
  /** 工具身份（commandExecution/mcpToolCall 等 item 首次发出时携带）。 */
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolHint?: ToolHint;
  threadId: string;
  turnId: string;
  timestamp?: string;
}

export type RunnerLifetime = 'turn' | 'workspace';

/** 工具渲染 hint：runner 自愿声明，渲染层只消费不推断。 */
export type ToolHint = 'shell' | 'file' | 'search' | 'web' | 'patch';

export type AgentEvent =
  | SystemInitEvent
  | SystemCompactEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalViewUpdatedEvent
  | ApprovalExpiredEvent
  | AssistantEvent
  | FinalAnswerEvent
  | UserEvent
  | ResultEvent
  | PlanEvent
  | FileChangeEvent
  | TurnStartedEvent
  | TurnDiffEvent
  | NoticeEvent
  | SessionInfoEvent
  | RunStatusEvent
  | BackgroundJobsEvent
  | GoalStateEvent;

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
 * What a stop request actually achieved.
 *
 * Local-process runners (`claude`/`codex`/…) can answer this from the kill
 * itself and keep returning `void`. DSH turns live in the shared Web Host, so
 * its stop is a session-scoped request: the outcome is the only way callers can
 * tell "the turn is gone" apart from "we asked, but it is still running".
 *
 * - `withdrawn`   — the prompt had not started yet and was removed from the
 *                   host's inbox; no turn was cancelled.
 * - `cancelled`   — the active turn (or maintenance job) was cancelled and the
 *                   host reported the session idle.
 * - `unconfirmed` — the cancel was rejected/lost, or the session still reports
 *                   an open turn afterwards. A turn may still be running.
 * - `noop`        — there was no session to stop (e.g. stop during setup).
 */
export type StopStatus = 'withdrawn' | 'cancelled' | 'unconfirmed' | 'noop';

export interface StopOutcome {
  status: StopStatus;
  sessionId?: string;
  /** Human-readable reason for `unconfirmed` (logged, not shown verbatim). */
  detail?: string;
}

/**
 * Seam (§3): the contract any agent runner (claude/codex/opencode/pi/kimi/dsh)
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
   *
   * Runners whose work is remote (DSH) return a {@link StopOutcome} instead of
   * `void` so callers can tell a confirmed stop from a best-effort request;
   * process runners keep returning `void`.
   */
  stop(opts?: { immediate?: boolean }): Promise<void | StopOutcome>;
  killOrphan(): void;
  registerExitHandlers(): void;
  /**
   * Remove the runner from the process-level exit dispatcher. Called by
   * the bridge when the (cwd, kind) cache slot is evicted so the instance is
   * not retained by the singleton dispatcher. Optional so test stubs that only
   * satisfy `registerExitHandlers` remain structurally valid.
   */
  unregisterExitHandlers?(): void;
}

// =============================================================================
// Multi-Agent Adapter Types
// =============================================================================

// Agent 名单与显示名住在 `src/agent-kinds.ts`（中立层，config/session/card 都
// 要用）；本模块只 import `AgentKind` 类型来签名 runner 契约。保留旧路径的
// re-export 兼容调用方，但值仍只由 agent-kinds.ts 定义。
export { AGENT_DISPLAY_NAMES } from '../agent-kinds.js';

/**
 * Compact 能力声明（运行时门控的能力清单，编译期强制完整）。
 *
 * 键集就是 `AgentKind`：新增 agent 时缺一项 = TypeScript 报错，必须显式回答
 * 「这个 agent 能不能压缩」。历史教训：能力只由 runner 上有没有 `runCompact`
 * 这个鸭子方法隐式决定，dsh 接入时漏了实现，run 卡片直接不渲染按钮——没有
 * 报错、没有置灰、没有日志，用户只能看到一个缺失的按钮（2026-10-17）。
 *
 * 声明与实现的唯一性由 `src/runner/runner-structure.test.ts` 的矩阵用例保证：
 * 每个 kind 的声明值必须等于对应 runner 类是否实现 `runCompact`。bridge 侧
 * 仍按「声明 && 实现」双重门控（fail closed），不一致时打 error 日志。
 */
export const COMPACT_CAPABILITY: Readonly<Record<AgentKind, boolean>> = {
  claude: true,
  codex: true,
  opencode: true,
  pi: true,
  kimi: true,
  dsh: true,
};

/** 该 agent 是否声明支持 compact（渲染门控与执行门控共用的唯一判据）。 */
export function supportsCompact(kind: AgentKind): boolean {
  return COMPACT_CAPABILITY[kind];
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
  /**
   * 回传审批决策（codex thread/permissions、ACP elicitation、DSH approval
   * resolve）。未实现的 agent 由协调器按「无人应答」超时收尾。
   */
  respondApproval?(requestId: number | string, response: unknown): Promise<void>;
  /**
   * 停止 agent 侧的一个后台任务（DSH 的 background job）。只有支持后台任务的
   * agent 实现；调用方按能力存在与否门控。
   */
  killJob?(sessionId: string, jobId: string): Promise<boolean>;
  /**
   * 热更审批模式/权限预设（config.save 后推给在跑的 runner，不必重启会话）。
   * 各家 settings 词表不同（codex: approvalPolicy/sandbox；kimi: permissionMode；
   * opencode: mode；dsh: permissionPreset），故为开放载荷。
   */
  updateApprovalMode?(settings: Record<string, unknown>): Promise<void>;
}

/** Agent self-describing status info for /status display. */
export interface AgentStatusInfo {
  /** Agent kind (claude/codex/opencode/pi/kimi/dsh). */
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
