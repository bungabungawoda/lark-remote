/**
 * CodexAppServerRunner: workspace-lifetime runner using the Codex App Server
 * protocol (`codex app-server`, JSON-RPC over stdio).
 *
 * Flow per run: acquire persistent connection → thread/start or thread/resume
 * → turn/start → consume notifications (agent message deltas, approval server
 * requests, …) until turn/completed → synthesize ResultEvent.
 */

import type {
  AgentKind,
  AgentSessionReader,
  AgentEvent,
  AgentRunner,
  AgentStatusInfo,
  ApprovalView,
  SpawnOptions,
} from '../../types.js';
import { ConnectionManager, type ConnectionManagerOptions } from './connection-manager.js';
import { CodexAppServerClient, ConnectionLostError } from './client.js';
import { CodexAppServerTranslator, type TranslatorEvent } from './translator.js';
import {
  type AskForApproval,
  type SandboxMode,
  type ThreadStartResponse,
  type ThreadResumeParams,
  type ThreadStartParams,
  type TurnStartResponse,
  type TurnStartParams,
} from './protocol-types.js';
import { getLogger } from '../../../logger/index.js';
import { syntheticInitEvent } from '../../common/runner-utils.js';

export interface CodexAppServerRunnerOptions {
  kind: AgentKind;
  sessionReader: AgentSessionReader;
  /** Path to the codex binary. Defaults to `codex`. */
  binary?: string;
  /** Environment variables. */
  env?: Record<string, string | undefined>;
  /** Args to spawn the app server with. Defaults to `['app-server', '--stdio']`. */
  appServerArgs?: string[];
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Idle TTL for connection manager. */
  idleTtlMs?: number;
  /** How long to wait for turn output before failing. Defaults to 10 min. */
  turnTimeoutMs?: number;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  /** Configured sandbox mode (Codex 官方 SandboxMode 标准值). */
  sandbox?: SandboxMode;
  /** Configured approval policy (Codex 官方 AskForApproval 标准值). */
  approvalPolicy?: AskForApproval;
}

/** How long to wait for turn output notifications before failing. */
const TURN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Build the protocol response body for a command/file approval decision.
 * Structured decisions (acceptWithExecpolicyAmendment) carry the payload the
 * server originally offered; if it is missing, fall back to plain accept.
 */
function buildApprovalResponse(action: string, view: ApprovalView): { decision: unknown } {
  if (action === 'accept_for_session') {
    return { decision: 'acceptForSession' };
  }
  if (action === 'accept_with_execpolicy_amendment') {
    const payload = view.decisionPayloads?.['acceptWithExecpolicyAmendment'];
    if (payload) {
      return { decision: { acceptWithExecpolicyAmendment: payload } };
    }
    getLogger().warn(
      '[codex-app-server-runner] acceptWithExecpolicyAmendment payload missing, falling back to accept',
    );
    return { decision: 'accept' };
  }
  return { decision: action };
}

interface PendingApproval {
  kind: 'command' | 'file' | 'permissions';
  view: ApprovalView;
}

export class CodexAppServerRunner implements AgentRunner {
  readonly kind: AgentKind;
  readonly sessionReader: AgentSessionReader;
  readonly lifetime = 'workspace' as const;

  private connectionManager: ConnectionManager;
  private currentClient: CodexAppServerClient | null = null;
  private currentTranslator: CodexAppServerTranslator | null = null;
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private lastEventAt = 0;
  private _isRunning = false;
  private model?: string;
  private modelProvider?: string;
  private reasoningEffort?: string;
  private sandboxConfig?: SandboxMode;
  private approvalPolicyConfig?: AskForApproval;
  private readonly turnTimeoutMs: number;

  /** Pending approval requests: requestId (JSON-RPC id) → kind + view. */
  private pendingApprovals = new Map<number | string, PendingApproval>();

  /** Notification queue consumed by the active run generator. */
  private notificationQueue: TranslatorEvent[] = [];
  private waitResolve: (() => void) | null = null;
  private forceFinish = false;
  /** stop() 在 turn/start 响应前到达时置位，turn/start 完成后补发 interrupt。 */
  private stopRequested = false;

