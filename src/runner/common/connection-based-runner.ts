/**
 * ConnectionBasedRunner: abstract base class for workspace-lifetime JSON-RPC
 * agent runners (codex app-server / kimi acp / opencode acp).
 *
 * Encapsulates the shared connection-based turn machinery the three runners
 * were duplicating (and had drifted apart on):
 *   - notification queue + waitResolve pump (consumeTurn / waitForEvents)
 *   - forceFinish / stopRequested / deferred-stop semantics
 *   - connection-lost respawn-and-retry-once in run()
 *   - turn idle watchdog (nextTurnIdleDeadline)
 *   - dispose / killOrphan / registerExitHandlers / getUsageAuthority no-ops
 *
 * Subclasses keep the protocol-specific parts (setupTurn, runCompact,
 * handleNotification/handleServerRequest, respondApproval, pendingApprovals,
 * updateApprovalMode, getStatusInfo) and provide the small abstract hooks below.
 */
import type {
  AgentKind,
  AgentSessionReader,
  AgentEvent,
  AgentRunner,
  AgentStatusInfo,
  SpawnOptions,
} from '../types.js';
import type { ChildProcess } from 'node:child_process';
import { ConnectionLostError } from './jsonrpc/client.js';
import { getLogger } from '../../logger/index.js';
import { syntheticInitEvent } from './synthetic-events.js';
import { DEFAULT_TURN_IDLE_TIMEOUT_MINUTES } from '../../config/index.js';
import type { AgentStopper } from '../../platform/agent-stopper.js';

/** How long to wait for turn output notifications before failing.
 *  30 分钟（单源于 config 的 DEFAULT_TURN_IDLE_TIMEOUT_MINUTES）：ACP/app-server
 *  类 agent 常因长工具调用（pip/npm install 等）或等待 SubAgent 长时间静默，
 *  10 分钟会误杀正常进行中的 run。未接配置的 runner（如 opencode）直接吃此默认。 */
const TURN_IDLE_TIMEOUT_MS = DEFAULT_TURN_IDLE_TIMEOUT_MINUTES * 60 * 1000;

export abstract class ConnectionBasedRunner<TClient, TEvent = AgentEvent> implements AgentRunner {
  readonly kind: AgentKind;
  readonly sessionReader: AgentSessionReader;
  readonly lifetime = 'workspace' as const;

  protected currentClient: TClient | null = null;
  protected currentTurnId: string | null = null;
  protected lastEventAt = 0;
  protected _isRunning = false;
  protected readonly turnIdleTimeoutMs: number;

  /**
   * 单调递增的轮次代际。每轮 executeTurn 开始
   * 自增；该轮安装的所有回调（prompt settle / notification / server request）
   * 捕获当轮代际 + client，事件落地前校验归属。`_isRunning` / `stopRequested`
   * 是可变跨轮字段，重置于下一轮开始——旧轮迟到的回调会在新轮看到
   * `stopRequested === false` 并通过唯一检查，把旧 session 的 result 灌进新轮。
   */
  protected turnGeneration = 0;
  /** Notification queue consumed by the active run generator. */
  protected notificationQueue: TEvent[] = [];
  protected waitResolve: (() => void) | null = null;
  /** 当前 waitForEvents 的兜底定时器（唤醒时必须清掉）。 */
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  protected forceFinish = false;
  /** stop() 在 turn/start 或 prompt 响应前到达时置位，完成后再补发 cancel/interrupt。 */
  protected stopRequested = false;
  /** 缓存层除名标记（evictRunnerSlot → markOrphaned）。置位后 run 结束时主动
   *  dispose 全部连接而不是挂 idle timer：被除名实例上创建的连接无人托管，
   *  不主动收会残留进程至 idle TTL（30 分钟），期间持有 agent 侧会话写锁。 */
  private orphaned = false;

  protected constructor(
    opts: {
      kind: AgentKind;
      sessionReader: AgentSessionReader;
      turnIdleTimeoutMs?: number;
    },
    defaultTurnIdleTimeoutMs: number = TURN_IDLE_TIMEOUT_MS,
  ) {
    this.kind = opts.kind;
    this.sessionReader = opts.sessionReader;
    this.turnIdleTimeoutMs = opts.turnIdleTimeoutMs ?? defaultTurnIdleTimeoutMs;
  }

  /** Log tag used for operational log lines (e.g. 'kimi-acp-runner'). */
  protected abstract get logTag(): string;

  /** Error message for the turn-idle-timeout result. */
  protected abstract get turnTimeoutErrorMessage(): string;

