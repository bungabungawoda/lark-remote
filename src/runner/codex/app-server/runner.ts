/**
 * CodexAppServerRunner: workspace-lifetime runner using the Codex App Server
 * protocol (`codex app-server`, JSON-RPC over stdio).
 *
 * Flow per run: acquire persistent connection → thread/start or thread/resume
 * → turn/start → consume notifications (agent message deltas, approval server
 * requests, …) until turn/completed → synthesize ResultEvent.
 *
 * Shares the ConnectionBasedRunner base with kimi/opencode: same notification
 * queue + waitResolve pump, forceFinish/stopRequested semantics, turn idle
 * watchdog, and ConnectionLostError respawn-and-retry-once.
 */

import type {
  AgentKind,
  AgentSessionReader,
  AgentEvent,
  AgentStatusInfo,
  ApprovalView,
  SpawnOptions,
} from '../../types.js';
import {
  ConnectionManager,
  type ConnectionManagerOptions,
} from '../../common/jsonrpc/connection-manager.js';
import { JsonRpcClient } from '../../common/jsonrpc/client.js';
import { CodexAppServerTranslator, type TranslatorEvent } from './translator.js';
import {
  type AskForApproval,
  type SandboxMode,
  type SandboxPolicy,
  type InitializeResult,
  type ThreadStartResponse,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadSettingsUpdateParams,
  type ThreadSettingsUpdateResponse,
  type TurnStartResponse,
  type TurnStartParams,
} from './protocol-types.js';
import { RpcErrorCode } from '../../common/acp/protocol-types.js';
import { getLogger } from '../../../logger/index.js';
import { ConnectionBasedRunner } from '../../common/connection-based-runner.js';

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

/**
 * Map the client-side SandboxMode enum to the response-side SandboxPolicy
 * object used by `thread/settings/update` (`sandboxPolicy`).
 */
export function sandboxModeToSandboxPolicy(mode: SandboxMode): SandboxPolicy {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
  }
}

interface PendingApproval {
  kind: 'command' | 'file' | 'permissions' | 'question';
  view: ApprovalView;
}

export class CodexAppServerRunner extends ConnectionBasedRunner<
  JsonRpcClient<InitializeResult>,
  TranslatorEvent