  constructor(opts: CodexAppServerRunnerOptions) {
    this.kind = opts.kind;
    this.sessionReader = opts.sessionReader;
    this.model = opts.model;
    this.modelProvider = opts.modelProvider;
    this.reasoningEffort = opts.reasoningEffort;
    this.sandboxConfig = opts.sandbox;
    this.approvalPolicyConfig = opts.approvalPolicy;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;

    const managerOpts: ConnectionManagerOptions = {
      binary: opts.binary ?? 'codex',
      args: opts.appServerArgs,
      env: opts.env,
      requestTimeoutMs: opts.requestTimeoutMs,
      idleTtlMs: opts.idleTtlMs,
    };
    this.connectionManager = new ConnectionManager(managerOpts);
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Run a message in the current thread.
   *
   * 进程容错：若 app-server 子进程被外部误杀或自身异常退出（连接丢失），
   * 自动重拉进程并重试一次 setup（thread/start 或按 sessionId thread/resume
   * 继续处理），保证消费用户消息时进程挂了也能恢复。
   */
  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (this._isRunning) {
      throw new Error('CodexAppServerRunner is already running');
    }
    this._isRunning = true;
    this.resetRunState();

    try {
      try {
        await this.setupTurn(message, opts);
      } catch (err) {
        // 连接在 setup 期间丢失（进程被误杀/异常退出）：重拉进程并重试一次。
        // thread/resume 会按持久化记录（rollout）恢复线程，继续原会话处理。
        if (err instanceof ConnectionLostError && !this.stopRequested) {
          getLogger().warn(
            `[codex-app-server-runner] connection lost during turn setup (${(err as Error).message}), respawning app-server and retrying once`,
          );
          // 旧连接可能仍挂在 slot 里（close 事件尚未处理完）：先强制释放，
          // 保证重试会拉起全新进程；并摘掉旧 client 的 hooks，避免其残留的
          // onClose 把错误结果塞进重试后的通知队列。
          await this.connectionManager.release(opts.cwd);
          const staleClient = this.currentClient;
          if (staleClient) {
            staleClient.setHooks({
              onNotification: () => {},
              onServerRequest: () => {},
              onClose: () => {},
            });
          }
          this.resetRunState();
          await this.setupTurn(message, opts);
        } else {
          throw err;
        }
      }
      if (this.stopRequested) {
        // 启动期 /stop：turn/start 已完成，补发 interrupt，避免 server 端 turn
        // 无人接管继续执行。
        getLogger().warn('[codex-app-server-runner] stop requested before turn/start resolved');
        try {
          await this.currentClient?.request('turn/interrupt', {
            threadId: this.currentThreadId,
            turnId: this.currentTurnId,
          });
        } catch (err) {
          getLogger().warn(
            `[codex-app-server-runner] deferred interrupt failed: ${(err as Error).message}`,
          );
        }
      }

      // §9.22 守卫前提：桥的 pre-init result guard 和 run-state reducer 都以
      // system.init 作为「本轮真实开始」的标记，而 app-server 协议没有 init 事件。
      // 缺了它，成功的 result 会被当作 pre-init 丢弃，卡片终态停在 running，
      // 最后兜底成「输出流已结束，但未收到 result 事件」（2026-08-13 事故）。
      // 与 exec runner 的 syntheticInitEvent 模式一致：turn setup 成功即发 init，
      // 保证 turn_started / turn_diff / result 全部落在 init 之后。
      yield syntheticInitEvent(this.currentThreadId ?? opts.sessionId ?? '');
      yield* this.consumeTurn();
    } catch (err) {
      getLogger().error(`[codex-app-server-runner] run error: ${(err as Error).message}`);
      // 与 spawn 失败路径（spawning-runner §9.22）同理：error result 前必须补
      // init，否则守卫把错误结果丢弃，卡片只显示通用「输出流已结束」而非具体
      // 错误信息。
      yield syntheticInitEvent(this.currentThreadId ?? opts.sessionId ?? '');
      yield {
        type: 'result',
        subtype: 'error',
        // 优先上报本次 setup 创建/恢复的线程 id：thread/start 成功后 turn/start
        // 失败时 opts.sessionId 仍是旧值，漏报会导致下条消息再开一个孤儿线程
        // （review P3-10）。
        session_id: this.currentThreadId ?? opts.sessionId ?? '',
        errorMessage: (err as Error).message,
      } as AgentEvent;
    } finally {
      this._isRunning = false;
      this.currentTranslator = null;
      this.currentTurnId = null;
      this.stopRequested = false;
      this.currentThreadId = null;
      // 无论成功失败都要重新武装 idle TTL（无 slot 时是 no-op）。
      this.connectionManager.notifyIdle(opts.cwd);
    }
  }