  /** Error message for the interrupted (stop/forceFinish) result. */
  protected abstract get turnInterruptedErrorMessage(): string;

  /** The active thread/session id, used for result events / synthetic init. */
  protected abstract currentSessionId(): string | null;

  /** Deferred-stop predicate: stop() marks stopRequested instead of cancelling now. */
  protected abstract shouldDeferStop(): boolean;

  /** Cancel the current turn (codex: turn/interrupt request; acp: session/cancel notify). */
  protected abstract cancelCurrentTurn(): Promise<void>;

  /** Set up the turn: acquire + thread|session new/resume + prompt. */
  protected abstract setupTurn(message: string, opts: SpawnOptions): Promise<void>;

  /**
   * 本连接的协议停止通道。
   *
   * win32 上「优雅停止」没有可拦截的跨进程 SIGTERM，只能经 agent 自有协议通道
   * 请求对方收摊。子类把这个方法的结果交给 ConnectionManager.stopper，由后者按
   * `agent + pid` 登记到 AgentStopperRegistry，Terminator 停进程时按 pid 取回。
   *
   * 两件事，顺序不能反：
   *   1. 若本连接就是当前在途 turn 的连接，先发协议取消（codex turn/interrupt /
   *      ACP session/cancel / pi abort）。**归属判定不能省**：runner 实例按 agent
   *      维度共享（一个实例管多条 cwd 连接），无条件调用
   *      `cancelCurrentTurn()` 会用它自己的 currentClient/activeSessionId 去打断
   *      **另一个 cwd** 正在跑的 turn；
   *   2. 关 stdin。stdio 型 agent server 在 stdin EOF 后自行退出——只发协议取消
   *      不会让进程退出，优雅段会空转到 grace 超时后照样树杀，等于通道白注册。
   */
  protected buildCooperativeStop(client: TClient): AgentStopper {
    return async (proc: ChildProcess): Promise<void> => {
      if (this.currentClient === client) {
        try {
          await this.cancelCurrentTurn();
        } catch (err) {
          getLogger().warn(
            `[${this.logTag}] cooperative stop: cancel failed: ${(err as Error).message}`,
          );
        }
      }
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
    };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /** Agent self-describing status info for /status display. */
  abstract getStatusInfo(): AgentStatusInfo;

  /**
   * Run a message. Delegates to executeTurn() with the standard setup.
   */
  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    yield* this.executeTurn(opts, () => this.setupTurn(message, opts));
  }

  /**
   * Shared turn lifecycle used by run() and runCompact(): isRunning guard →
   * resetRunState → setupFn (with connection-lost respawn-and-retry-once) →
   * deferred stop → synthetic init → consumeTurn; catch yields synthetic init
   * + error result; finally resets flags + notifyIdle.
   *
   * `setupFn` performs the turn-specific setup (acquire, session new/resume,
   * prompt, etc.) and may push events into the notification queue.
   */
  protected async *executeTurn(
    opts: SpawnOptions,
    setupFn: () => Promise<void>,
  ): AsyncGenerator<AgentEvent> {
    if (this._isRunning) {
      throw new Error(`${this.constructor.name} is already running`);
    }
    this._isRunning = true;
    // 代际先于 setup 自增：setupTurn 里安装的回调捕获到的就是本轮代际。
    this.turnGeneration++;
    this.resetRunState();

    try {
      try {
        await setupFn();
      } catch (err) {
        // 连接在 setup 期间丢失（进程被误杀/异常退出）：重拉进程并重试一次。
        if (err instanceof ConnectionLostError && !this.stopRequested) {
          getLogger().warn(
            `[${this.logTag}] connection lost during turn setup (${(err as Error).message}), respawning and retrying once`,
          );
          await this.respawnAfterConnectionLost(opts);
          await setupFn();
        } else {
          throw err;
        }
      }
      if (this.stopRequested) {
        // 启动期 /stop：turn/start 或 prompt 尚未完成，补发 cancel/interrupt，
        // 避免 server 端 turn 无人接管继续执行。
        getLogger().warn(`[${this.logTag}] stop requested before turn resolved`);
        try {
          await this.cancelCurrentTurn();
        } catch (err) {
          getLogger().warn(`[${this.logTag}] deferred cancel failed: ${(err as Error).message}`);
        }
      }

      // §9.22 守卫前提：桥的 pre-init result guard 和 run-state reducer 都以
      // system.init 作为「本轮真实开始」的标记，而这些协议没有 init 事件。
      // 缺了它，成功的 result 会被当作 pre-init 丢弃，卡片终态停在 running。
      yield syntheticInitEvent(this.currentSessionId() ?? opts.sessionId ?? '');
      yield* this.consumeTurn();
    } catch (err) {
      getLogger().error(`[${this.logTag}] run error: ${(err as Error).message}`);
      yield syntheticInitEvent(this.currentSessionId() ?? opts.sessionId ?? '');
      yield {
        type: 'result',
        subtype: 'error',
        // 优先上报本次 setup 创建/恢复的 session/thread id。
        session_id: this.currentSessionId() ?? opts.sessionId ?? '',
        errorMessage: (err as Error).message,
      } as AgentEvent;
    } finally {
      this._isRunning = false;
      this.currentTurnId = null;
      this.stopRequested = false;
      this.clearTurnState();
      if (this.orphaned) {
        // 已被缓存层除名（evictRunnerSlot → markOrphaned）：本次 run 创建的
        // 连接挂在无人托管的实例上。主动收掉而不是挂 idle timer——否则 agent
        // server 进程残留至 idle TTL，期间持有 agent 侧会话写锁（codex
        // "thread already has an active writer"，2026-10-11 线上实测）。
        // dispose() 内部自带 try/catch，这里 fire-and-forget 不阻塞事件流收尾。
        void this.disposeConnections().catch((err: Error) => {
          getLogger().warn(`[${this.logTag}] orphan dispose error: ${err.message}`);
        });
      } else {
        this.notifyIdle(opts.cwd);
      }
    }
  }