> {
  private connectionManager: ConnectionManager<JsonRpcClient<InitializeResult>>;
  private currentTranslator: CodexAppServerTranslator | null = null;
  private activeThreadId: string | null = null;
  private model?: string;
  private modelProvider?: string;
  private reasoningEffort?: string;
  private sandboxConfig?: SandboxMode;
  private approvalPolicyConfig?: AskForApproval;

  /** Pending approval requests: requestId (JSON-RPC id) → kind + view. */
  private pendingApprovals = new Map<number | string, PendingApproval>();

  constructor(opts: CodexAppServerRunnerOptions) {
    super({ kind: opts.kind, sessionReader: opts.sessionReader }, opts.turnTimeoutMs);
    this.model = opts.model;
    this.modelProvider = opts.modelProvider;
    this.reasoningEffort = opts.reasoningEffort;
    this.sandboxConfig = opts.sandbox;
    this.approvalPolicyConfig = opts.approvalPolicy;

    const managerOpts: ConnectionManagerOptions<JsonRpcClient<InitializeResult>> = {
      binary: opts.binary ?? 'codex',
      args: opts.appServerArgs ?? ['app-server', '--stdio'],
      env: opts.env,
      requestTimeoutMs: opts.requestTimeoutMs,
      idleTtlMs: opts.idleTtlMs,
      // `experimentalApi: true` is required for `thread/settings/update`, which
      // lets config.save push approval/sandbox changes to a live thread instead
      // of waiting for the workspace-lifetime runner to be recreated.
      initializeParams: {
        clientInfo: {
          name: 'lark-remote',
          version: '1.0.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    };
    this.connectionManager = new ConnectionManager<JsonRpcClient<InitializeResult>>(managerOpts);
  }

  protected get logTag(): string {
    return 'codex-app-server-runner';
  }

  protected get turnTimeoutErrorMessage(): string {
    return 'Codex app-server turn timed out';
  }

  protected get turnInterruptedErrorMessage(): string {
    return 'Codex app-server turn interrupted';
  }

  protected currentSessionId(): string | null {
    return this.activeThreadId;
  }

  protected shouldDeferStop(): boolean {
    return !this.currentTurnId;
  }

  protected async cancelCurrentTurn(): Promise<void> {
    if (!this.currentClient || !this.activeThreadId || !this.currentTurnId) return;
    try {
      await (this.currentClient as JsonRpcClient).request('turn/interrupt', {
        threadId: this.activeThreadId,
        turnId: this.currentTurnId,
      });
    } catch (err) {
      getLogger().warn(`[${this.logTag}] interrupt failed: ${(err as Error).message}`);
    }
  }

  protected clearTurnState(): void {
    this.currentTranslator = null;
    this.activeThreadId = null;
  }

  protected async releaseConnection(cwd: string): Promise<void> {
    await this.connectionManager.release(cwd);
  }

  protected notifyIdle(cwd: string): void {
    this.connectionManager.notifyIdle(cwd);
  }

  protected async disposeConnections(): Promise<void> {
    await this.connectionManager.disposeAll();
  }

  /**
   * Run a compact operation on the current thread.
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    yield* this.executeTurn(opts, async () => {
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
      this.activeThreadId = opts.sessionId;

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
    });
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
      `[${this.logTag}] approval responded requestId=${requestId} kind=${pending.kind} action=${action}`,
    );
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

  /**
   * Unified approval-mode hot-update entry (called by the bridge via duck
   * typing on active runs). Codex's `thread/settings/update` applies the new
   * approval/sandbox policy to subsequent turns, even while the current turn
   * is still active. This lets `/config` take effect without waiting for this
   * workspace-lifetime runner to be recreated/evicted. Local fields are always
   * updated so `/status` reflects the new config immediately; if there is no
   * live thread, the next `thread/start`/`thread/resume` uses the new values
   * anyway.
   */
  async updateApprovalMode(settings: {
    approvalPolicy?: AskForApproval;
    sandbox?: SandboxMode;
  }): Promise<void> {
    if (settings.approvalPolicy !== undefined) {
      this.approvalPolicyConfig = settings.approvalPolicy;
    }
    if (settings.sandbox !== undefined) {
      this.sandboxConfig = settings.sandbox;
    }

    if (!this.currentClient || !this.activeThreadId) {
      return;
    }

    const params: ThreadSettingsUpdateParams = {
      threadId: this.activeThreadId,
      ...(settings.approvalPolicy !== undefined ? { approvalPolicy: settings.approvalPolicy } : {}),
      ...(settings.sandbox !== undefined
        ? { sandboxPolicy: sandboxModeToSandboxPolicy(settings.sandbox) }
        : {}),
    };

    try {
      await (this.currentClient as JsonRpcClient).request<
        ThreadSettingsUpdateParams,
        ThreadSettingsUpdateResponse
      >('thread/settings/update', params);
      getLogger().info(
        `[${this.logTag}] thread/settings/update applied for thread=${this.activeThreadId}`,
      );
    } catch (err) {
      // Config save must not fail because a live thread rejected an experimental
      // update (e.g. older Codex without thread/settings/update). The local
      // snapshot is already updated, so /status and the next thread start/resume
      // still use the new values.
      getLogger().warn(`[${this.logTag}] thread/settings/update failed: ${(err as Error).message}`);
    }
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
      threadId: this.activeThreadId ?? '',
      input: [{ type: 'text', text: message }],
      ...((opts.model ?? this.model) ? { model: opts.model ?? this.model } : {}),
      ...((opts.reasoningEffort ?? this.reasoningEffort)
        ? { effort: opts.reasoningEffort ?? this.reasoningEffort }
        : {}),
    };
    return params;
  }

  /**
   * Acquire the connection and set up the turn: thread/start（新会话）或
   * thread/resume（按 sessionId 恢复既有线程）→ turn/start。
   */
  protected async setupTurn(message: string, opts: SpawnOptions): Promise<void> {
    const client = await this.connectionManager.acquire(opts.cwd);
    this.connectionManager.notifyActivity(opts.cwd);
    this.currentClient = client;
    client.setHooks({
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onClose: () => {
        getLogger().warn(`[${this.logTag}] client connection closed`);
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
    this.activeThreadId = threadId;

    const translator = new CodexAppServerTranslator();
    this.currentTranslator = translator;

    const turnParams: TurnStartParams = this.buildTurnParams(message, opts);
    const turnResult = await client.request<TurnStartParams, TurnStartResponse>(
      'turn/start',
      turnParams,
    );
    this.currentTurnId = turnResult.turn.id;
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
      this.currentClient?.respondError(
        id,
        RpcErrorCode.METHOD_NOT_FOUND,
        `Unsupported server request: ${method}`,
      );
      return;
    }
    for (const ev of events) {
      if (ev.type === 'approval_requested') {
        this.pendingApprovals.set(ev.requestId, { kind: ev.kind, view: ev.view });
        getLogger().info(
          `[${this.logTag}] approval requested requestId=${ev.requestId} kind=${ev.kind}`,
        );
      }
    }
    this.pushEvents(events);
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
