/**
 * ConnectionManager: manages agent-server connections per cwd, shared by
 * all workspace-lifetime JSON-line runners (codex app-server, kimi acp,
 * opencode acp, and pi rpc).
 *
 * Each cwd gets its own connection (transport + client). Connections are
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
import {
  AgentStopperRegistry,
  agentStopperRegistry,
  type AgentStopper,
} from '../../../platform/agent-stopper.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../defaults.js';

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** acquire() 的轮次上限：防止 slot 被持续释放时无限重建连接。 */
const MAX_ACQUIRE_ATTEMPTS = 5;

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
  /** 协议停止通道注册表注入（测试隔离）；默认进程级单例，透传给 transport。 */
  stoppers?: AgentStopperRegistry;
  /** Called once after a fresh connection's initialize handshake resolves. */
  onConnected?: (result: unknown, cwd: string) => void;
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
  private readonly stoppers: AgentStopperRegistry;
  private readonly onConnected?: (result: unknown, cwd: string) => void;

  /** Callback when a connection is lost — cleared from slot map. */
  onConnectionLost?: (cwd: string) => void;

  /**
   * 协议停止通道工厂：连接建立后按 pid 登记到 AgentStopperRegistry，
   * 供 Terminator 在**优雅**停止时回调（win32 上没有可拦截的 SIGTERM，只能靠
   * 协议通道让 agent 自己收摊）。返回 undefined = 该协议无通道。
   *
   * 做成「构造后赋值的字段」而不是构造选项：kimi/opencode 的 manager 建在
   * `super(...)` 的实参里，那时 `this` 尚不可用，runner 无法把
   * cancelCurrentTurn 塞进选项——只能等 super() 返回后赋值。
   */
  stopper?: (ctx: { pid: number; client: TClient }) => AgentStopper | undefined;

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
    this.stoppers = opts.stoppers ?? agentStopperRegistry;
    this.onConnected = opts.onConnected;
  }

  /**
   * Acquire a connection for the given cwd.
   * Creates a new connection if one does not exist or the previous one was lost
   * (or, for session-bound protocols, bound to a different session).
   * Serializes creation so concurrent calls share the same connection.
   *
   * 替换旧连接时必须先等 dispose 完成。旧实现
   * `disposeSlot(cwd)` 不 await 就创建新连接，新旧两个 agent server 会重叠；
   * codex 会报 "thread already has an active writer"（同一 workspace 写锁）。
   * 现在的顺序：等旧连接真正 dispose → 重新读 slot（并发 acquire 可能已建好
   * 新连接，直接复用/等它）→ 才进入创建。创建期间 slot 被 release/disposeAll
   * 删掉时，新连接立即 dispose 并重试，不返回无人托管的连接。
   */
  async acquire(cwd: string, req: AcquireRequest = {}): Promise<TClient> {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const existing = this.slots.get(cwd);
      if (existing) {
        // If a create is in flight, wait for it
        if (existing.createPromise) {
          const client = await existing.createPromise;
          // 快速路径复核（与下方建槽方的竞态复核对称）：await 期间槽位被
          // release()/disposeAll() 删掉时，建槽方会 dispose 该连接并重试——
          // 直接返回会把「已被建槽方 dispose 的连接」交给本调用方（表现为
          // setupTurn 抛 ConnectionLostError 走 respawn-retry 自愈）。槽位
          // 不再持有该 client 时与本轮创建同路：重试。
          const current = this.slots.get(cwd);
          if (current && current.client === client) {
            return client;
          }
          continue;
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
        // Must finish before a replacement connection is created: two live
        // agent servers for one cwd would contend on the same write lock.
        const disposed = await this.disposeSlot(cwd);
        if (!disposed) {
          throw new Error(
            `cannot replace connection for cwd=${cwd}: old connection failed to dispose`,
          );
        }
        // Re-read: a concurrent acquire may have installed a new slot (or a
        // create promise) while we awaited the dispose.
        continue;
      }

      const createPromise = this.createClient(cwd, req);
      const slot: Slot<TClient> = {
        client: null as unknown as TClient, // placeholder until connect resolves
        boundSessionId: req.sessionId,
        idleTimer: null,
        createPromise,
      };
      this.slots.set(cwd, slot);

      try {
        const client = await createPromise;
        // 竞态：创建期间 release()/disposeAll() 已把 slot 删掉（并可能已
        // dispose 连接）。旧实现把新连接直接交给调用方"继续使用但不缓存"，
        // 留下一个无人管理、无 idle timer 的连接。现在主动 dispose 后重试；
        // 连续被释放说明 manager 正在收摊，按失败上报而不是无限重连。
        if (this.slots.get(cwd) !== slot) {
          try {
            await client.dispose();
          } catch (err) {
            getLogger().warn(
              `[${this.logTag}] dispose of released connection failed cwd=${cwd}: ${err}`,
            );
          }
          continue;
        }
        slot.client = client;
        slot.createPromise = null;
        return client;
      } catch (err) {
        // 只删除自己的槽位：并发 release + 重新 acquire 后 slot 可能已被新的
        // createPromise 占据，误删会破坏新连接。
        const current = this.slots.get(cwd);
        if (current && current.createPromise === createPromise) {
          this.slots.delete(cwd);
        }
        throw err;
      }
    }
    throw new Error(`cannot acquire connection for cwd=${cwd}: slot repeatedly released`);
  }

  /**
   * Record the session id a fresh connection actually bound to (e.g. discovered
   * via a protocol `get_state` after a fresh spawn). This lets a subsequent run
   * resume the SAME session on the live connection instead of respawning it.
   */
  bindSession(cwd: string, sessionId: string): void {
    const slot = this.slots.get(cwd);
    if (slot) slot.boundSessionId = sessionId;
  }

  /**
   * Release (dispose) a connection for the given cwd.
   */
  async release(cwd: string): Promise<void> {
    await this.disposeSlot(cwd);
  }

  /**
   * Dispose all connections.
   */
  async disposeAll(): Promise<void> {
    const workspaces = [...this.slots.keys()];
    await Promise.all(workspaces.map((w) => this.disposeSlot(w)));
  }

  /**
   * Notify that the cwd is active — disarm the idle timer.
   */
  notifyActivity(cwd: string): void {
    const slot = this.slots.get(cwd);
    if (slot) {
      this.clearIdleTimer(slot);
    }
  }

  /**
   * Notify that the cwd is idle — arm the idle timer.
   *
   * `idleTtlMs: 0` = 不回收（与 claude 会话层的 `armIdleTimer` 同口径；按 0
   * setTimeout 会秒删刚建好的连接，等于每条消息重起一次进程）。
   *
   * 定时器回调带 **slot 身份校验**：武装之后 slot 可能已被替换——进程自退走
   * baseOnClose（删 slot 但不经过 disposeSlot）、或同 cwd 已 acquire 了新连接。
   * 这两种情况下本定时器都已过期，不得回收「当时恰好挂在该 cwd 上」的连接：
   * 2026-10-24 线上事故即一条泄漏的过期 TTL 杀掉继任连接的在途 turn，卡片
   * 误报 "Codex app-server connection closed"。
   */
  notifyIdle(cwd: string): void {
    if (this.idleTtlMs <= 0) return;
    const slot = this.slots.get(cwd);
    if (!slot) return;
    this.clearIdleTimer(slot);
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      if (this.slots.get(cwd) !== slot) return;
      getLogger().info(`[${this.logTag}] idle timeout for cwd=${cwd}, releasing connection`);
      this.disposeSlot(cwd);
    }, this.idleTtlMs);
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private async createClient(cwd: string, req: AcquireRequest): Promise<TClient> {
    let client: TClient | null = null;
    const transport = new JsonlRpcTransport({
      binary: this.binary,
      args: this.buildArgs(req),
      cwd: cwd,
      env: this.env,
      stoppers: this.stoppers,
      // 通道工厂要拿到**连接本身**：协议取消（codex turn/interrupt、ACP
      // session/cancel）必须发在这条连接上，不能借 runner 的共享状态——那会
      // 打断另一 cwd 正在跑的 turn。工厂是在 transport.start() 内侧调用
      // 的，那时 client 已由下面的 clientFactory 赋好。
      stopper: this.stopper
        ? (pid: number) => this.stopper?.({ pid, client: client as TClient })
        : undefined,
    });

    client = this.clientFactory({
      transport,
      requestTimeoutMs: this.requestTimeoutMs,
      baseOnClose: () => {
        getLogger().info(`[${this.logTag}] connection closed cwd=${cwd}`);
        // 只清理自己创建的 slot：并发 release + 重新 acquire 后 slot 可能已被
        // 新连接占据，误删会破坏新连接。
        const current = this.slots.get(cwd);
        if (current?.client === client) {
          // 进程自退（codex app-server 偶发 exit 0，非本程序发起，不经
          // disposeSlot）也要撤掉挂在旧 slot 上的 idle TTL：定时器不随 slot
          // 删除而取消，到期时会按 cwd 误杀继任连接的在途 turn（2026-10-24
          // 线上事故，见 notifyIdle 的身份校验与对应回归测试）。
          this.clearIdleTimer(current);
          this.slots.delete(cwd);
          this.onConnectionLost?.(cwd);
        }
      },
    });
    const initResult = await client.connect();
    this.onConnected?.(initResult, cwd);
    return client;
  }

  private clearIdleTimer(slot: Slot<TClient>): void {
    if (slot.idleTimer !== null) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  }

  /**
   * Dispose the slot for `cwd`. Returns false when the underlying client's
   * dispose failed — callers replacing a connection must abort the replacement
   * rather than let two agent servers overlap.
   */
  private async disposeSlot(cwd: string): Promise<boolean> {
    const slot = this.slots.get(cwd);
    if (!slot) return true;
    this.slots.delete(cwd);
    this.clearIdleTimer(slot);
    if (slot.client) {
      try {
        await slot.client.dispose();
      } catch (err) {
        getLogger().warn(`[${this.logTag}] dispose error cwd=${cwd}: ${err}`);
        return false;
      }
    }
    return true;
  }
}