  /**
   * Stop the current turn by cancelling it. Shared skeleton: if the turn/start
   * or prompt has not yet resolved (shouldDeferStop), mark stopRequested and
   * unblock; otherwise cancel now via cancelCurrentTurn().
   */
  async stop(_opts?: { immediate?: boolean }): Promise<void> {
    if (!this._isRunning) return;
    // 启动阶段（client/session 未建立）也必须记录停止意图，否则 /stop 被吞、
    // turn 照常执行。executeTurn 在 setup 完成后检查 stopRequested 补发 cancel。
    this.stopRequested = true;
    this.forceFinish = true;
    this.wakeWaiters();
    if (!this.currentClient || !this.currentSessionId()) {
      getLogger().warn(
        `[${this.logTag}] stop during setup (client/session not ready); will cancel after setup`,
      );
      return;
    }
    if (this.shouldDeferStop()) {
      // turn/start 或 prompt 尚未响应：先标记，等 run() 完成后再补发 cancel。
      return;
    }
    // turn/start 或 prompt 已 resolved：立即 cancel；同时置 stopRequested 抑制
    // 尚未结算的 prompt 结果翻译（opencode 语义），对已结算方无害。
    try {
      await this.cancelCurrentTurn();
    } catch (err) {
      getLogger().warn(`[${this.logTag}] stop error: ${(err as Error).message}`);
    }
    // Unblock the turn loop regardless of whether the server sends a
    // completed notification afterwards.
    this.forceFinish = true;
    this.wakeWaiters();
  }

  /**
   * Dispose the runner: release the connection.
   */
  async dispose(): Promise<void> {
    try {
      await this.disposeConnections();
    } catch (err) {
      getLogger().warn(`[${this.logTag}] dispose error: ${(err as Error).message}`);
    }
  }

  /**
   * Mark this runner as evicted from the bridge's runner cache while a run may
   * still be holding/creating connections on it (queue-advance race during
   * interruptCurrentRun's await window, 2026-10-11). The active run's finally
   * disposes connections eagerly instead of arming the idle TTL timer —
   * otherwise the agent server process lingers for up to 30 minutes holding
   * its session write lock (codex: "thread already has an active writer").
   * One-way by design: an evicted instance never returns to the cache.
   */
  markOrphaned(): void {
    this.orphaned = true;
  }

  getUsageAuthority(): 'live' {
    return 'live';
  }

  killOrphan(): void {
    // No-op: the connection is managed by ConnectionManager.
  }

  registerExitHandlers(): void {
    // No-op: connection manager handles cleanup on exit.
  }

  unregisterExitHandlers(): void {
    // No-op.
  }

  // =========================================================================
  // Shared turn machinery
  // =========================================================================

