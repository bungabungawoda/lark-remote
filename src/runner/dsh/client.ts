/**
 * DshClient — HTTP client for the DSH Web Host proxy.
 *
 * Two transports:
 *  1. unary POST /api/<method> (client-request → server-response).
 *  2. SSE GET /api/events.mux (all-session aggregated stream). Frames are
 *     ServerRequest envelopes; `method` equals the MuxFrame's `type`.
 *
 * The client is stateless apart from the base URL: each `run()` opens its own
 * mux subscription and closes it on terminal. `sessionEvents()` wraps the raw
 * mux with per-session filtering plus reconnect + history-replay dedup
 * (DSH v1 has no `since` resume — reconnection = reopen stream + refetch
 * history, dedup by event seq).
 */

import { getLogger } from '../../logger/index.js';
import type {
  DshModelCatalogValue,
  DshModelSelection,
  DshPresetListValue,
  DshServerRequest,
  DshSessionEvent,
  DshSessionModelsValue,
  DshStreamItem,
  DshTokenUsage,
} from './types.js';

interface WebSocketMessageEvent {
  data: unknown;
}

interface WebSocketLike {
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

function defaultWebSocketFactory(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('DSH WebSocket is unavailable');
  return new Ctor(url);
}

export class DshError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DshError';
    this.code = code;
    this.details = details;
  }
}

/** Backoff between mux reconnects to avoid a hot loop on a dropping server. */
const RECONNECT_BACKOFF_MS = 200;

