/**
 * DSH wire type shapes (DeepSeek Harness HTTP proxy contract).
 *
 * Source of truth: @deepseek-ai/dsh-client-connection (unary envelope),
 * @deepseek-ai/dsh-api-gateway (Remote stream mux) and
 * @deepseek-ai/dsh-api-session-controller (session Remote methods) in DSH
 * 0.2.x. Only the fields DshClient/DshRunner/DshSessionReader consume are
 * declared here.
 *
 * Unary: POST /api/<method>, body `{type:'client-request',rpcId,method,payload}`,
 * response `{type:'server-response',rpcId,result:{ok:true,value}|{ok:false,error}}`.
 * Auth: a signed `dsh-auth-*` cookie is required on every `/api/*` request and
 * the `/api/remote.mux` WebSocket. The v1 cookie is minted from DSH's durable
 * browser-session secret, or bootstrapped with `GET /?token=<launch token>`.
 * Stream: WebSocket `/api/remote.mux` logical streams
 * `{type:'open',streamId,endpoint:'session/follow',payload}` →
 * `{type:'item',streamId,value}` / `{type:'end',streamId}`.
 */

/** One SessionEvent entry (core SessionEvent<T> — seq/time/data discriminated on type). */
export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  ignorable?: true;
  sourceEventSeqs?: unknown;
  surfaceOp?: unknown;
}

/** TokenUsage from assistant/message.usage (dsh-llm TokenUsage). */
export interface DshTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** Projection block returned by session/list / session/projections / follow. */
export interface DshProjections {
  kind?: 'cached' | 'sequenced';
  asOfSeq: number;
  values: {
    agentPreset?: string | null;
    title?: string | null;
    [key: string]: unknown;
  };
}

/** SessionSummary row from session/list items[]. */
export interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  /** Legacy top-level preset (pre-0.2 DSH). */
  agentPreset?: string;
  /** 0.2.x exposes preset/title through projections. */
  projections?: DshProjections;
}

/** session/list → value. */
export interface DshSessionListValue {
  items: DshSessionSummary[];
}

/** session/page → value.records[]. */
export interface DshPageRecord {
  event: DshSessionEvent;
  view?: unknown;
}

/** session/page → value. */
export interface DshSessionPageValue {
  records: DshPageRecord[];
  hasMore: boolean;
}

/** One model entry inside a provider group (session/modelCatalog / session/selectModel groups[].models[]). */
export interface DshCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string };
}

/** One provider group of the model catalog (session/modelCatalog groups[]). */
export interface DshModelGroup {
  id: string;
  name: string;
  models: DshCatalogModel[];
}

/** session/modelCatalog → value. */
export interface DshModelCatalogValue {
  default?: DshModelSelection;
  routableProviders?: string[];
  groups: DshModelGroup[];
  failures?: Array<{ id: string; name: string; message: string }>;
}

/** Current model selection (session/selectModel current / session/selectModel selected). */
export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** One preset row of agentPresets/list. */
export interface DshPresetEntry {
  id: string;
  trust: 'system' | 'user';
  isDefault: boolean;
  name?: string;
  description?: string;
  broken?: string;
}

/** agentPresets/list → value. */
export interface DshPresetListValue {
  presets: DshPresetEntry[];
  authorable?: boolean;
  hasDocument?: boolean;
}

/** One permission preset from `permissionPresets/catalog`. */
export interface DshPermissionPresetOption {
  value: string;
  name: string;
  description?: string;
}

/** `permissionPresets/catalog` → value. */
export interface DshPermissionCatalogValue {
  options: DshPermissionPresetOption[];
  /** Presets that may be selected as the default for future sessions. */
  defaultOptions: DshPermissionPresetOption[];
  defaultPreset: string;
}

/** One durable event record inside a follow snapshot / event frame. */
export interface DshFollowRecord {
  type: 'event';
  event: DshSessionEvent;
}

/** Opening frame of `session/follow`. */
export interface DshFollowSnapshot {
  type: 'snapshot';
  header?: Record<string, unknown>;
  cursor: number;
  records: DshFollowRecord[];
  hasMore?: boolean;
  projections?: DshProjections;
}

