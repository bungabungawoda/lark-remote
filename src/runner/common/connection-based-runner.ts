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
import { ConnectionLostError } from './jsonrpc/client.js';
import { getLogger } from '../../logger/index.js';
import { syntheticInitEvent } from './runner-utils.js';

/** How long to wait for turn output notifications before failing. */
export const TURN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export abstract class ConnectionBasedRunner<TClient, TEvent = AgentEvent> implements AgentRunner {
  readonly kind: AgentKind;
  readonly sessionReader: AgentSessionReader;
  readonly lifetime = 'workspace' as const;

  protected currentClient: TClient | null = null;
  protected currentTurnId: string | null = null;
  protected lastEventAt = 0;
  protected _isRunning = false;
  protected readonly turnIdleTimeoutMs: number;

  /** Notification queue consumed by the active run generator. */
  protected notificationQueue: TEvent[] = [];
  protected waitResolve: (() => void) | null = null;
  protected forceFinish = false;
  /** stop() 在 turn/start 或 prompt 响应前到达时置位，完成后再补发 cancel/interrupt。 */
  protected stopRequested = false;

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
      this.notifyIdle(opts.cwd);
    }
  }

  /**
   * Stop the current turn by cancelling it. Shared skeleton: if the turn/start
   * or prompt has not yet resolved (shouldDeferStop), mark stopRequested and
   * unblock; otherwise cancel now via cancelCurrentTurn().
   */
  async stop(_opts?: { immediate?: boolean }): Promise<void> {
    if (!this._isRunning) return;
    // CC-01: 启动阶段（client/session 未建立）也必须记录停止意图，否则 /stop 被吞、
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
        this.waitResolve = resolve;
        setTimeout(
          () => {
            if (this.waitResolve === resolve) {
              this.waitResolve = null;
              resolve();
            }
          },
          Math.min(remaining, 30_000),
        );
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
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve();
    }
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

  /** Release the connection for a workspace (subclass dispatches to its manager). */
  protected abstract releaseConnection(cwd: string): Promise<void>;

  /** Notify the connection manager that the workspace is idle (subclass). */
  protected abstract notifyIdle(cwd: string): void;

  /** Dispose all connections (subclass dispatches to its manager). */
  protected abstract disposeConnections(): Promise<void>;
}
