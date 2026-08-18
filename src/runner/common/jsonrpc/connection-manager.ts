/**
 * ConnectionManager: manages agent-server connections per workspace, shared by
 * all workspace-lifetime JSON-line runners (codex app-server, kimi acp,
 * opencode acp, and pi rpc).
 *
 * Each workspace gets its own connection (transport + client). Connections are
 * created on demand via `acquire()`, cached for reuse, and released after an
 * idle timeout (30 minutes default).
 *
 * The manager is protocol-agnostic over the concrete client. The default
 * `clientFactory` builds a JsonRpcClient with the `initialize` handshake (the
 * ACP-style reference protocol); protocols that are NOT JSON-RPC (pi's
 * `--mode rpc`, which has no handshake and binds the session at spawn) inject
 * their own `clientFactory` + `buildArgs` + `shouldReuse` + `bindSession`.
 */

import { JsonlRpcTransport } from './transport.js';
import { JsonRpcClient } from './client.js';
import { getLogger } from '../../../logger/index.js';

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000; // 60 seconds

/** Minimal client surface the manager needs from any protocol client. */
export interface ConnectionClient {
  ready: boolean;
  healthy: boolean;
  connect(): Promise<unknown>;
  dispose(): Promise<void>;
}

/** Request context for acquire() — currently only an optional session id. */
export interface AcquireRequest {
  sessionId?: string;
}

/** Context passed to clientFactory to build + wire a concrete client. */
export interface ClientFactoryContext {
  transport: JsonlRpcTransport;
  requestTimeoutMs: number;
  /** Wire into the client's close callback so slot cleanup + onConnectionLost fire. */
  baseOnClose: () => void;
}

export interface ConnectionManagerOptions<TClient extends ConnectionClient = JsonRpcClient> {
  /** Path to the server binary. */
  binary: string;
  /**
   * Args to spawn the server with. Defaults to `[]` — each protocol's runner
   * injects its own default (e.g. codex `['app-server', '--stdio']`, kimi
   * `['acp']`).
   */
  args?: string[];
  /**
   * Optional arg builder over the acquire request — used by protocols that bind
   * a session at spawn (pi: `--session-id`). Defaults to `() => this.args`.
   */
  buildArgs?: (req: AcquireRequest) => string[];
  /** Environment variables to pass to the binary. */
  env?: Record<string, string | undefined>;
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Idle TTL in milliseconds. */
  idleTtlMs?: number;
  /**
   * Initialize handshake params for the default JsonRpcClient path. Ignored
   * when `clientFactory` is provided.
   */
  initializeParams?: object;
  /**
   * Build + wire a concrete protocol client. Defaults to a JsonRpcClient with
   * the initialize handshake. Non-JSON-RPC protocols inject their own client.
   */
  clientFactory?: (ctx: ClientFactoryContext) => TClient;
  /**
   * Whether an existing (cached) connection can be reused for a request.
   * Defaults to `client.ready && client.healthy`. Session-bound protocols (pi)
   * additionally require the requested session id to match the bound one.
   */
  shouldReuse?: (ctx: {
    client: TClient;
    req: AcquireRequest;
    boundSessionId: string | undefined;
  }) => boolean;
  /** Log tag prefix for operational log lines. */
  logTag?: string;
}

interface Slot<TClient extends ConnectionClient> {
  client: TClient;
  /** Session id the connection is bound to (pi binds at create; the runner may
   *  update it later via bindSession after discovering the real id). */
  boundSessionId: string | undefined;
  idleTimer: ReturnType<typeof setTimeout> | null;
  createPromise: Promise<TClient> | null;
}

export class ConnectionManager<TClient extends ConnectionClient = JsonRpcClient> {
  private slots = new Map<string, Slot<TClient>>();
  private readonly binary: string;
  private readonly buildArgs: (req: AcquireRequest) => string[];
  private readonly env: Record<string, string | undefined>;
  private readonly requestTimeoutMs: number;
  private readonly idleTtlMs: number;
  private readonly initializeParams: object;
  private readonly clientFactory: (ctx: ClientFactoryContext) => TClient;
  private readonly shouldReuse: (ctx: {
    client: TClient;
    req: AcquireRequest;
    boundSessionId: string | undefined;
  }) => boolean;
  private readonly logTag: string;

  /** Callback when a connection is lost — cleared from slot map. */
  onConnectionLost?: (workspace: string) => void;

  constructor(opts: ConnectionManagerOptions<TClient>) {
    this.binary = opts.binary;
    this.buildArgs = opts.buildArgs ?? (() => opts.args ?? []);
    this.env = opts.env ?? {};
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.initializeParams = opts.initializeParams ?? {};
    this.clientFactory =
      opts.clientFactory ??
      ((ctx) =>
        new JsonRpcClient(
          ctx.transport,
          {
            onNotification: () => {},
            onServerRequest: () => {},
            onClose: ctx.baseOnClose,
          },
          ctx.requestTimeoutMs,
          this.initializeParams,
        ) as unknown as TClient);
    this.shouldReuse = opts.shouldReuse ?? (({ client }) => client.ready && client.healthy);
    this.logTag = opts.logTag ?? 'jsonrpc-connection-manager';
  }

