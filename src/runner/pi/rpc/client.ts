/**
 * PiRpcClient: JSON-lines client for pi's `--mode rpc` protocol.
 *
 * Reuses the shared JsonlRpcTransport (spawn + line read/write + graceful
 * close) but speaks pi's own framing — commands `{type,id,...}` on stdin,
 * responses `{id,type:"response",command,success,...}` and bare events on
 * stdout — rather than JSON-RPC. There is no initialize handshake: the server
 * starts streaming events immediately after spawn.
 *
 * Response correlation is by command id; every non-response line is forwarded
 * as an event to the active hooks (the runner's translator).
 */

import type { JsonlRpcTransport } from '../../common/jsonrpc/transport.js';
import { ConnectionLostError } from '../../common/jsonrpc/client.js';
import type { PiRpcCommand, PiRpcEvent, PiRpcResponse } from './protocol-types.js';

/** Per-run hooks set by the runner. Accepts a superset so the base class's
 *  respawnAfterConnectionLost({onNotification,onServerRequest,onClose})
 *  detach call stays type-compatible. */
export interface PiRpcClientHooks {
  onEvent?(evt: PiRpcEvent): void;
  onClose?(): void;
  onNotification?(): void;
  onServerRequest?(): void;
}

interface PendingRequest {
  resolve: (resp: PiRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PiRpcClient {
  private transport: JsonlRpcTransport;
  private readonly requestTimeoutMs: number;
  /** Connection-layer close hook (slot cleanup) — survives setHooks(). */
  private readonly baseOnClose: () => void;
  /** Per-run hooks from the runner. */
  private runHooks: PiRpcClientHooks | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private _disposed = false;
  private _ready = false;

  constructor(
    transport: JsonlRpcTransport,
    baseOnClose: () => void,
    requestTimeoutMs: number = 60_000,
  ) {
    this.transport = transport;
    this.baseOnClose = baseOnClose;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /** Replace the per-run hooks (runner wires its translator + failTurn here). */
  setHooks(hooks: PiRpcClientHooks): void {
    this.runHooks = hooks;
  }

  get ready(): boolean {
    return this._ready;
  }

  get healthy(): boolean {
    return !this._disposed && !this.transport.closed;
  }

  /** Start the transport. Throws ConnectionLostError if spawn fails (ENOENT). */
  async connect(): Promise<void> {
    const events = {
      onMessage: (msg: unknown) => this.handleMessage(msg),
      onClose: () => {
        this.failPending(new ConnectionLostError('pi rpc transport closed'));
        this.baseOnClose();
        this.runHooks?.onClose?.();
      },
    };
    await this.transport.start(events);
    if (this.transport.closed) {
      throw new ConnectionLostError('pi RPC server failed to start (binary missing or crashed)');
    }
    this._ready = true;
  }

  /**
   * Send a command and await its response (correlated by id).
   * `timeoutMs` overrides the default (defaults to requestTimeoutMs).
   */
  async request(command: PiRpcCommand, timeoutMs?: number): Promise<PiRpcResponse> {
    if (this._disposed || this.transport.closed) {
      throw new ConnectionLostError('pi rpc client is disposed/closed');
    }
    const id = `req_${this.nextId++}`;
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const effectiveTimeout = Math.min(timeoutMs ?? this.requestTimeoutMs, 2_147_483_647);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for pi rpc response: ${command.type}`));
      }, effectiveTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.write({ ...command, id });
    });
  }

  /** Fire-and-forget command (no response awaited) — e.g. `abort`. */
  notify(command: PiRpcCommand): void {
    if (this._disposed || this.transport.closed) return;
    this.transport.write({ ...command, id: `req_${this.nextId++}` });
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;
    this.failPending(new ConnectionLostError('pi rpc client disposed'));
    await this.transport.close();
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private handleMessage(msg: unknown): void {
    const message = msg as Record<string, unknown>;
    if (message.type === 'response' && message.id != null) {
      const id = String(message.id);
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(message as unknown as PiRpcResponse);
      }
      return;
    }
    this.runHooks?.onEvent?.(message as unknown as PiRpcEvent);
  }

  private failPending(err: Error): void {
    for (const [_id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
