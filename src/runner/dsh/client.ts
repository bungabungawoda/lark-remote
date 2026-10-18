/**
 * DshClient — HTTP/WebSocket client for the DSH Web Host.
 *
 * DSH 0.2.x guardrails:
 *  1. `/api/*` and `/api/remote.mux` require a signed `dsh-auth-*` cookie.
 *     We mint the v1 cookie from DSH's durable browser-session secret; the
 *     launch token remains a fallback via `GET /?token=<launch token>`.
 *  2. Unary calls are POST `/api/<namespace>/<method>` envelopes whose
 *     `payload` is `{args:<request>}`.
 *  3. Live session data is a logical stream over `/api/remote.mux`:
 *     `{type:'open',streamId,endpoint:'session/follow',payload}` →
 *     `{type:'item',streamId,value}` / `{type:'end',streamId}`.
 *     The Gateway-owned `$events` stream carries answerable
 *     `approval/request` waterfalls; answers go back through
 *     `$events/result`.
 *
 * The client is stateless apart from the base URL and auth cookie: each
 * `run()` opens its own remote mux subscription and closes it on terminal.
 * `sessionEvents()` adds per-session filtering, reconnect + follow-snapshot
 * replay, and seq-based dedup.
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { getLogger } from '../../logger/index.js';
import {
  DSH_COOKIE_LIFETIME_MS,
  isDshCredentialsNotFound,
  mintDshBrowserCookie,
  readDshBrowserSecret,
  resolveDshCredentialsFile,
} from './auth.js';
import type {
  DshApprovalStreamItem,
  DshFollowFrame,
  DshModelCatalogValue,
  DshModelSelection,
  DshPermissionCatalogValue,
  DshPresetListValue,
  DshRemoteEventFrame,
  DshRemoteEventOutcome,
  DshSessionEvent,
  DshSessionPageValue,
  DshStreamItem,
  DshTokenUsage,
  DshCommandResult,
} from './types.js';

interface WebSocketMessageEvent {
  data: unknown;
}

export interface WebSocketOptions {
  headers?: Record<string, string>;
}

export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  /** Set by transports that expose an HTTP rejection before the handshake. */
  onunexpectedresponse?: ((event: { statusCode?: number }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string, options?: WebSocketOptions) => WebSocketLike;

function defaultWebSocketFactory(url: string, options?: WebSocketOptions): WebSocketLike {
  const socket = new WebSocket(url, {
    ...(options?.headers ? { headers: options.headers } : {}),
  }) as unknown as WebSocketLike;
  const raw = socket as unknown as WebSocket & {
    on(
      event: 'unexpected-response',
      listener: (request: unknown, response: { statusCode?: number }) => void,
    ): void;
  };
  raw.on('unexpected-response', (_request, response) => {
    socket.onunexpectedresponse?.({ statusCode: response.statusCode });
  });
  return socket;
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

function isDshAuthError(error: unknown): error is DshError {
  return (
    error instanceof DshError &&
    error.code === 'http' &&
    (error.details.status === 401 || error.details.status === 403)
  );
}

/** Backoff between mux reconnects to avoid a hot loop on a dropping server. */
const RECONNECT_BACKOFF_MS = 200;

/** Follow snapshot budget. `session/follow` also stays live after the snapshot. */
const FOLLOW_MAX_MESSAGES = 200;

export interface DshClientOptions {
  /** Configured DSH home; selects `.credentials.yaml` when no explicit file is given. */
  dshHome?: string;
  /**
   * Optional DSH Web launch token. Accepts either the bare token or the full
   * URL printed by `dsh web` (the `token` query parameter is extracted).
   */
  token?: string;
  /**
   * DSH credentials file containing the durable browser-session signing
   * secret. Defaults to `$DSH_HOME/.credentials.yaml` or
   * `~/.dsh/.credentials.yaml`. When readable, this is preferred over the
   * per-process launch token and survives `dsh web` restarts.
   */
  credentialsFile?: string;
  /** Injectable credentials reader (tests). */
  readCredentials?: (file: string) => Promise<Buffer>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Lifetime of minted browser cookies. */
  cookieLifetimeMs?: number;
  fetchImpl?: typeof fetch;
  webSocketImpl?: WebSocketFactory;
  /**
   * Unary request timeout. DSH accepts the HTTP connection but may never answer
   * (e.g. a stuck `session/prompt`); without a timeout the run generator stays
   * parked in `await unary()` forever, so /stop and the idle watchdog cannot
   * release the bridge's workspace queue.
   */
  requestTimeoutMs?: number;
}

/** Default unary timeout: long prompts are unbounded on the server side. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Extract the `token` query parameter from a pasted `dsh web` URL. */
export function extractDshToken(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (!value.includes('token=') && !value.includes('://')) return value;
  try {
    const url = new URL(value.startsWith('?') ? `http://dsh.invalid/${value}` : value);
    return url.searchParams.get('token') ?? value;
  } catch {
    return value;
  }
}

/**
 * Remote methods take named parameters. Most session methods call their single
 * argument `request`; `session/list` reserves `_request`; catalog methods take
 * no arguments. `commands/*` address the receiving agent by its wire field
 * `agentId`, so their payload is already in wire shape (pass-through).
 * The gateway rejects any other `args` shape.
 */
const DSH_ARGS_KEY: Record<string, string | null> = {
  'session/list': '_request',
  'session/create': 'request',
  'session/prompt': 'request',
  'session/cancel': 'request',
  'session/selectModel': 'request',
  'session/projections': 'request',
  'session/page': 'request',
  'session/follow': 'request',
  'session/modelCatalog': null,
  'agentPresets/list': null,
  'permissionPresets/catalog': null,
};

export function dshArgs(method: string, payload: unknown): Record<string, unknown> {
  const key = DSH_ARGS_KEY[method];
  if (key === null) return {};
  if (key === undefined) return payload as Record<string, unknown>;
  return { [key]: payload };
}

export class DshClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly credentialsFile: string;
  private readonly readCredentials: (file: string) => Promise<Buffer>;
  private readonly now: () => number;
  private readonly cookieLifetimeMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketImpl: WebSocketFactory;
  private readonly requestTimeoutMs: number;
  private cookiePromise?: Promise<string | undefined>;

  constructor(baseUrl: string, options: DshClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = extractDshToken(options.token);
    this.credentialsFile =
      options.credentialsFile?.trim() || resolveDshCredentialsFile(process.env, options.dshHome);
    this.readCredentials = options.readCredentials ?? readDshBrowserSecret;
    this.now = options.now ?? Date.now;
    this.cookieLifetimeMs = options.cookieLifetimeMs ?? DSH_COOKIE_LIFETIME_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketImpl = options.webSocketImpl ?? defaultWebSocketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Resolve a DSH browser cookie. The durable credentials file is read on every
   * call so a rotated signing secret is picked up without restarting
   * lark-remote. Token bootstrap remains a fallback for hosts without that
   * file; unlike `/connect`, the index handshake mints a v1 cookie that DSH
   * accepts for API and WebSocket requests across its own restarts.
   */
  private async authCookie(force = false, signal?: AbortSignal): Promise<string | undefined> {
    const fromCredentials = await this.cookieFromCredentials();
    if (fromCredentials) return fromCredentials;
    if (!this.token) return undefined;
    if (force) this.cookiePromise = undefined;
    if (!this.cookiePromise) {
      this.cookiePromise = (async (): Promise<string> => {
        const url = `${this.baseUrl}/?token=${encodeURIComponent(this.token)}`;
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            ...(signal ? { signal } : {}),
          });
        } catch (err) {
          if (signal?.aborted) throw err;
          throw new DshError('transport', `DSH auth transport error: ${(err as Error).message}`);
        }
        if (res.status !== 303 && !res.ok) {
          throw new DshError(
            'http',
            `DSH auth HTTP ${res.status}: 凭据文件不可用，且 dsh web 启动 token 无效`,
            { status: res.status },
          );
        }
        const setCookies =
          typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : [res.headers.get('set-cookie')].filter((v): v is string => !!v);
        const cookie = setCookies
          .map((value) => value.split(';')[0]?.trim())
          .filter((value): value is string => !!value)
          .join('; ');
        if (!cookie) {
          throw new DshError('auth', 'DSH index handshake did not return a session cookie');
        }
        return cookie;
      })();
      // A failed handshake must not poison later retries (e.g. after the user
      // updates agents.dsh.token in config.yaml and the runner is rebuilt).
      this.cookiePromise.catch(() => {
        this.cookiePromise = undefined;
      });
    }
    return this.cookiePromise;
  }

  /** Mint a v1 browser cookie from DSH's durable signing secret. */
  private async cookieFromCredentials(): Promise<string | undefined> {
    try {
      const secret = await this.readCredentials(this.credentialsFile);
      return mintDshBrowserCookie(this.baseUrl, secret, this.now(), this.cookieLifetimeMs);
    } catch (err) {
      if (isDshCredentialsNotFound(err)) return undefined;
      if (this.token) {
        getLogger().warn(
          `[dsh] cannot use DSH credentials file ${this.credentialsFile}: ${(err as Error).message}; ` +
            'falling back to the launch token',
        );
        return undefined;
      }
      throw new DshError(
        'auth',
        `DSH auth credentials file ${this.credentialsFile}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Perform a unary POST and return the ok value; throws DshError on failure.
   *
   * `signal` aborts the request when the run is stopped; a timeout (default
   * `requestTimeoutMs`) guards against a server that accepted the connection
   * but never answers. Both are composed into the request's AbortSignal.
   */
  async unary(
    method: string,
    payload: unknown,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const _timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    // 0/负数 = 不设超时（兼容「长请求不取消」的配置），其余走 AbortSignal.timeout。
    const timeoutSignal = _timeoutMs > 0 ? AbortSignal.timeout(_timeoutMs) : undefined;
    const signal =
      opts.signal && timeoutSignal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : (opts.signal ?? timeoutSignal);
    const rpcId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (opts.signal?.aborted) {
        throw new DshError('aborted', `DSH unary ${method} aborted before send`);
      }
      let cookie: string | undefined;
      try {
        cookie = await this.authCookie(attempt > 0, signal);
      } catch (err) {
        if (opts.signal?.aborted || signal?.aborted) {
          throw this.abortError(method, err, opts.signal, timeoutSignal, _timeoutMs);
        }
        // A token bootstrap can race a DSH restart; retry once with a fresh
        // credentials read before surfacing the deterministic auth failure.
        if (
          attempt === 0 &&
          err instanceof DshError &&
          err.code === 'http' &&
          err.details.status === 401
        ) {
          continue;
        }
        throw err;
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cookie) headers.cookie = cookie;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method,
            payload: { args: dshArgs(method, payload) },
          }),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (opts.signal?.aborted || signal?.aborted) {
          throw this.abortError(method, err, opts.signal, timeoutSignal, _timeoutMs);
        }
        throw new DshError(
          'transport',
          `DSH unary ${method} transport error: ${(err as Error).message}`,
        );
      }
      if (opts.signal?.aborted) {
        throw new DshError('aborted', `DSH unary ${method} aborted`);
      }
      if (res.status === 401 && attempt === 0) {
        this.cookiePromise = undefined;
        continue;
      }
      if (res.status === 401) {
        throw new DshError(
          'http',
          `DSH HTTP 401 for ${method}: 认证失败；请确认 ${this.credentialsFile} 可读，` +
            '或在 config.yaml 的 agents.dsh.token 填入当前 dsh web 启动 token。' +
            '若凭据文件可读且格式正确，可能是 DSH 版本改变了 cookie 认证格式',
          { status: 401 },
        );
      }
      if (!res.ok) {
        throw new DshError('http', `DSH HTTP ${res.status} for ${method}`, {
          status: res.status,
        });
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
        throw new DshError(
          'protocol',
          `DSH ${method} returned non-JSON: ${(err as Error).message}`,
        );
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
    throw new DshError('auth', `DSH ${method} authentication failed after refresh`);
  }

  /** Distinguish "run stopped" (abort) from "server did not answer" (timeout). */
  private abortError(
    method: string,
    err: unknown,
    runSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): DshError {
    if (runSignal?.aborted) {
      return new DshError('aborted', `DSH unary ${method} aborted`, { cause: err });
    }
    if (timeoutSignal?.aborted) {
      return new DshError('timeout', `DSH unary ${method} timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    return new DshError('aborted', `DSH unary ${method} aborted: ${(err as Error).message}`);
  }

  /** Create a session. Pass `agentPreset` to pin the session's preset (fixed at
   *  creation). */
  async createSession(
    payload: {
      cwd: string;
      agentPreset?: string;
    },
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ sessionId: string; agentPreset?: string }> {
    return (await this.unary('session/create', payload, opts)) as {
      sessionId: string;
      agentPreset?: string;
    };
  }

  /** Align the session's model/reasoningEffort (also persists as global default
   *  server-side). Failures are surfaced as DshError for the caller to downgrade. */
  async selectModel(
    payload: DshModelSelection & { sessionId: string },
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DshModelSelection> {
    const value = (await this.unary('session/selectModel', payload, opts)) as {
      selected: DshModelSelection;
    };
    return value.selected;
  }

  /** Read the model catalog (session/modelCatalog). */
  async listModels(): Promise<DshModelCatalogValue> {
    return (await this.unary('session/modelCatalog', {})) as DshModelCatalogValue;
  }

  /**
   * Execute one slash command against a session (commands/execute).
   *
   * This is the only way to run a DSH command: `session/prompt` turns the text
   * into an ordinary user message and never routes it through the command
   * registry, so `/compact` sent as a prompt would just be model input.
   *
   * The RPC settles when the handler settles, not when it is accepted: DSH's
   * `/compact` waits for the compaction to finish. Callers therefore must pass
   * an explicit `timeoutMs` (0 = no unary budget) and rely on their own
   * cancellation/watchdog instead of the 60s default.
   */
  async executeCommand(
    sessionId: string,
    line: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DshCommandResult | undefined> {
    const value = (await this.unary(
      'commands/execute',
      { agentId: sessionId, line, submittedAttachments: [] },
      opts,
    )) as
      | {
          commandId?: unknown;
          result?: { kind?: unknown; text?: unknown; sourceEventSeq?: unknown };
          kind?: unknown;
          text?: unknown;
          sourceEventSeq?: unknown;
        }
      | undefined;
    if (!value || typeof value !== 'object') return undefined;
    const result = value.result && typeof value.result === 'object' ? value.result : value;
    return {
      ...(typeof value.commandId === 'string' ? { commandId: value.commandId } : {}),
      ...(result.kind === 'success' || result.kind === 'error' ? { kind: result.kind } : {}),
      ...(typeof result.text === 'string' ? { text: result.text } : {}),
      ...(typeof result.sourceEventSeq === 'number'
        ? { sourceEventSeq: result.sourceEventSeq }
        : {}),
    };
  }

  /** Read the preset catalog (agentPresets/list). */
  async listPresets(): Promise<DshPresetListValue> {
    return (await this.unary('agentPresets/list', {})) as DshPresetListValue;
  }

  /** Read the permission preset catalog (permissionPresets/catalog). */
  async listPermissionPresets(): Promise<DshPermissionCatalogValue> {
    return (await this.unary('permissionPresets/catalog', {})) as DshPermissionCatalogValue;
  }

  /** Answer one forwarded approval waterfall ($events/result). */
  async answerRemoteEvent(
    clientId: string,
    eventId: string,
    outcome: DshRemoteEventOutcome,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    await this.unary('$events/result', { clientId, eventId, outcome }, opts);
  }

  /**
   * Return the highest event `seq` currently persisted for the session.
   *
   * `session/projections` is the unary watermark (the old `session.history`
   * high-water scan is gone in 0.2.x). The caller snapshots this before
   * `session/prompt` so a follow snapshot can skip already-completed turns.
   */
  async latestEventSeq(
    sessionId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<number> {
    const value = (await this.unary('session/projections', { sessionId }, opts)) as {
      asOfSeq?: number;
    } | null;
    return typeof value?.asOfSeq === 'number' ? value.asOfSeq : -1;
  }

  /** Read one cold history page. `throughSeq` normally comes from
   *  `latestEventSeq()`; `session/page` needs an inclusive cursor. */
  async page(
    sessionId: string,
    throughSeq: number,
    maxMessages: number,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DshSessionPageValue> {
    return (await this.unary(
      'session/page',
      {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages,
      },
      opts,
    )) as DshSessionPageValue;
  }

  /**
   * One logical stream over `/api/remote.mux`. The WebSocket must carry the
   * same auth cookie as unary calls. Ends on the server's `end` frame, socket
   * close, error, or `signal` abort.
   */
  private async *muxStream(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<unknown> {
    const cookie = await this.authCookie();
    const socket = this.webSocketImpl(
      `${this.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`,
      cookie ? { headers: { cookie } } : undefined,
    );
    const streamId = `lr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const queue: unknown[] = [];
    let waiter: ((frame: unknown | undefined) => void) | null = null;
    let ended = false;
    let failure: DshError | undefined;

    const settle = (frame?: unknown): void => {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(frame);
        return;
      }
      if (frame) queue.push(frame);
      else ended = true;
    };

    socket.onopen = () => {
      if (ended) return;
      try {
        socket.send(
          JSON.stringify({
            type: 'open',
            streamId,
            endpoint,
            payload,
          }),
        );
      } catch (err) {
        failure = new DshError('transport', `DSH remote mux send error: ${(err as Error).message}`);
        ended = true;
        settle(undefined);
      }
    };
    socket.onmessage = (event) => {
      if (ended) return;
      const text =
        typeof event.data === 'string'
          ? event.data
          : Buffer.isBuffer(event.data)
            ? event.data.toString('utf8')
            : String(event.data);
      let message: {
        type?: string;
        streamId?: string;
        value?: unknown;
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      };
      try {
        message = JSON.parse(text) as typeof message;
      } catch {
        getLogger().warn('[dsh] dropped malformed remote mux frame');
        return;
      }
      if (message.streamId !== streamId) return;
      if (message.type === 'item' && message.value) {
        settle(message.value);
        return;
      }
      if (message.type === 'end') {
        ended = true;
        settle(undefined);
        return;
      }
      if (message.type === 'error') {
        failure = new DshError(
          message.error?.code ?? 'stream',
          message.error?.message ?? 'DSH remote stream failed',
          message.error?.details ?? {},
        );
        ended = true;
        settle(undefined);
      }
    };
    socket.onerror = () => {
      if (ended) return;
      failure = new DshError('transport', 'DSH remote mux WebSocket error');
      ended = true;
      settle(undefined);
    };
    socket.onunexpectedresponse = (event) => {
      if (ended) return;
      const status = event.statusCode;
      failure = new DshError(
        'http',
        `DSH remote mux WebSocket HTTP ${status === undefined ? 'error' : status}`,
        status === undefined ? {} : { status },
      );
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

    const next = (): Promise<unknown | undefined> =>
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

  /** One logical `session/follow` stream. */
  private async *followStream(
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<DshFollowFrame> {
    const payload = {
      args: dshArgs('session/follow', {
        address: { kind: 'session', sessionId },
        assistantStream: true,
        maxMessages: FOLLOW_MAX_MESSAGES,
      }),
    };
    for await (const frame of this.muxStream('session/follow', payload, signal)) {
      yield frame as DshFollowFrame;
    }
  }

  /**
   * Consume the Gateway-owned `$events` stream. The stream is owner-only and
   * answer-capable; each waterfall for another session is delegated with
   * `next` so a different lark-remote workspace cannot park it.
   */
  async *approvalEvents(
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<DshApprovalStreamItem> {
    let authRefreshAttempted = false;
    let reconnectAttempts = 0;
    while (!signal.aborted) {
      let streamClientId: string | undefined;
      let sawReady = false;
      try {
        for await (const raw of this.muxStream('$events', { args: {} }, signal)) {
          if (signal.aborted) return;
          const frame = raw as DshRemoteEventFrame;
          if (frame.type === 'ready') {
            authRefreshAttempted = false;
            sawReady = true;
            streamClientId = frame.clientId;
            yield { kind: 'ready', clientId: streamClientId };
            continue;
          }
          if (frame.type === 'waterfall') {
            if (!streamClientId) {
              yield {
                kind: 'unavailable',
                message: 'DSH approval stream sent a waterfall before ready',
              };
              return;
            }
            if (frame.event !== 'approval/request' || frame.agentId !== sessionId) {
              // Every owner answerer receives the waterfall. A non-owner of
              // the session must explicitly delegate, otherwise DSH waits.
              void this.answerRemoteEvent(
                streamClientId,
                frame.eventId,
                { kind: 'next' },
                { signal },
              ).catch((err: unknown) => {
                if (!signal.aborted) {
                  getLogger().warn(
                    `[dsh] approval waterfall delegation failed eventId=${frame.eventId}: ${
                      (err as Error).message
                    }`,
                  );
                }
              });
              continue;
            }
            const data = frame.request;
            const toolName = typeof data.toolName === 'string' ? data.toolName : '';
            const callId = typeof data.callId === 'string' ? data.callId : undefined;
            const reason = typeof data.reason === 'string' ? data.reason : undefined;
            yield {
              kind: 'request',
              eventId: frame.eventId,
              clientId: streamClientId,
              toolName,
              ...(callId ? { callId } : {}),
              ...(reason ? { reason } : {}),
            };
            continue;
          }
          if (frame.type === 'cancel') {
            yield { kind: 'cancelled', eventId: frame.eventId };
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        if (
          err instanceof DshError &&
          err.code === 'http' &&
          err.details.status === 401 &&
          !authRefreshAttempted
        ) {
          authRefreshAttempted = true;
          this.cookiePromise = undefined;
          getLogger().warn(
            `[dsh] approval event stream authentication expired; refreshing credentials and reconnecting once`,
          );
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        const forbidden =
          (err instanceof DshError &&
            (err.code === 'gateway/interactions-forbidden' ||
              (err.code === 'http' && err.details.status === 403))) ||
          message.includes('interactions-forbidden');
        if (!forbidden && reconnectAttempts < 3) {
          reconnectAttempts += 1;
          getLogger().warn(
            `[dsh] approval event stream dropped (attempt ${reconnectAttempts}/3); reconnecting`,
          );
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        getLogger().warn(`[dsh] approval event stream unavailable: ${message}`);
        yield { kind: 'unavailable', message };
        return;
      }
      if (!signal.aborted) {
        if (sawReady && reconnectAttempts < 3) {
          reconnectAttempts += 1;
          getLogger().warn(
            `[dsh] approval event stream ended (attempt ${reconnectAttempts}/3); reconnecting`,
          );
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        // A clean end before ready means the Host does not expose `$events`;
        // fall back to the Web UI prompt instead of retrying forever.
        yield { kind: 'unavailable', message: 'DSH approval event stream ended' };
        return;
      }
    }
  }

  /** Translate one durable event into a stream item (approvals are surfaced
   *  separately; everything else is forwarded to the runner). */
  private eventItem(sessionId: string, event: DshSessionEvent): DshStreamItem | undefined {
    if (event.type === 'approval/asked') {
      const data = event.data as {
        id?: string;
        toolName?: string;
        callId?: string;
        reason?: string;
      };
      if (!data.id) return undefined;
      return {
        kind: 'approval',
        sessionId,
        approvalId: data.id,
        toolName: data.toolName ?? '',
        ...(data.callId ? { callId: data.callId } : {}),
        ...(data.reason ? { reason: data.reason } : {}),
      };
    }
    return { kind: 'event', sessionId, event };
  }

  /**
   * Per-session subscription: yields session events, assistant stream chunks
   * and approval notices for `sessionId`, auto-reconnecting on stream
   * drop/error and replaying the follow snapshot (dedup by seq). Terminates on
   * turn/end or `signal` abort.
   */
  async *sessionEvents(
    sessionId: string,
    signal: AbortSignal,
    initialSeq = -1,
  ): AsyncGenerator<DshStreamItem> {
    const state = { lastSeq: initialSeq };
    let authRefreshAttempted = false;
    while (!signal.aborted) {
      try {
        for await (const frame of this.followStream(sessionId, signal)) {
          if (signal.aborted) return;
          authRefreshAttempted = false;
          if (frame.type === 'snapshot') {
            for (const record of frame.records ?? []) {
              const ev = record.event;
              if (!ev || ev.seq <= state.lastSeq) continue;
              state.lastSeq = ev.seq;
              const item = this.eventItem(sessionId, ev);
              if (item) yield item;
              if (ev.type === 'turn/end') return;
            }
            continue;
          }
          if (frame.type === 'event') {
            const ev = frame.event;
            if (ev.seq <= state.lastSeq) continue;
            state.lastSeq = ev.seq;
            const item = this.eventItem(sessionId, ev);
            if (item) yield item;
            if (ev.type === 'turn/end') return;
            continue;
          }
          if (frame.type === 'assistant-stream') {
            yield { kind: 'assistant-stream', sessionId, frame: frame.frame };
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        // A DSH restart invalidates the process-local v2 operator cookie. A
        // fresh credentials read mints a new v1 cookie, so retry once; a
        // second auth failure is deterministic and belongs on the run card.
        if (isDshAuthError(err)) {
          if (!authRefreshAttempted) {
            authRefreshAttempted = true;
            this.cookiePromise = undefined;
            getLogger().warn(
              `[dsh] remote mux authentication expired for session ${sessionId}; refreshing credentials and reconnecting once`,
            );
            continue;
          }
          throw err;
        }
        getLogger().warn(
          `[dsh] remote mux disconnected for session ${sessionId}: ${(err as Error).message}; reconnecting`,
        );
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS));
    }
  }

  /** Extract TokenUsage from an assistant/message data payload (absent → undefined). */
  static usageOf(data: Record<string, unknown>): DshTokenUsage | undefined {
    return (data.usage as DshTokenUsage | undefined) ?? undefined;
  }
}

/** Stable client-side prompt identity persisted on the accepted user message. */
export function newPromptRequestId(): string {
  return `lark-remote-${randomUUID()}`;
}