  /**
   * Acquire the connection and set up the turn: thread/start（新会话）或
   * thread/resume（按 sessionId 恢复既有线程）→ turn/start。
   */
  private async setupTurn(message: string, opts: SpawnOptions): Promise<void> {
    const client = await this.connectionManager.acquire(opts.cwd);
    this.connectionManager.notifyActivity(opts.cwd);
    this.currentClient = client;
    client.setHooks({
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onClose: () => {
        getLogger().warn('[codex-app-server-runner] client connection closed');
        this.failTurn('Codex app-server connection closed');
      },
    });

    const threadParams: ThreadStartParams = this.buildThreadParams(opts.cwd);
    let threadId: string;
    if (opts.sessionId) {
      const resumeParams: ThreadResumeParams = {
        threadId: opts.sessionId,
        ...threadParams,
      };
      await client.request<ThreadResumeParams, ThreadStartResponse>('thread/resume', resumeParams);
      threadId = opts.sessionId;
    } else {
      const threadResult = await client.request<ThreadStartParams, ThreadStartResponse>(
        'thread/start',
        threadParams,
      );
      // 会话键假设（review P2-4）：主线程 thread.id === session_meta.session_id，
      // 故 thread.id 可同时用作协议 threadId 与 store/session reader 的 session
      // 键（bridge 用 turn_started 通知的 threadId 写回，/resume、Compact 按此
      // 键定位 JSONL）。forked/subagent 线程二者会分叉（openai/codex#29327），
      // 桥只把主线程作为顶层会话，不在此链路内。
      threadId = threadResult.thread.id;
    }
    this.currentThreadId = threadId;

    const translator = new CodexAppServerTranslator();
    this.currentTranslator = translator;

    const turnParams: TurnStartParams = this.buildTurnParams(message, opts);
    const turnResult = await client.request<TurnStartParams, TurnStartResponse>(
      'turn/start',
      turnParams,
    );
    this.currentTurnId = turnResult.turn.id;
  }

  /**
   * Run a compact operation on the current thread.
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (this._isRunning) {
      throw new Error('CodexAppServerRunner is already running');
    }
    this._isRunning = true;
    this.resetRunState();

    try {
      const client = await this.connectionManager.acquire(opts.cwd);
      this.connectionManager.notifyActivity(opts.cwd);
      this.currentClient = client;
      client.setHooks({
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
        onClose: () => this.failTurn('Codex app-server connection closed'),
      });

      if (!opts.sessionId) {
        throw new Error('compact requires a sessionId');
      }
      this.currentThreadId = opts.sessionId;

      const translator = new CodexAppServerTranslator();
      translator.setOperationKind('compact');
      this.currentTranslator = translator;

      // 冷连接兜底：thread/compact/start 要求线程已加载。真实协议里对未加载
      // 的线程直接 compact 返回 -32600 "thread not found"（codex-cli 0.147.0
      // 实测），只有先 thread/resume（或 thread/start）把线程载入内存才能
      // 压缩。连接池复用期间线程本就在内存，resume 幂等无害；连接被
      // /stop、idle TTL 或进程重建后，这一步是 Compact 能工作的前提。
      const resumeParams: ThreadResumeParams = {
        threadId: opts.sessionId,
        ...this.buildThreadParams(opts.cwd),
      };
      await client.request<ThreadResumeParams, ThreadStartResponse>('thread/resume', resumeParams);

      await client.request('thread/compact/start', { threadId: opts.sessionId });
      // 与 run() 同理：compact 也先发 init 再消费通知，避免 result 被守卫丢弃。
      yield syntheticInitEvent(this.currentThreadId ?? opts.sessionId ?? '');
      yield* this.consumeTurn();
    } catch (err) {
      getLogger().error(`[codex-app-server-runner] runCompact error: ${(err as Error).message}`);
      yield syntheticInitEvent(this.currentThreadId ?? opts.sessionId ?? '');
      yield {
        type: 'result',
        subtype: 'error',
        session_id: this.currentThreadId ?? opts.sessionId ?? '',
        errorMessage: (err as Error).message,
      } as AgentEvent;
    } finally {
      this._isRunning = false;
      this.currentTranslator = null;
      this.currentTurnId = null;
      this.stopRequested = false;
      this.currentThreadId = null;
      this.connectionManager.notifyIdle(opts.cwd);
    }
  }

  /**
   * Stop the current turn by interrupting it.
   */
  async stop(_opts?: { immediate?: boolean }): Promise<void> {
    if (!this._isRunning || !this.currentClient || !this.currentThreadId) return;
    if (!this.currentTurnId) {
      // turn/start 尚未响应：先标记，等 run() 在 turn/start 完成后补发 interrupt。
      this.stopRequested = true;
      this.forceFinish = true;
      this.wakeWaiters();
      return;
    }
    try {
      await this.currentClient.request('turn/interrupt', {
        threadId: this.currentThreadId,
        turnId: this.currentTurnId ?? '',
      });
    } catch (err) {
      getLogger().warn(`[codex-app-server-runner] stop error: ${(err as Error).message}`);
    }
    // Unblock the turn loop regardless of whether the server sends a
    // turn/completed notification afterwards.
    this.forceFinish = true;
    this.wakeWaiters();
  }