export class DshClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketImpl: WebSocketFactory;

  constructor(
    baseUrl: string,
    fetchImpl: typeof fetch = fetch,
    webSocketImpl: WebSocketFactory = defaultWebSocketFactory,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.webSocketImpl = webSocketImpl;
  }

  /** Perform a unary POST and return the ok value; throws DshError on failure. */
  async unary(method: string, payload: unknown): Promise<unknown> {
    const rpcId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      });
    } catch (err) {
      throw new DshError(
        'transport',
        `DSH unary ${method} transport error: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new DshError('http', `DSH HTTP ${res.status} for ${method}`);
    }
    let body: {
      result?: {
        ok?: boolean;
        value?: unknown;
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      };
    };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw new DshError('protocol', `DSH ${method} returned non-JSON: ${(err as Error).message}`);
    }
    if (body.result?.ok !== true) {
      const err = body.result?.error;
      throw new DshError(
        err?.code ?? 'error',
        err?.message ?? `DSH ${method} failed`,
        err?.details ?? {},
      );
    }
    return body.result.value;
  }

  /** Create a session. Pass `agentPreset` to pin the session's preset (fixed at
   *  creation). */
  async createSession(payload: {
    cwd: string;
    agentPreset?: string;
  }): Promise<{ sessionId: string; agentPreset?: string }> {
    return (await this.unary('session.create', payload)) as {
      sessionId: string;
      agentPreset?: string;
    };
  }

  /** Align the session's model/reasoningEffort (also persists as global default
   *  server-side). Failures are surfaced as DshError for the caller to downgrade. */
  async selectModel(
    payload: DshModelSelection & { sessionId: string },
  ): Promise<DshModelSelection> {
    const value = (await this.unary('session.selectModel', payload)) as {
      selected: DshModelSelection;
    };
    return value.selected;
  }

  /** Read the session's current model selection + full model catalog. */
  async sessionModels(sessionId: string): Promise<DshSessionModelsValue> {
    return (await this.unary('session.models', { sessionId })) as DshSessionModelsValue;
  }

  /** Read the model catalog (session-independent, llm.models). */
  async listModels(): Promise<DshModelCatalogValue> {
    return (await this.unary('llm.models', {})) as DshModelCatalogValue;
  }

  /** Read the preset catalog (agentPreset.list). */
  async listPresets(): Promise<DshPresetListValue> {
    return (await this.unary('agentPreset.list', {})) as DshPresetListValue;
  }

  /**
   * Return the highest event `seq` currently persisted in session.history.
   *
   * The caller snapshots this before `session.prompt`. `session.history` is a
   * full-session replay rather than a delta, so this high-water mark is what
   * lets a subsequent replay skip every already-completed turn.
   */
  async latestEventSeq(sessionId: string): Promise<number> {
    const value = (await this.unary('session.history', {
      sessionId,
      maxMessages: 1,
    })) as { events?: { event?: DshSessionEvent }[] };

    let max = -1;
    for (const entry of value.events ?? []) {
      const seq = entry.event?.seq;
      if (typeof seq === 'number' && seq > max) max = seq;
    }
    return max;
  }

  /**
   * Raw SSE mux stream: yields ServerRequest envelopes until the stream ends,
   * errors, or `signal` aborts. Does NOT reconnect (the caller owns retry).
   */
  async *mux(signal: AbortSignal): AsyncGenerator<DshServerRequest> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/events.mux`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      throw new DshError('transport', `DSH mux open error: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      throw new DshError('http', `DSH mux HTTP ${res.status}`, { status: res.status });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        if (signal.aborted) break;
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (err) {
          if (signal.aborted) break;
          throw new DshError('transport', `DSH mux read error: ${(err as Error).message}`);
        }
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const json = dataLine.slice(5).trim();
          if (!json) continue;
          try {
            const frame = JSON.parse(json) as DshServerRequest;
            if (frame?.type === 'server-request') yield frame;
          } catch {
            getLogger().warn('[dsh] dropped malformed mux frame');
          }
        }
      }
    } finally {
      reader.releaseLock();
      try {
        await res.body.cancel();
      } catch {
        /* ignore cancel error */
      }
    }
  }

  /**
   * WebSocket mux stream. The real DSH `/api/events.mux` endpoint is a
   * WebSocket upgrade, not HTTP SSE: each text message is already a
   * `DshServerRequest` JSON envelope. This yields those envelopes and ends on
   * close/abort, letting `sessionEvents()` reconnect through the same
   * history-replay loop.
   */
  async *muxWebSocket(signal: AbortSignal): AsyncGenerator<DshServerRequest> {
    let socket: WebSocketLike;
    try {
      socket = this.webSocketImpl(`${this.baseUrl.replace(/^http/, 'ws')}/api/events.mux`);
    } catch (err) {
      throw new DshError('transport', `DSH mux WebSocket open error: ${(err as Error).message}`);
    }

    const queue: DshServerRequest[] = [];
    let waiter: ((frame: DshServerRequest | undefined) => void) | null = null;
    let ended = false;
    let failure: DshError | undefined;

    const settle = (frame?: DshServerRequest): void => {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(frame);
        return;
      }
      if (frame) queue.push(frame);
      else ended = true;
    };

    socket.onmessage = (event) => {
      if (ended) return;
      if (typeof event.data !== 'string') return;
      try {
        const frame = JSON.parse(event.data) as DshServerRequest;
        if (frame?.type === 'server-request') settle(frame);
      } catch {
        getLogger().warn('[dsh] dropped malformed WebSocket mux frame');
      }
    };
    socket.onerror = () => {
      if (ended) return;
      failure = new DshError('transport', 'DSH mux WebSocket error');
      ended = true;
      settle(undefined);
    };
    socket.onclose = () => {
      if (ended) return;
      ended = true;
      settle(undefined);
    };

    const onAbort = (): void => {
      if (ended) return;
      ended = true;
      settle(undefined);
      try {
        socket.close();
      } catch {
        /* ignore close error */
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const next = (): Promise<DshServerRequest | undefined> =>
      new Promise((resolve) => {
        if (queue.length > 0) {
          resolve(queue.shift());
          return;
        }
        if (ended) {
          resolve(undefined);
          return;
        }
        waiter = resolve;
      });

    try {
      while (!signal.aborted) {
        const frame = await next();
        if (frame === undefined) {
          if (failure && !signal.aborted) throw failure;
          return;
        }
        yield frame;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        socket.close();
      } catch {
        /* ignore close error */
      }
    }
  }

  /**
   * Replay session.history events that are newer than `state.lastSeq`, updating
   * `state.lastSeq` as it goes. Yields each non-duplicate SessionEvent. Used for
   * both the initial baseline (first subscription) and reconnect gap-fill.
   */
  private async *replayHistory(
    sessionId: string,
    signal: AbortSignal,
    state: { lastSeq: number },
    logTag: string,
  ): AsyncGenerator<DshSessionEvent> {
    try {
      const value = (await this.unary('session.history', {
        sessionId,
        maxMessages: 100,
      })) as { events?: { event?: DshSessionEvent }[] };
      for (const entry of value.events ?? []) {
        if (signal.aborted) return;
        const ev = entry.event;
        if (!ev) continue;
        const seq = ev.seq;
        if (typeof seq === 'number' && seq <= state.lastSeq) continue;
        if (typeof seq === 'number') state.lastSeq = seq;
        yield ev;
      }
    } catch (err) {
      if (signal.aborted) return;
      getLogger().warn(
        `[dsh] ${logTag} failed for session ${sessionId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Per-session subscription: yields session events (and approval notices) for
   * `sessionId`, auto-reconnecting on stream drop/error and replaying
   * `session.history` to fill the gap (dedup by seq). Terminates on turn/end
   * or `signal` abort.
   */
  async *sessionEvents(
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
    initialSeq = -1,
  ): AsyncGenerator<DshStreamItem> {
    const state = { lastSeq: initialSeq };

    // Initial baseline: before opening the first live mux subscription, replay
    // history once so events produced between prompt-accept and the mux opening
    // (e.g. a fast turn that already ended) are not lost. Dedup by seq keeps the
    // replay and the live stream convergent.
    for await (const ev of this.replayHistory(
      sessionId,
      signal,
      state,
      'initial history baseline',
    )) {
      if (signal.aborted) return;
      yield { kind: 'event', sessionId, event: ev };
      if (ev.type === 'turn/end') return;
    }

    let muxMode: 'fetch' | 'websocket' = 'fetch';

    while (!signal.aborted) {
      let dropped = false;
      try {
        const frames = muxMode === 'websocket' ? this.muxWebSocket(signal) : this.mux(signal);
        for await (const frame of frames) {
          if (signal.aborted) return;
          if (frame.method === 'stream/error') {
            dropped = true;
            break;
          }
          if (frame.method === 'approval/requested') {
            const p = frame.payload as
              | {
                  sessionId?: string;
                  approvalId?: string;
                  toolName?: string;
                  reason?: string;
                }
              | undefined;
            if (p?.sessionId === sessionId && p.approvalId) {
              yield {
                kind: 'approval',
                sessionId,
                approvalId: p.approvalId,
                toolName: p.toolName ?? '',
                reason: p.reason,
              };
            }
            continue;
          }
          if (frame.method !== 'session/event') continue;
          const payload = frame.payload as
            { sessionId?: string; event?: DshSessionEvent } | undefined;
          if (!payload || payload.sessionId !== sessionId || !payload.event) continue;
          const seq = payload.event.seq;
          if (typeof seq === 'number' && seq <= state.lastSeq) continue; // dedup
          if (typeof seq === 'number') state.lastSeq = seq;
          yield { kind: 'event', sessionId, event: payload.event };
          if (payload.event.type === 'turn/end') return;
        }
        dropped = true; // stream closed normally → treat as drop, replay history
      } catch (err) {
        if (signal.aborted) return;
        if (
          muxMode === 'fetch' &&
          err instanceof DshError &&
          err.code === 'http' &&
          err.details.status === 426
        ) {
          getLogger().info(
            `[dsh] mux endpoint requires WebSocket upgrade; switching transports for session ${sessionId}`,
          );
          muxMode = 'websocket';
          dropped = true;
          continue;
        }
        getLogger().warn(
          `[dsh] mux disconnected for session ${sessionId}: ${(err as Error).message}; replaying history`,
        );
        dropped = true;
      }
      if (signal.aborted) return;
      if (!dropped) break;

      // Reconnect baseline: replay history events after lastSeq (dedup keeps
      // the live stream and the replay convergent).
      for await (const ev of this.replayHistory(sessionId, signal, state, 'history replay')) {
        if (signal.aborted) return;
        yield { kind: 'event', sessionId, event: ev };
        if (ev.type === 'turn/end') return;
      }

      // Bound reconnect frequency.
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS));
    }
  }

  /** Extract TokenUsage from an assistant/message data payload (absent → undefined). */
  static usageOf(data: Record<string, unknown>): DshTokenUsage | undefined {
    return (data.usage as DshTokenUsage | undefined) ?? undefined;
  }
}
