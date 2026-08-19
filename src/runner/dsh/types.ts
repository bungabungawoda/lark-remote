/**
 * DSH wire type shapes (DeepSeek Harness HTTP proxy contract).
 *
 * Source of truth: packages/host/apiproxy/src/api/{rpc,sessions,events}.ts and
 * packages/core/session/src/types.ts in the deepseek-harness repo. Only the
 * fields DshClient/DshRunner/DshSessionReader consume are declared here.
 *
 * Unary: POST /api/<method>, body `{type:'client-request',rpcId,method,payload}`,
 * response `{type:'server-response',rpcId,result:{ok:true,value}|{ok:false,error}}`.
 * Stream: SSE GET /api/events.mux, frames `data: {type:'server-request',rpcId,
 * method:<frame.type>, payload:<MuxFrame>}\n\n`.
 */

/** One SessionEvent entry (core SessionEvent<T> — seq/time/data discriminated on type). */
export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

/** assistant/chunk chunk payload (StreamChunk). */
export interface DshChunk {
  type: string;
  index?: number;
  text?: string;
}

/** TokenUsage from assistant/message.usage (dsh-llm TokenUsage). */
export interface DshTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** SessionSummary row from session.list items[]. */
export interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  /** 创建时固定的 preset（/resume preset 一致性校验用）。 */
  agentPreset?: string;
}

/** session.list → value. */
export interface DshSessionListValue {
  items: DshSessionSummary[];
}

/** session.history → value.events[].event. */
export interface DshHistoryEntry {
  event: DshSessionEvent;
  view?: unknown;
}

/** session.history → value. */
export interface DshSessionHistoryValue {
  events: DshHistoryEntry[];
  hasMore: boolean;
}

/** One model entry inside a provider group (llm.models / session.models groups[].models[]). */
export interface DshCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string };
}

/** One provider group of the model catalog (llm.models groups[]). */
export interface DshModelGroup {
  id: string;
  name: string;
  models: DshCatalogModel[];
}

/** llm.models → value. */
export interface DshModelCatalogValue {
  groups: DshModelGroup[];
  failures?: Array<{ id: string; name: string; message: string }>;
}

/** Current model selection (session.models current / session.selectModel selected). */
export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** session.models → value. */
export interface DshSessionModelsValue {
  current: DshModelSelection;
  routable: boolean;
  groups: DshModelGroup[];
  failures?: Array<{ id: string; name: string; message: string }>;
}

/** One preset row of agentPreset.list. */
export interface DshPresetEntry {
  id: string;
  trust: 'system' | 'user';
  isDefault: boolean;
  name?: string;
  description?: string;
  broken?: string;
}

/** agentPreset.list → value. */
export interface DshPresetListValue {
  presets: DshPresetEntry[];
  authorable: boolean;
  hasDocument: boolean;
}

/** Mux frame payloads we care about (subset of MuxFrame). */
export type DshMuxFrame =
  | { type: 'session/event'; sessionId: string; event: DshSessionEvent }
  | {
      type: 'approval/requested';
      sessionId: string;
      approvalId: string;
      toolName: string;
      callId?: string;
      reason?: string;
    }
  | { type: 'stream/error'; error: { code: string; message: string } };

/** ServerRequest envelope (frame.method === frame.payload.type). */
export interface DshServerRequest {
  type: 'server-request';
  rpcId: string;
  method: string;
  payload: unknown;
}

/** Unified per-session subscription item: a session event or an approval notice. */
export type DshStreamItem =
  | { kind: 'event'; sessionId: string; event: DshSessionEvent }
  | {
      kind: 'approval';
      sessionId: string;
      approvalId: string;
      toolName: string;
      reason?: string;
    };