  /**
   * Respond to an approval server request. `response` is the bridge
   * ApprovalAction (`{ action: 'accept' | 'accept_for_session' | 'decline' | 'cancel' }`).
   */
  async respondApproval(requestId: number | string, response: unknown): Promise<void> {
    const client = this.currentClient;
    const pending = this.pendingApprovals.get(requestId);
    if (!client || !pending) return;

    const action = (response as { action?: string })?.action ?? 'decline';
    if (pending.kind === 'permissions') {
      // 权限审批的响应没有 decision 字段（真实协议只回 granted profile +
      // scope）：decline/cancel 必须返回空授权（拒绝全部），否则会把用户已
      // 勾选的条目当作授予返回（2026-08-12 review 发现：勾选后点「拒绝」实
      // 际授予了所选权限）。accept/acceptForSession 才带用户勾选的条目。
      const denied = action === 'decline' || action === 'cancel';
      client.respond(requestId, {
        permissions: denied
          ? this.denyAllPermissions()
          : this.buildGrantedPermissions(pending.view),
        scope: action === 'accept_for_session' ? 'session' : 'turn',
      });
    } else {
      client.respond(requestId, buildApprovalResponse(action, pending.view));
    }
    this.pendingApprovals.delete(requestId);
    getLogger().info(
      `[codex-app-server-runner] approval responded requestId=${requestId} kind=${pending.kind} action=${action}`,
    );
  }

  /**
   * Dispose the runner: release the connection.
   */
  async dispose(): Promise<void> {
    try {
      await this.connectionManager.disposeAll();
    } catch (err) {
      getLogger().warn(`[codex-app-server-runner] dispose error: ${(err as Error).message}`);
    }
  }

  getUsageAuthority(): 'live' {
    return 'live';
  }

  killOrphan(): void {
    // No-op: the app-server connection is managed by ConnectionManager.
  }

  registerExitHandlers(): void {
    // No-op: connection manager handles cleanup on exit.
  }

  unregisterExitHandlers(): void {
    // No-op.
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: this.kind,
      model: this.model ?? '(app-server)',
      provider: this.modelProvider,
      reasoning: this.reasoningEffort,
      extras: {
        mode: 'app-server',
        ...(this.sandboxConfig ? { sandbox: this.sandboxConfig } : {}),
        ...(this.approvalPolicyConfig ? { approvalPolicy: String(this.approvalPolicyConfig) } : {}),
      },
    };
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private buildThreadParams(cwd: string): ThreadStartParams {
    const params: ThreadStartParams = {
      cwd,
      ...(this.model ? { model: this.model } : {}),
      ...(this.modelProvider ? { modelProvider: this.modelProvider } : {}),
      ...(this.approvalPolicyConfig ? { approvalPolicy: this.approvalPolicyConfig } : {}),
      ...(this.sandboxConfig ? { sandbox: this.sandboxConfig } : {}),
    };
    return params;
  }

  private buildTurnParams(message: string, opts: SpawnOptions): TurnStartParams {
    const params: TurnStartParams = {
      threadId: this.currentThreadId ?? '',
      input: [{ type: 'text', text: message }],
      ...((opts.model ?? this.model) ? { model: opts.model ?? this.model } : {}),
      ...((opts.reasoningEffort ?? this.reasoningEffort)
        ? { effort: opts.reasoningEffort ?? this.reasoningEffort }
        : {}),
    };
    return params;
  }

