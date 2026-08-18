/**
 * Generic JSON-RPC client for JSON-line-RPC agent servers
 * (codex app-server, kimi acp, and future ACP-style integrations).
 *
 * Manages the handshake, request/response matching, notification dispatch,
 * and timeout handling over a JsonlRpcTransport. The `initialize` params
 * shape is protocol-specific and injected by the caller (constructor arg);
 * the default is the ACP handshake shape (ACP is the reference protocol).
 */

import type { JsonlRpcTransport } from './transport.js';
import {
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
} from './types.js';
import { getLogger } from '../../../logger/index.js';

// =============================================================================
// Error Types
// =============================================================================

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export class RpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcTimeoutError';
  }
}

export class ConnectionLostError extends Error {
  constructor(message: string = 'Connection lost') {
    super(message);
    this.name = 'ConnectionLostError';
  }
}

// =============================================================================
// Client Hooks
// =============================================================================

export interface ClientHooks {
  onNotification(method: string, params: unknown): void;
  onServerRequest(id: number | string, method: string, params: unknown): void;
  onClose(): void;
}

// =============================================================================
// Client
// =============================================================================

export class JsonRpcClient<InitializeResult = unknown> {
  private transport: JsonlRpcTransport;
  /**
   * Lifecycle hooks owned by the connection layer (ConnectionManager): slot
   * cleanup + onConnectionLost. These must survive runner's setHooks().
   */
  private baseHooks: ClientHooks;
  /** Per-run hooks from the runner, layered over baseHooks via setHooks(). */
  private runHooks: ClientHooks | null = null;
  private requestTimeoutMs: number;
  private initializeParams: object;

  private pendingRequests = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;
  private _ready = false;
  private _disposed = false;

  constructor(
    transport: JsonlRpcTransport,
    hooks: ClientHooks,
    requestTimeoutMs: number = 60_000,
    initializeParams: object,
  ) {
    this.transport = transport;
    this.baseHooks = hooks;
    this.requestTimeoutMs = requestTimeoutMs;
    this.initializeParams = initializeParams;
  }

  /**
   * Replace the per-run hooks (used by the runner to bridge
   * notifications/server requests into the active turn's translator).
   * Connection-layer hooks (slot cleanup / onConnectionLost) are preserved:
   * review P2-1 — an overwrite here previously silenced onClose slot cleanup,
   * leaving dead slots behind after the server process was killed.
   */
  setHooks(hooks: ClientHooks): void {
    this.runHooks = hooks;
  }

  get ready(): boolean {
    return this._ready;
  }

  /**
   * Whether the underlying transport is still alive (not disposed and not
   * closed). Used by the connection manager to avoid handing out a cached
   * client whose child process was killed externally.
   */
  get healthy(): boolean {
    return !this._disposed && !this.transport.closed;
  }

  /**
   * Connect and perform the initialize handshake.
   * Returns the InitializeResult on success.
   */
  async connect(): Promise<InitializeResult> {
    const events = {
      onMessage: (msg: object) => this.handleMessage(msg),
      onClose: () => {
        this.failPending(new ConnectionLostError('transport closed'));
        // 先通知连接层（slot 清理 + onConnectionLost），再通知当前 run 层
        // （failTurn 等）。两层互不覆盖。
        this.baseHooks.onClose();
        this.runHooks?.onClose();
      },
    };

    await this.transport.start(events);

    // ENOENT/启动失败时 transport 已在 start() 内触发 onClose 并置 closed；
    // 直接 fail-fast，避免 initialize 请求挂满 requestTimeoutMs 才报错。
    if (this.transport.closed) {
      throw new ConnectionLostError('JSON-RPC server failed to start (binary missing or crashed)');
    }

    // Send initialize request (shape injected by the caller)
    const result = await this.request<object, InitializeResult>(
      'initialize',
      this.initializeParams,
    );

    this._ready = true;
    return result;
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   * `timeoutMs` overrides the default request timeout — turn-scoped requests
   * (e.g. session/prompt) hold their response open for the whole turn, so
   * callers pass the turn idle timeout (bounded by the runner's turn idle
   * watchdog, not the control-plane request timeout).
   */
  async request<P, R>(method: string, params?: P, timeoutMs?: number): Promise<R> {
    if (this._disposed) {
      throw new ConnectionLostError('client is disposed');
    }
    if (this.transport.closed) {
      throw new ConnectionLostError('transport closed');
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<R>((resolve, reject) => {
      // Clamp to setTimeout's max: callers may pass Infinity for turn-scoped
      // requests (session/prompt) — Infinity would fire immediately in Node.
      const effectiveTimeout = Math.min(timeoutMs ?? this.requestTimeoutMs, 2_147_483_647);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new RpcTimeoutError(`request timed out: ${method}`));
      }, effectiveTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.transport.write(request);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: unknown): void {
    if (this._disposed) return;
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.transport.write(notification);
  }

  /**
   * Respond to a server request (success).
   */
  respond(id: number | string, result: unknown): void {
    const response: JsonRpcSuccessResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this.transport.write(response);
  }

  /**
   * Respond to a server request (error).
   */
  respondError(id: number | string, code: number, message: string): void {
    const response: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    this.transport.write(response);
  }

  /**
   * Dispose the client: cancel pending requests and close transport.
   */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;
    this.failPending(new ConnectionLostError('client disposed'));
    await this.transport.close();
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private handleMessage(msg: object): void {
    const message = msg as Record<string, unknown>;

    if ('id' in message && 'result' in message) {
      // Success response
      const id = message.id as string | number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        pending.resolve(message.result);
      }
      return;
    }

    if ('id' in message && 'error' in message) {
      // Error response
      const id = message.id as string | number;
      const err = message.error as { code: number; message: string; data?: unknown };
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        pending.reject(new RpcError(err.code, err.message, err.data));
      }
      return;
    }

    if ('method' in message && !('id' in message)) {
      // Notification
      const method = message.method as string;
      this.baseHooks.onNotification(method, message.params);
      this.runHooks?.onNotification(method, message.params);
      return;
    }

    if ('method' in message && 'id' in message) {
      // Server request (incoming request from server — reverse RPC)
      const id = message.id as string | number;
      const method = message.method as string;
      this.baseHooks.onServerRequest(id, method, message.params);
      this.runHooks?.onServerRequest(id, method, message.params);
      return;
    }

    getLogger().warn(
      `[jsonrpc-client] unknown message type: ${JSON.stringify(message).slice(0, 200)}`,
    );
  }

  private failPending(err: Error): void {
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}