/** Assistant stream chunk emitted while the model is still generating. */
export type DshStreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'usage'; usage: DshTokenUsage }
  | { type: string; [key: string]: unknown };

/** One `assistant-stream` item of the follow stream. */
export interface DshAssistantStreamFrame {
  type: 'start' | 'chunk' | 'end';
  attemptId?: string;
  revision?: number;
  index?: number;
  time?: number;
  chunk?: DshStreamChunk;
  outcome?: Record<string, unknown>;
}

/** First item of the Gateway-owned `$events` stream. */
export interface DshRemoteEventReadyFrame {
  type: 'ready';
  clientId: string;
  host: { home: string };
}

/** One pending Agent-scoped approval waterfall delivered by `$events`. */
export interface DshRemoteEventWaterfallFrame {
  type: 'waterfall';
  event: string;
  eventId: string;
  agentId: string;
  request: Record<string, unknown>;
}

/** Cancellation of a previously delivered waterfall. */
export interface DshRemoteEventCancelFrame {
  type: 'cancel';
  eventId: string;
}

/** Ordinary forwarded notification (not used by the DSH approval path). */
export interface DshRemoteEventEmitFrame {
  type: 'emit';
  event: string;
  args: unknown[];
}

/** One item of the Gateway-owned `$events` logical stream. */
export type DshRemoteEventFrame =
  | DshRemoteEventReadyFrame
  | DshRemoteEventWaterfallFrame
  | DshRemoteEventCancelFrame
  | DshRemoteEventEmitFrame;

/** Answer accepted by `$events/result` for one approval waterfall. */
export type DshRemoteEventOutcome =
  | { kind: 'next' }
  | { kind: 'result'; value?: unknown }
  | {
      kind: 'rejected';
      error: { name: string; message: string; code?: string; details?: unknown };
    };

/** One option of a DSH `ask_user_question` prompt. */
export interface DshQuestionOption {
  label: string;
  description?: string;
}

/** One question of a DSH `ask_user_question` prompt (`user-questions/request`). */
export interface DshQuestion {
  id: string;
  question: string;
  header?: string;
  options?: DshQuestionOption[];
  multiSelect?: boolean;
}

/** One answer item of the `$events/result` payload for a question waterfall. */
export interface DshQuestionAnswer {
  id: string;
  selected: string[];
  /** Free-text answer when the user picked none of the offered labels. */
  custom?: string;
}

/** Approval/question items yielded while consuming `$events`. */
export type DshApprovalStreamItem =
  | { kind: 'ready'; clientId: string }
  | {
      kind: 'request';
      eventId: string;
      clientId: string;
      toolName: string;
      callId?: string;
      reason?: string;
    }
  | {
      kind: 'question';
      eventId: string;
      clientId: string;
      questions: DshQuestion[];
    }
  | { kind: 'cancelled'; eventId: string }
  | { kind: 'unavailable'; message: string };

/** One value yielded by a `session/follow` logical stream. */
export type DshFollowFrame =
  | DshFollowSnapshot
  | { type: 'event'; event: DshSessionEvent }
  | { type: 'assistant-stream'; frame: DshAssistantStreamFrame };

/**
 * Normalized `commands/execute` result.
 *
 * DSH's wire value is `CommandExecution { commandId, result: CommandResult }`.
 * The client flattens that envelope so every caller (compact, permission
 * alignment) sees one stable shape. The RPC settles only after the command
 * handler finishes — for `/compact` that means after the compaction completes.
 * `kind:'error'` is an expected outcome (idle-only violation, no compactable
 * history, summary failure), not a transport failure, so callers must surface
 * `text` instead of throwing. `undefined` means the line was not admitted as a
 * known command at all (admission miss logs nothing and runs nothing).
 */
export interface DshCommandResult {
  commandId?: string;
  kind?: 'success' | 'error';
  text?: string;
  sourceEventSeq?: number;
}

/** Unified per-session subscription item: a session event or an approval notice. */
export type DshStreamItem =
  | { kind: 'event'; sessionId: string; event: DshSessionEvent }
  | { kind: 'assistant-stream'; sessionId: string; frame: DshAssistantStreamFrame }
  | {
      kind: 'approval';
      sessionId: string;
      approvalId: string;
      toolName: string;
      callId?: string;
      reason?: string;
    };
