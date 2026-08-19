/**
 * ACP (Agent Client Protocol) JSON-RPC Protocol Types — shared layer.
 *
 * Aligned with the real `kimi acp` protocol (kimi-code/packages/acp-server).
 * Method names and field names use the wire format exactly.
 * Only covers the methods and events needed for the integration
 * (§4 event mapping table + §5 approval + §6 compact).
 *
 * ============================================================================
 * 事件契约（translator 共享规范 —— 文档不是抽象，各家 translator 仍各自实现）
 * ============================================================================
 *
 * lark-remote 内部事件流对 ACP 系 agent（kimi acp、后续 opencode acp）的约定：
 *
 * 1. `assistant/text` 与 `assistant/thinking` 是**增量通道**：run-state 收到后
 *    向对应 item **追加**文本。
 * 2. `turn_diff` 是**快照通道**：run-state 按 itemId **原地替换**全文（kimi ACP
 *    文本/思考固定 itemId `'text'`/`'thinking'`）。
 * 3. kimi wire 的 `content.text`（agent_message_chunk / agent_thought_chunk）
 *    是**增量 delta**（来源：kimi-code events-map.ts
 *    `assistantDeltaToSessionUpdate`）。translator 必须把 delta 累积成全文后
 *    以 `turn_diff` 快照发出——禁止把 delta 直接当快照或把全文当增量重复追加。
 * 4. `tool_call` 事件可能**没有 rawInput**（工具 lazy-create，参数在后续
 *    tool_call_update 才补齐）；translator 必须归一化为 `{}`，不得因缺失崩溃。
 */

// =============================================================================
// JSON-RPC Base Types (shared: src/runner/common/jsonrpc/types.ts)
// =============================================================================

export type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
} from '../jsonrpc/types.js';

/** Standard JSON-RPC error codes. */
export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Timeout error (custom, not standard JSON-RPC). */
  TIMEOUT_ERROR: -32000,
  /** Connection lost / transport error (custom). */
  CONNECTION_LOST: -32001,
} as const;

// =============================================================================
// Lifecycle: initialize
// Shape source: kimi-code/packages/acp-server/src/server.ts:180-182
//   + ACP SDK schema (protocolVersion required, number type)
//   + 2026-08-15 live smoke test against kimi 0.36.0
// =============================================================================

export interface InitializeParams {
  /** Protocol version — must be 1 (number, not string). */
  protocolVersion: number;
  /** Client capabilities: explicitly declare what we support (all off). */
  clientCapabilities: {
    fs: { readTextFile: boolean; writeTextFile: boolean };
    terminal: boolean;
  };
}

export interface AgentInfo {
  name: string;
  version: string;
}

export interface InitializeResult {
  /** Protocol version returned by the server. */
  protocolVersion: number;
  /** Agent info — NOTE: field is `agentInfo`, NOT `serverInfo`. */
  agentInfo: AgentInfo;
  /** Authentication methods the server supports. */
  authMethods?: string[];
  /** Agent capabilities declared by the server. */
  agentCapabilities?: Record<string, unknown>;
}

// =============================================================================
// ACP session modes (acp-server/src/modes.ts)
// =============================================================================

/**
 * ACP mode ids (what the server accepts in session/set_mode).
 * kimi exposes default/auto/yolo (plan not exposed in v1);
 * opencode uses agent names build/plan.
 */
export type AcpMode = 'default' | 'plan' | 'auto' | 'yolo' | 'build';

// =============================================================================
// Lifecycle: session
// Shape source: kimi-code/packages/acp-server/src/server.ts
//   session/new: line 236 (params.mcpServers consumed)
//   session/resume: line 293
//   session/set_mode: line 439 (params.modeId, NOT params.mode)
//   session/cancel: ACP spec notification (no id, no response)
//   + 2026-08-15 live smoke test against kimi 0.36.0
// =============================================================================

