/**
 * Codex App Server JSON-RPC Protocol Types
 *
 * Aligned with the real `codex app-server` protocol (v2, generated via
 * `codex app-server generate-json-schema --experimental`). Method names and
 * field names use the wire format exactly: camelCase paths for methods
 * (`item/agentMessage/delta`) and snake_case only where the server requires it
 * (e.g. permission profile fields).
 */

// =============================================================================
// JSON-RPC Base Types
// =============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type ServerMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse;

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
// =============================================================================

export interface ClientInfo {
  name: string;
  version: string;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities?: Record<string, unknown>;
}

export interface InitializeResult {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
}

// =============================================================================
// Sandbox / Approval enums
// =============================================================================

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Response-side sandbox policy object (the request side uses `SandboxMode`
 *  strings; the response reports the active policy as a structured object). */
export interface SandboxPolicy {
  type: 'dangerFullAccess' | 'readOnly' | 'externalSandbox' | 'workspaceWrite';
  networkAccess?: boolean;
  writableRoots?: string[];
  [key: string]: unknown;
}

export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        mcp_elicitations: boolean;
        rules: boolean;
        sandbox_approval: boolean;
        request_permissions?: boolean;
        skill_approval?: boolean;
      };
    };

// =============================================================================
// Lifecycle: thread
// =============================================================================

export interface ThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
  permissions?: string | null;
  config?: Record<string, unknown> | null;
}

export interface ThreadStartResponse {
  thread: Thread;
  cwd: string;
  model: string;
  modelProvider: string;
  approvalPolicy: AskForApproval;
  sandbox?: SandboxPolicy | null;
}

/** Real wire shape: ThreadStatus is a discriminated object, not a string. */
export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: unknown[] };

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
}

export interface ThreadResumeResponse {
  thread: Thread;
  cwd: string;
  model: string;
  modelProvider: string;
}

export interface ThreadCompactStartParams {
  threadId: string;
}

export interface Thread {
  id: string;
  sessionId: string;
  status: ThreadStatus;
  cwd: string;
  preview: string;
  turns: Turn[];
  createdAt: number;
  updatedAt: number;
  modelProvider: string;
  cliVersion: string;
  ephemeral: boolean;
  name?: string | null;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
}

// =============================================================================
// Lifecycle: turn
// =============================================================================

export interface UserInput {
  type: 'text';
  text: string;
  text_elements?: unknown[];
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string | null;
  effort?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval;
  sandboxPolicy?: SandboxMode;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type TurnStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted';

export interface TurnError {
  message: string;
  additionalDetails?: string | null;
  codexErrorInfo?: unknown;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error?: TurnError | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

// =============================================================================
// Thread items
// =============================================================================

export interface AgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
  phase?: string | null;
}

export interface ReasoningItem {
  type: 'reasoning';
  id: string;
  content?: string[];
  summary?: string[];
}

export interface CommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd?: string | null;
  aggregatedOutput?: string | null;
  status?: string | null;
}

export interface PlanItem {
  type: 'plan';
  id: string;
  text: string;
}

export interface FileChangeItem {
  type: 'fileChange';
  id: string;
  changes: FileUpdateChange[];
  status: string;
}

export interface FileUpdateChangeKind {
  type: 'add' | 'delete' | 'update';
  /** Present only on `update` kind — the move destination, if any. */
  move_path?: string | null;
}

export interface FileUpdateChange {
  path: string;
  kind: FileUpdateChangeKind;
  diff: string;
}

export interface ObservationItem {
  type: 'observation';
  id: string;
  content: string;
  timestamp: number;
}

export interface DiffItem {
  type: 'diff';
  id: string;
  diff: string;
  timestamp: number;
}

export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | PlanItem
  | FileChangeItem
  | ObservationItem
  | DiffItem
  | { type: 'userMessage'; id: string; content: unknown[] }
  | { type: 'contextCompaction'; id: string; [key: string]: unknown }
  | { type: string; id: string; [key: string]: unknown };

export interface PlanStep {
  id?: string;
  title: string;
  subtitle?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'error';
}

// =============================================================================
// Notifications (server → client)
// =============================================================================

export const NotificationMethod = {
  TURN_STARTED: 'turn/started',
  TURN_COMPLETED: 'turn/completed',
  TURN_DIFF_UPDATED: 'turn/diff/updated',
  TURN_PLAN_UPDATED: 'turn/plan/updated',
  ITEM_STARTED: 'item/started',
  ITEM_COMPLETED: 'item/completed',
  AGENT_MESSAGE_DELTA: 'item/agentMessage/delta',
  REASONING_SUMMARY_TEXT_DELTA: 'item/reasoning/summaryTextDelta',
  REASONING_SUMMARY_PART_ADDED: 'item/reasoning/summaryPartAdded',
  REASONING_TEXT_DELTA: 'item/reasoning/textDelta',
  COMMAND_EXECUTION_OUTPUT_DELTA: 'item/commandExecution/outputDelta',
  FILE_CHANGE_OUTPUT_DELTA: 'item/fileChange/outputDelta',
  PLAN_DELTA: 'item/plan/delta',
  TOKEN_USAGE_UPDATED: 'thread/tokenUsage/updated',
  SERVER_REQUEST_RESOLVED: 'serverRequest/resolved',
  ERROR: 'error',
  WARNING: 'warning',
  THREAD_STARTED: 'thread/started',
  THREAD_STATUS_CHANGED: 'thread/status/changed',
  THREAD_COMPACTED: 'thread/compacted',
  MODEL_REROUTED: 'model/rerouted',
} as const;