  /**
   * Consume the notification queue until a result event arrives or the turn
   * times out / is interrupted. forceFinish drains the queue first (the
   * deferred cancel's own events may still be in it) before yielding the
   * interrupted result.
   */
  protected async *consumeTurn(): AsyncGenerator<AgentEvent> {
    while (true) {
      const timedOut = await this.waitForEvents(this.nextTurnIdleDeadline());
      if (timedOut) {
        await this.cancelCurrentTurn();
        getLogger().warn(`[${this.logTag}] turn wait timed out`);
        yield {
          type: 'result',
          subtype: 'error',
          session_id: this.currentSessionId() ?? '',
          errorMessage: this.turnTimeoutErrorMessage,
        } as AgentEvent;
        return;
      }
      if (this.forceFinish && this.notificationQueue.length === 0) {
        yield {
          type: 'result',
          subtype: 'interrupted',
          session_id: this.currentSessionId() ?? '',
          errorMessage: this.turnInterruptedErrorMessage,
        } as AgentEvent;
        return;
      }
      while (this.notificationQueue.length > 0) {
        const ev = this.notificationQueue.shift() as TEvent;
        yield ev as unknown as AgentEvent;
        if ((ev as unknown as { type?: string }).type === 'result') {
          return;
        }
      }
    }
  }

  /** Compute the current idle deadline. 0 disables; otherwise rolling on last event. */
  protected nextTurnIdleDeadline(): number {
    if (this.turnIdleTimeoutMs <= 0) return Number.POSITIVE_INFINITY;
    return this.lastEventAt + this.turnIdleTimeoutMs;
  }

  protected async waitForEvents(deadline: number): Promise<boolean> {
    while (this.notificationQueue.length === 0 && !this.forceFinish) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;
      await new Promise<void>((resolve) => {
        // 唤醒与超时必须互斥清理：wakeWaiters() 提前 resolve 时要 clearTimeout，
        // 否则高频事件会让 timer 在最长 30s 内持续堆积。
        const waiter = (): void => {
          if (this.waitTimer === timer) {
            clearTimeout(timer);
            this.waitTimer = null;
          }
          resolve();
        };
        const timer = setTimeout(
          () => {
            if (this.waitResolve === waiter) {
              this.waitResolve = null;
              this.waitTimer = null;
              resolve();
            }
          },
          Math.min(remaining, 30_000),
        );
        this.waitResolve = waiter;
        this.waitTimer = timer;
      });
    }
    return false;
  }

  protected pushEvents(events: TEvent[]): void {
    if (events.length === 0) return;
    this.lastEventAt = Date.now();
    this.notificationQueue.push(...events);
    this.wakeWaiters();
  }
  protected wakeWaiters(): void {
    const resolve = this.waitResolve;
    if (resolve) {
      // waiter 自己会 clearTimeout + 置空 waitTimer。
      this.waitResolve = null;
      resolve();
    }
  }

  /**
   * 归属校验：事件/回调是否仍属于当前轮次。旧轮迟到的 prompt 结果、通知、
   * server request 一律只记 debug，不得进入共享 notificationQueue。
   */
  protected isCurrentTurn(generation: number, client: TClient | null): boolean {
    return this._isRunning && generation === this.turnGeneration && client === this.currentClient;
  }

  protected failTurn(message: string): void {
    this.pushEvents([
      {
        type: 'result',
        subtype: 'error',
        session_id: this.currentSessionId() ?? '',
        errorMessage: message,
      } as unknown as TEvent,
    ]);
  }

  protected resetRunState(): void {
    this.notificationQueue = [];
    this.waitResolve = null;
    if (this.waitTimer !== null) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    this.lastEventAt = Date.now();
    this.forceFinish = false;
  }

  /** Release the connection + detach stale client hooks after a lost connection. */
  protected async respawnAfterConnectionLost(opts: SpawnOptions): Promise<void> {
    await this.releaseConnection(opts.cwd);
    const staleClient = this.currentClient as {
      setHooks?(hooks: {
        onNotification(...args: unknown[]): void;
        onServerRequest(...args: unknown[]): void;
        onClose(...args: unknown[]): void;
      }): void;
    };
    if (staleClient?.setHooks) {
      staleClient.setHooks({
        onNotification: () => {},
        onServerRequest: () => {},
        onClose: () => {},
      });
    }
    this.resetRunState();
  }

  /** Hook: clear subclass turn state in run() finally (session ids, translator, flags). */
  protected abstract clearTurnState(): void;

  /** Release the connection for a cwd (subclass dispatches to its manager). */
  protected abstract releaseConnection(cwd: string): Promise<void>;

  /** Notify the connection manager that the cwd is idle (subclass). */
  protected abstract notifyIdle(cwd: string): void;

  /** Dispose all connections (subclass dispatches to its manager). */
  protected abstract disposeConnections(): Promise<void>;
}