export interface SessionNewParams {
  cwd: string;
  /** MCP servers config — REQUIRED (can be empty array). */
  mcpServers: unknown[];
}

export interface SessionNewResult {
  sessionId: string;
  configOptions?: Record<string, unknown>;
}

export interface SessionResumeParams {
  sessionId: string;
  cwd: string;
}

export interface SessionResumeResult {
  sessionId: string;
  configOptions?: Record<string, unknown>;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: Array<{ type: 'text'; text: string }>;
}

export interface SessionPromptResult {
  stopReason: 'end_turn' | 'cancelled' | string;
  [key: string]: unknown;
}

export interface SessionCancelParams {
  sessionId: string;
}

export interface SessionSetModeParams {
  sessionId: string;
  /** Parameter name is `modeId`, NOT `mode` (server.ts:439). */
  modeId: AcpMode;
}

// =============================================================================
// Notifications (server → client, via session/update)
// Shape source: kimi-code/packages/acp-server/src/events-map.ts
//   (each constructor below) + 2026-08-15 live smoke test against kimi 0.36.0
//
// REAL envelope: {sessionId, update: {sessionUpdate: '<kind>', ...}}.
// The discriminator field is `update.sessionUpdate` — there is NO nested
// `event.type` / `event.delta` (S5/S6 打回根因：旧实现读 params.event，
// 真实通知全部静默丢弃)。
// =============================================================================

/** Notification method names for ACP protocol. */
export const NotificationMethod = {
  /** Session update carries one of the event types below. */
  SESSION_UPDATE: 'session/update',
} as const;

/** Event types within session/update params. */
export const SessionEventType = {
  AGENT_MESSAGE_CHUNK: 'agent_message_chunk',
  AGENT_THOUGHT_CHUNK: 'agent_thought_chunk',
  TOOL_CALL: 'tool_call',
  TOOL_CALL_UPDATE: 'tool_call_update',
  PLAN: 'plan',
  AVAILABLE_COMMANDS_UPDATE: 'available_commands_update',
  SESSION_INFO_UPDATE: 'session_info_update',
  CURRENT_MODE_UPDATE: 'current_mode_update',
  CONFIG_OPTION_UPDATE: 'config_option_update',
  USAGE_UPDATE: 'usage_update',
} as const;

// =============================================================================
// session/update event shapes
// Shape source: events-map.ts — assistantDeltaToSessionUpdate (line ~30),
// thinkingDeltaToSessionUpdate (line ~280), toolCallStartToSessionUpdate
// (line ~170), toolResultToSessionUpdate (line ~330),
// usageUpdateNotification (line ~505-516)
// =============================================================================

export interface AgentMessageChunkEvent {
  sessionUpdate: 'agent_message_chunk';
  /** events-map.ts:30-37 — content.text, NOT delta. */
  content: { type: 'text'; text: string };
}

export interface AgentThoughtChunkEvent {
  sessionUpdate: 'agent_thought_chunk';
  /** events-map.ts:280-288 — same content.text structure. */
  content: { type: 'text'; text: string };
}

export interface ToolCallEvent {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  /** events-map.ts toolCallStartToSessionUpdate — rawInput is the args
   *  OBJECT (not a JSON string). */
  kind: string;
  status: 'pending' | 'in_progress' | string;
  rawInput: unknown;
  locations?: unknown[];
  content?: unknown[];
  [key: string]: unknown;
}

export interface ToolCallUpdateEvent {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status: 'running' | 'completed' | 'failed';
  title?: string;
  rawInput?: unknown;
  /** events-map.ts toolResultToSessionUpdate — raw output of the tool. */
  rawOutput?: string;
  locations?: unknown[];
  content?: unknown[];
  [key: string]: unknown;
}

export interface AcpPlanEvent {
  sessionUpdate: 'plan';
  entries?: unknown[];
  [key: string]: unknown;
}