  /**
   * Acquire a connection for the given workspace.
   * Creates a new connection if one does not exist or the previous one was lost
   * (or, for session-bound protocols, bound to a different session).
   * Serializes creation so concurrent calls share the same connection.
   */
  async acquire(workspace: string, req: AcquireRequest = {}): Promise<TClient> {
    const existing = this.slots.get(workspace);
    if (existing) {
      // If a create is in flight, wait for it
      if (existing.createPromise) {
        return existing.createPromise;
      }
      // Reuse when the (session-aware) reuse predicate holds — e.g. the client
      // is ready and its transport is alive (default), or it is bound to the
      // requested session (pi). Otherwise replace it so the next run respawns
      // the process.
      if (
        this.shouldReuse({
          client: existing.client,
          req,
          boundSessionId: existing.boundSessionId,
        })
      ) {
        return existing.client;
      }
      this.disposeSlot(workspace);
    }

    const createPromise = this.createClient(workspace, req);
    this.slots.set(workspace, {
      client: null as unknown as TClient, // placeholder
      boundSessionId: req.sessionId,
      idleTimer: null,
      createPromise,
    });

    try {
      const client = await createPromise;
      // 竞态：创建期间 release()/disposeAll() 已把 slot 删掉（并可能已
      // dispose 连接）。此时不能再把新连接塞回 slot——否则会复活一个无人管理、
      // 无 idle timer 的连接泄漏。归还给调用者继续使用，但不再缓存。
      const slotAfterCreate = this.slots.get(workspace);
      if (!slotAfterCreate || slotAfterCreate.createPromise !== createPromise) {
        return client;
      }
      this.slots.set(workspace, {
        client,
        boundSessionId: req.sessionId,
        idleTimer: null,
        createPromise: null,
      });
      return client;
    } catch (err) {
      // 只删除自己的槽位：并发 release + 重新 acquire 后 slot 可能已被新的
      // createPromise 占据，误删会破坏新连接。
      const current = this.slots.get(workspace);
      if (current && current.createPromise === createPromise) {
        this.slots.delete(workspace);
      }
      throw err;
    }
  }

  /**
   * Record the session id a fresh connection actually bound to (e.g. discovered
   * via a protocol `get_state` after a fresh spawn). This lets a subsequent run
   * resume the SAME session on the live connection instead of respawning it.
   */
  bindSession(workspace: string, sessionId: string): void {
    const slot = this.slots.get(workspace);
    if (slot) slot.boundSessionId = sessionId;
  }

  /**
   * Release (dispose) a connection for the given workspace.
   */
  async release(workspace: string): Promise<void> {
    this.disposeSlot(workspace);
  }

  /**
   * Dispose all connections.
   */
  async disposeAll(): Promise<void> {
    const workspaces = [...this.slots.keys()];
    await Promise.all(workspaces.map((w) => this.disposeSlot(w)));
  }

  /**
   * Notify that the workspace is active — disarm the idle timer.
   */
  notifyActivity(workspace: string): void {
    const slot = this.slots.get(workspace);
    if (slot) {
      this.clearIdleTimer(slot);
    }
  }

  /**
   * Notify that the workspace is idle — arm the idle timer.
   */
  notifyIdle(workspace: string): void {
    const slot = this.slots.get(workspace);
    if (slot) {
      this.clearIdleTimer(slot);
      slot.idleTimer = setTimeout(() => {
        getLogger().info(
          `[${this.logTag}] idle timeout for workspace=${workspace}, releasing connection`,
        );
        this.disposeSlot(workspace);
      }, this.idleTtlMs);
    }
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private async createClient(workspace: string, req: AcquireRequest): Promise<TClient> {
    const transport = new JsonlRpcTransport({
      binary: this.binary,
      args: this.buildArgs(req),
      cwd: workspace,
      env: this.env,
    });

    let client: TClient | null = null;
    client = this.clientFactory({
      transport,
      requestTimeoutMs: this.requestTimeoutMs,
      baseOnClose: () => {
        getLogger().info(`[${this.logTag}] connection closed workspace=${workspace}`);
        // 只清理自己创建的 slot：并发 release + 重新 acquire 后 slot 可能已被
        // 新连接占据，误删会破坏新连接。
        if (this.slots.get(workspace)?.client === client) {
          this.slots.delete(workspace);
          this.onConnectionLost?.(workspace);
        }
      },
    });
    await client.connect();
    return client;
  }

  private clearIdleTimer(slot: Slot<TClient>): void {
    if (slot.idleTimer !== null) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  }

  private async disposeSlot(workspace: string): Promise<void> {
    const slot = this.slots.get(workspace);
    if (!slot) return;
    this.slots.delete(workspace);
    this.clearIdleTimer(slot);
    if (slot.client) {
      try {
        await slot.client.dispose();
      } catch (err) {
        getLogger().warn(`[${this.logTag}] dispose error workspace=${workspace}: ${err}`);
      }
    }
  }
}