  /**
   * Consume the notification queue until a result event arrives or the turn
   * times out / is interrupted.
   */
  private async *consumeTurn(): AsyncGenerator<AgentEvent> {
    while (true) {
      const timedOut = await this.waitForEvents(this.nextTurnIdleDeadline());
      if (timedOut) {
        await this.interruptCurrentTurn();
        getLogger().warn('[codex-app-server-runner] turn wait timed out');
        yield {
          type: 'result',
          subtype: 'error',
          session_id: this.currentThreadId ?? '',
          errorMessage: 'Codex app-server turn timed out',
        } as AgentEvent;
        return;
      }
      if (this.forceFinish) {
        yield {
          type: 'result',
          subtype: 'interrupted',
          session_id: this.currentThreadId ?? '',
          errorMessage: 'Codex app-server turn interrupted',
        } as AgentEvent;
        return;
      }
      while (this.notificationQueue.length > 0) {
        const ev = this.notificationQueue.shift() as TranslatorEvent;
        yield ev as AgentEvent;
        if (ev.type === 'result') {
          return;
        }
      }
    }
  }

  /**
   * Compute the current idle deadline. 0 disables the idle timeout; otherwise
   * the deadline is based on the last received event, not the turn start time.
   */
  private nextTurnIdleDeadline(): number {
    if (this.turnTimeoutMs <= 0) return Number.POSITIVE_INFINITY;
    return this.lastEventAt + this.turnTimeoutMs;
  }

  private async interruptCurrentTurn(): Promise<void> {
    if (!this.currentClient || !this.currentThreadId || !this.currentTurnId) return;
    try {
      await this.currentClient.request('turn/interrupt', {
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
      });
    } catch (err) {
      getLogger().warn(
        `[codex-app-server-runner] idle-timeout interrupt failed: ${(err as Error).message}`,
      );
    }
  }

  private async waitForEvents(deadline: number): Promise<boolean> {
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

  private handleNotification(method: string, params: unknown): void {
    const events = this.currentTranslator?.handleNotification(method, params) ?? [];
    this.pushEvents(events);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const events = this.currentTranslator?.handleServerRequest(id, method, params) ?? [];
    if (events.length === 0) {
      // 未处理/不支持的服务端请求必须显式响应（error 即"拒绝"，turn 继续），
      // 否则服务端会一直等待响应（applyPatchApproval、item/tool/requestUserInput、
      // mcpServer/elicitation/request 等）。
      this.currentClient?.respondError(id, -32601, `Unsupported server request: ${method}`);
      return;
    }
    for (const ev of events) {
      if (ev.type === 'approval_requested') {
        this.pendingApprovals.set(ev.requestId, { kind: ev.kind, view: ev.view });
        getLogger().info(
          `[codex-app-server-runner] approval requested requestId=${ev.requestId} kind=${ev.kind}`,
        );
      }
    }
    this.pushEvents(events);
  }

  private pushEvents(events: TranslatorEvent[]): void {
    if (events.length === 0) return;
    this.lastEventAt = Date.now();
    this.notificationQueue.push(...events);
    this.wakeWaiters();
  }

  private wakeWaiters(): void {
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve();
    }
  }

  private failTurn(message: string): void {
    this.pushEvents([
      {
        type: 'result',
        subtype: 'error',
        session_id: this.currentThreadId ?? '',
        errorMessage: message,
      } as AgentEvent,
    ]);
  }

  private resetRunState(): void {
    this.notificationQueue = [];
    this.waitResolve = null;
    this.lastEventAt = Date.now();
    this.forceFinish = false;
    this.pendingApprovals.clear();
  }

  private buildGrantedPermissions(view: ApprovalView): unknown {
    const items = view.permissions?.items ?? [];
    const read: string[] = [];
    const write: string[] = [];
    let networkEnabled = false;
    for (const item of items) {
      if (!item.selected) continue;
      if (item.target.kind === 'fsRead') {
        read.push(item.target.path);
      } else if (item.target.kind === 'fsWrite') {
        write.push(item.target.path);
      } else if (item.target.kind === 'network') {
        networkEnabled = true;
      }
    }
    // 真实 GrantedPermissionProfile 形状（v1 schema）：fileSystem 用
    // entries[{path, access}]（read/write 为 legacy 字符串数组，即将移除），
    // network 是 { enabled } 布尔开关，不是 host 列表。
    return {
      fileSystem: {
        entries: [
          ...read.map((path) => ({ path, access: 'read' as const })),
          ...write.map((path) => ({ path, access: 'write' as const })),
        ],
      },
      network: { enabled: networkEnabled },
    };
  }

  /** 拒绝权限审批：空 fileSystem + 关闭网络（真实 GrantedPermissionProfile）。 */
  private denyAllPermissions(): unknown {
    return {
      fileSystem: { entries: [] },
      network: { enabled: false },
    };
  }
}