export interface TurnStartedNotification {
  method: 'turn/started';
  params: {
    threadId: string;
    turn: Turn;
  };
}

export interface TurnCompletedNotification {
  method: 'turn/completed';
  params: {
    threadId: string;
    turn: Turn;
  };
}

export interface ItemStartedNotification {
  method: 'item/started';
  params: {
    threadId: string;
    turnId: string;
    item: ThreadItem;
    startedAtMs: number;
  };
}

export interface ItemCompletedNotification {
  method: 'item/completed';
  params: {
    threadId: string;
    turnId: string;
    item: ThreadItem;
    completedAtMs: number;
  };
}

export interface AgentMessageDeltaNotification {
  method: 'item/agentMessage/delta';
  params: {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  };
}

export interface ReasoningSummaryTextDeltaNotification {
  method: 'item/reasoning/summaryTextDelta';
  params: {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  };
}

export interface ReasoningSummaryPartAddedNotification {
  method: 'item/reasoning/summaryPartAdded';
  params: {
    threadId: string;
    turnId: string;
    itemId: string;
    summaryIndex: number;
  };
}

export interface ReasoningTextDeltaNotification {
  method: 'item/reasoning/textDelta';
  params: {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
    contentIndex: number;
  };
}

export interface CommandExecutionOutputDeltaNotification {
  method: 'item/commandExecution/outputDelta';
  params: {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  };
}

export interface PlanDeltaNotification {
  method: 'item/plan/delta';
  params: {
    threadId: string;
    turnId: string;
    itemId: string;
    /** EXPERIMENTAL — plain-text plan delta; do not assume concatenation
     *  matches the completed plan item content. */
    delta: string;
  };
}

export interface FileChangeOutputDeltaNotification {
  method: 'item/fileChange/outputDelta';
  params: {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  };
}

export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  /** 当前模型 context window 上限（v2 schema 中与 last/total 平级；
   *  app-server 模式下唯一携带该信息的通道，CLI token_count 无此字段）。 */
  modelContextWindow?: number;
}

export interface ThreadTokenUsageUpdatedNotification {
  method: 'thread/tokenUsage/updated';
  params: {
    threadId: string;
    turnId: string;
    tokenUsage: ThreadTokenUsage;
  };
}

export interface ServerRequestResolvedNotification {
  method: 'serverRequest/resolved';
  params: {
    threadId: string;
    requestId: number | string;
  };
}

export interface ErrorNotification {
  method: 'error';
  params: {
    error: TurnError;
    threadId: string;
    turnId: string;
    willRetry: boolean;
  };
}

export interface WarningNotification {
  method: 'warning';
  params: {
    threadId?: string;
    turnId?: string;
    code: string;
    message: string;
    timestamp?: string;
  };
}

export interface ThreadStatusChangedNotification {
  method: 'thread/status/changed';
  params: {
    threadId: string;
    status: string;
    timestamp?: string;
  };
}

export interface ModelReroutedNotification {
  method: 'model/rerouted';
  params: {
    threadId: string;
    turnId?: string;
    model: string;
    reason?: string;
    timestamp?: string;
  };
}

// =============================================================================
// Server Requests (approval)
// =============================================================================

export const ServerRequestMethod = {
  COMMAND_EXECUTION_APPROVAL: 'item/commandExecution/requestApproval',
  FILE_CHANGE_APPROVAL: 'item/fileChange/requestApproval',
  PERMISSIONS_APPROVAL: 'item/permissions/requestApproval',
} as const;

export interface NetworkApprovalContext {
  host: string;
  protocol: string;
  port?: number | null;
}

export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  availableDecisions?: CommandExecutionApprovalDecision[] | null;
  networkApprovalContext?: NetworkApprovalContext | null;
  approvalId?: string | null;
}

export interface NetworkPolicyAmendment {
  host: string;
  action: 'allow' | 'deny';
}

/** Real wire shape: plain-string decisions plus structured decisions. */
export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: NetworkPolicyAmendment } };

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision;
}

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  grantRoot?: string | null;
  reason?: string | null;
}

export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision;
}

export type FileSystemAccessMode = 'read' | 'write' | 'deny';

export interface FileSystemSandboxEntry {
  path: string;
  access: FileSystemAccessMode;
}

/** Real wire shape: `read`/`write` are legacy string arrays; `entries` is the
 *  current structured form (`[{ path, access }]`). */
export interface AdditionalFileSystemPermissions {
  entries?: FileSystemSandboxEntry[] | null;
  read?: string[] | null;
  write?: string[] | null;
}

export interface AdditionalNetworkPermissions {
  enabled?: boolean | null;
}

export interface RequestPermissionProfile {
  fileSystem?: AdditionalFileSystemPermissions | null;
  network?: AdditionalNetworkPermissions | null;
}

export interface GrantedPermissionProfile {
  fileSystem?: AdditionalFileSystemPermissions | null;
  network?: AdditionalNetworkPermissions | null;
}

export interface PermissionsRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  cwd: string;
  permissions: RequestPermissionProfile;
  reason?: string | null;
}

export interface PermissionsRequestApprovalResponse {
  permissions: GrantedPermissionProfile;
  scope?: 'turn' | 'session';
}

/** Unsupported / ignored server request methods. */
export const UNSUPPORTED_SERVER_REQUEST_METHODS = new Set<string>([
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval',
]);
