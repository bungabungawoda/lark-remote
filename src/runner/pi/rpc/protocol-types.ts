/**
 * Pi RPC protocol types.
 *
 * pi's `--mode rpc` is a headless JSON-lines protocol over stdio (NOT JSON-RPC):
 *   - client → stdin:  commands `{ type, id, ... }`
 *   - server → stdout: responses `{ id, type:"response", command, success, data|error }`
 *                     and events (session lifecycle / message / compaction) as bare
 *                     JSON objects (no envelope).
 *
 * Turn semantics (verified live against pi 0.84.1, 2026-08-18):
 *   - `prompt` returns an ack (`success:true`) immediately; the turn then streams
 *     events and completes with an `agent_settled` event.
 *   - `compact` runs synchronously and returns its response at completion; it also
 *     streams `compaction_start` / `compaction_end` events.
 *   - `abort` cancels the current operation.
 *   - `get_state` returns the bound session id (`data.sessionId`) — pi binds the
 *     session at spawn via `--session-id`, so this is how a new session's id is
 *     discovered.
 */

// =============================================================================
// Commands (client → server)
// =============================================================================

export type PiRpcCommand =
  | { type: 'prompt'; message: string; images?: unknown[] }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'abort' }
  | { type: 'new_session'; parentSession?: string }
  | { type: 'get_state' };

// =============================================================================
// Responses (server → client)
// =============================================================================

export interface PiRpcGetStateData {
  model?: unknown;
  sessionId: string;
  sessionFile?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  [key: string]: unknown;
}

export interface PiRpcSuccessResponse {
  id?: string | number;
  type: 'response';
  command: string;
  success: true;
  data?: unknown;
}

export interface PiRpcErrorResponse {
  id?: string | number;
  type: 'response';
  command: string;
  success: false;
  error: string;
}

export type PiRpcResponse = PiRpcSuccessResponse | PiRpcErrorResponse;

// =============================================================================
// Events (server → client)
// =============================================================================

export interface PiRpcSessionEvent {
  type: 'session';
  id: string;
  cwd: string;
  model?: string;
}

export interface PiRpcAgentEvent {
  type: 'agent_start' | 'agent_end' | 'agent_settled';
}

export interface PiRpcTurnEvent {
  type: 'turn_start' | 'turn_end';
  message?: { usage?: PiRpcUsage };
}

export interface PiRpcMessageStartEvent {
  type: 'message_start';
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content?: unknown[];
    usage?: PiRpcUsage;
  };
}

export interface PiRpcMessageUpdateEvent {
  type: 'message_update';
  usage?: PiRpcUsage;
  assistantMessageEvent: {
    type:
      | 'text_start'
      | 'text_delta'
      | 'text_end'
      | 'thinking_start'
      | 'thinking_delta'
      | 'thinking_end'
      | 'toolcall_start'
      | 'toolcall_delta'
      | 'toolcall_end';
    contentIndex?: number;
    delta?: string;
    content?: string;
    toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  };
}

export interface PiRpcMessageEndEvent {
  type: 'message_end';
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content?: unknown[];
    usage?: PiRpcUsage;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    stopReason?: string;
    errorMessage?: string;
  };
}

export interface PiRpcCompactionEvent {
  type: 'compaction_start' | 'compaction_end';
  reason?: string;
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: string;
}

export interface PiRpcUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  reasoning?: number;
}

/** Any event line emitted by the pi RPC server (excluding responses). */
export type PiRpcEvent =
  | PiRpcSessionEvent
  | PiRpcAgentEvent
  | PiRpcTurnEvent
  | PiRpcMessageStartEvent
  | PiRpcMessageUpdateEvent
  | PiRpcMessageEndEvent
  | PiRpcCompactionEvent
  | { type: string };