export interface AvailableCommandsUpdateEvent {
  sessionUpdate: 'available_commands_update';
  availableCommands?: unknown[];
  [key: string]: unknown;
}

export interface SessionInfoUpdateEvent {
  sessionUpdate: 'session_info_update';
  title: string | null;
  [key: string]: unknown;
}

export interface CurrentModeUpdateEvent {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
  [key: string]: unknown;
}

export interface ConfigOptionUpdateEvent {
  sessionUpdate: 'config_option_update';
  configOptions?: unknown[];
  [key: string]: unknown;
}

export interface UsageUpdateEvent {
  sessionUpdate: 'usage_update';
  /** events-map.ts:505-516 — current context occupancy (token count).
   *  There is NO inputTokens/outputTokens split. */
  used: number;
  /** Model context window upper bound. */
  size: number;
  [key: string]: unknown;
}

export type SessionUpdateEvent =
  | AgentMessageChunkEvent
  | AgentThoughtChunkEvent
  | ToolCallEvent
  | ToolCallUpdateEvent
  | AcpPlanEvent
  | AvailableCommandsUpdateEvent
  | SessionInfoUpdateEvent
  | CurrentModeUpdateEvent
  | ConfigOptionUpdateEvent
  | UsageUpdateEvent;

export interface SessionUpdateNotification {
  method: 'session/update';
  params: {
    sessionId: string;
    update: SessionUpdateEvent;
  };
}

// =============================================================================
// Server Requests (approval — reverse RPC)
// Shape source: kimi-code/packages/acp-server/src/approval.ts:28-29
//   options: [{optionId, name, kind}]; optionId is opaque, echo back as-is
//   + 2026-08-15 live smoke test: approve_once / approve_always / reject
// =============================================================================

export const ServerRequestMethod = {
  REQUEST_PERMISSION: 'session/request_permission',
  /** Kimi AskUserQuestion elicitation form（客户端广告 elicitation.form 时启用）。 */
  ELICITATION_CREATE: 'elicitation/create',
} as const;

export interface PermissionOption {
  /** Opaque option identifier — echo back in response outcome.optionId. */
  optionId: string;
  /** Human-readable option name. */
  name: string;
  /** Option kind: 'approve_once'/'allow_once', 'approve_always'/'allow_always', 'reject'/'reject_once'. */
  kind: string;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall?: {
    title: string;
    rawInput: string;
    [key: string]: unknown;
  };
  options: PermissionOption[];
  /** Question elicitation marker: true when this is a question rather than
   *  a tool approval (§5.4). Identified by absence of toolCall and/or presence
   *  of options with Skip semantics. */
  isQuestion?: boolean;
  [key: string]: unknown;
}

export interface RequestPermissionResponse {
  outcome: {
    outcome: 'selected' | 'cancelled';
    optionId?: string;
  };
}

// =============================================================================
// Elicitation（Kimi AskUserQuestion form 通道）
// 形状来源：kimi-code/packages/acp-server/src/question.ts
//   questionRequestToElicitationParams / elicitationResponseToQuestionAnswers
// =============================================================================

export interface ElicitationEnumOption {
  const: string;
  title?: string;
  description?: string;
}

export interface ElicitationPropertySchema {
  type: 'string' | 'array';
  title?: string;
  description?: string;
  minItems?: number;
  oneOf?: ElicitationEnumOption[];
  items?: { anyOf?: ElicitationEnumOption[] };
}

export interface ElicitationCreateParams {
  sessionId: string;
  toolCallId?: string;
  mode: 'form';
  message?: string;
  requestedSchema: {
    type: 'object';
    required?: string[];
    properties: Record<string, ElicitationPropertySchema>;
  };
}

export interface ElicitationCreateResponse {
  action: 'accept' | 'decline' | 'cancel';
  /** accept 时的答案，key 为 q0..qn（按问题顺序）。 */
  content?: Record<string, string | string[]>;
}
