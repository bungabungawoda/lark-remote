/**
 * BaseAcpRunner: shared turn machinery for the kimi / opencode ACP runners.
 *
 * Both runners extend ConnectionBasedRunner and were structurally aligned
 * (kimi's header even said so) — but session/resume→set_config→turn_started→
 * prompt orchestration, compact orchestration, approval response dispatch,
 * cancel/clear/release plumbing and the pendingApprovals registry were
 * line-for-line duplicated with only constants/field names differing
 * (round-2 simplification). This base absorbs them; what stays in
 * subclasses:
 *   - applyTurnSettings: mode/model下发 semantics differ (kimi unconditional,
 *     opencode conditional on cached values)
 *   - onCompactPromptFired: default is synchronous settlement (opencode /
 *     codebuddy); kimi overrides to poll wire.jsonl compaction records (§5.2,
 *     background compaction)
 *   - shouldDeferStop: kimi defers while prompt unsettled, opencode defers
 *     until the prompt has been SENT (deliberately narrower window)
 *   - handleNotification: agent-specific filtering (kimi: terminal-backed Bash)
 *   - handleServerRequest: default is translator dispatch + METHOD_NOT_FOUND
 *     fallback; kimi overrides to serve terminal/* reverse RPC and question
 *     elicitation
 *   - buildApprovalOutcome: default parameterised by `approvalKinds`; kimi
 *     overrides for its question bridge
 *   - getStatusInfo / updateApprovalMode: agent-specific extras & mode vocab
 */
import type { AgentKind } from '../../../agent-kinds.js';
import type { AgentSessionReader } from '../../../session-contract.js';
import type { AgentEvent, SpawnOptions } from '../../types.js';
import { ConnectionManager } from '../jsonrpc/connection-manager.js';
import { JsonRpcClient } from '../jsonrpc/client.js';
import {
  type SessionNewParams,
  type SessionNewResult,
  type SessionResumeParams,
  type SessionResumeResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionCancelParams,
  type RequestPermissionParams,
  RpcErrorCode,
} from './protocol-types.js';
import {
  buildAcpPermissionOutcome,
  respondAcpApproval,
  sendAcpSetMode,
  truncateWithEllipsis,
  type AcpApprovalKinds,
  type AcpPendingApproval,
} from './acp-approval.js';
import { getLogger } from '../../../logger/index.js';
import { ConnectionBasedRunner, type TurnAnchor } from '../connection-based-runner.js';
import { BaseAcpTranslator, type AcpTranslatorEvent } from './base-translator.js';

// Re-export for subclass convenience (kimi/opencode runners import from here).
export type { AcpTranslatorEvent } from './base-translator.js';

export abstract class BaseAcpRunner<
  TTranslator extends BaseAcpTranslator,
> extends ConnectionBasedRunner<JsonRpcClient, AcpTranslatorEvent> {
  protected readonly connectionManager: ConnectionManager;
  protected currentTranslator: TTranslator | null = null;
  protected activeSessionId: string | null = null;
  /**
   * 本轮 cwd。上游 401 时要按 cwd 丢掉 ConnectionManager 里的常驻连接：
   * 长驻 ACP 子进程持有旧登录态，不释放的话后续 turn 复用同一条连接，
   * 用户重新登录后仍会持续 401（/restart 也救不回来）。
   */
  protected authFailureCwd: string | null = null;
  protected model?: string;

  /** Pending approval requests: requestId → kind + view + options. */
  protected pendingApprovals = new Map<number | string, AcpPendingApproval>();

  /** Tracker for the in-flight prompt request — needed for cancellation. */
  protected promptSettled = false;
  /** Whether the prompt request has been fired (opencode defer-stop window). */
  protected promptSent = false;

  protected constructor(
    opts: { kind: AgentKind; sessionReader: AgentSessionReader; turnIdleTimeoutMs?: number },
    connectionManager: ConnectionManager,
  ) {
    super(opts);
    this.connectionManager = connectionManager;
    // 协议停止通道：ACP 的 cancel 就是 `session/cancel`，已由
    // cancelCurrentTurn 实现。这里只做登记接线——manager 建在 super() 实参里，
    // 那时 this 不可用，所以只能等 super() 返回后再赋值。
    connectionManager.stopper = ({ client }) => this.buildCooperativeStop(client);
  }

  /** failTurn message when the ACP connection drops mid-turn. */
  protected abstract get connectionClosedMessage(): string;

  /** Create the per-turn translator instance. */
  protected abstract createTranslator(): TTranslator;

  /**
   * Apply turn-scoped settings on a fresh session: configured model and
   * permission/mode. kimi sends both unconditionally (fresh ACP sessions
   * always start in 'default'), opencode skips when the cached value already
   * matches. Failures are non-fatal (warn only).
   */
  protected abstract applyTurnSettings(client: JsonRpcClient, sessionId: string): Promise<void>;

  /**
   * session/new|resume retry policy. Default: no retry. Agents whose ACP
   * server sits behind a separately-starting service (opencode v2) override
   * this to absorb a transient `ServiceUnavailableError` without failing the
   * whole turn.
   */
  protected sessionSetupRetryDelaysMs(): number[] {
    return [];
  }

  /** Whether a failed session/new|resume is safe to retry. */
  protected isRetryableSessionSetupError(_err: unknown): boolean {
    return false;
  }

  /** Final error surfaced to the user after retries are exhausted. */
  protected enrichSessionSetupError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * 本轮会话决策（setupTurn / runCompact 共用）。默认沿用既有语义：带
   * sessionId → session/resume，否则 session/new。
   *
   * 'reuse' = 会话已在当前连接上 open（如 qoder 长驻连接上一轮的会话保持
   * active，再发 session/resume 会被 CLI 拒绝 "already open (state=active)"
   * ，2026-11-07 真机实测），跳过建会话 RPC 直接 prompt。子类按各自 CLI 的
   * 语义覆写；默认恒不 reuse，kimi/opencode/codebuddy 行为不变。
   */
  protected turnSessionPlan(
    opts: SpawnOptions,
  ):
    { mode: 'new' } | { mode: 'resume'; sessionId: string } | { mode: 'reuse'; sessionId: string } {
    return opts.sessionId ? { mode: 'resume', sessionId: opts.sessionId } : { mode: 'new' };
  }

  /**
   * Dispatch the compact prompt result once fired. Default = 同步结算
   * （opencode / codebuddy 的 /compact 都在 prompt 结算前完成，无后台观察通道）：
   * 标准 prompt-settle 翻译 + 代际捕获。kimi 的压缩是后台任务，覆写本方法
   * 轮询 wire.jsonl 的新终态记录（§5.2）。
   */
  protected onCompactPromptFired(
    promptPromise: Promise<SessionPromptResult>,
    translator: TTranslator,
    sessionId: string,
    _opts: SpawnOptions,
    _baselineTotalCount: number,
  ): void {
    // 与 setupTurn 相同，捕获发起压缩那一轮的代际 + client；
    // 旧轮迟到的 prompt 结算不得写入新轮的共享队列。
    const generation = this.turnGeneration;
    const client = this.currentClient;
    promptPromise.then(
      (result) => {
        if (!this.isCurrentTurn(generation, client)) return;
        this.handlePromptResolved(result, translator, sessionId);
      },
      (err) => {
        if (!this.isCurrentTurn(generation, client)) return;
        this.handlePromptRejected(err, translator, sessionId, 'compact');
      },
    );
  }

  // =========================================================================
  // Shared plumbing
  // =========================================================================

  private async withSessionSetupRetry<T>(fn: () => Promise<T>): Promise<T> {
    const delays = this.sessionSetupRetryDelaysMs();
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (
          this.stopRequested ||
          attempt >= delays.length ||
          !this.isRetryableSessionSetupError(err)
        ) {
          throw this.enrichSessionSetupError(err);
        }
        const delay = delays[attempt]!;
        getLogger().warn(
          `[${this.logTag}] session setup failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delay}ms: ${(err as Error).message}`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * 建立会话（session/new|resume），重试耗尽后丢弃该 cwd 缓存的连接。
   *
   * 「服务端未就绪」类错误（isRetryableSessionSetupError）说明这个 agent server
   * 自身半死：opencode v2 的 location 在每轮拉起的 `opencode acp` 子进程里 boot，
   * boot 期间后台服务不可用会让它长期停在未激活，后续轮次复用同一连接只会重复
   * 失败——用户重启 opencode service 也治不好，因为连接缓存在本进程里
   * （4 次重试全失败，重启服务与 lark-remote 都无效）。丢掉连接
   * 后下一轮重新 spawn，拿到的是新进程的新状态。
   *
   * 只对声明为可重试的错误生效：kimi 等沿用默认 `isRetryableSessionSetupError`
   * = false，行为不变（session id 不存在之类的确定性失败不踢连接）。
   */
  private async setupSessionWithRetry<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.withSessionSetupRetry(fn);
    } catch (err) {
      if (this.isRetryableSessionSetupError(err)) {
        await this.discardConnection(cwd);
      }
      throw err;
    }
  }

  /** Dispose the cached connection for `cwd`; never mask the setup error. */
  private async discardConnection(cwd: string): Promise<void> {
    try {
      await this.connectionManager.release(cwd);
      getLogger().warn(
        `[${this.logTag}] dropped cached connection after session setup failure cwd=${cwd}`,
      );
    } catch (err) {
      getLogger().warn(
        `[${this.logTag}] failed to drop cached connection cwd=${cwd}: ${(err as Error).message}`,
      );
    }
  }

  protected currentSessionId(): string | null {
    return this.activeSessionId;
  }

  protected async cancelCurrentTurn(): Promise<void> {
    if (!this.currentClient || !this.activeSessionId) return;
    try {
      // session/cancel is a NOTIFICATION (no id, no response) per ACP spec.
      const cancelParams: SessionCancelParams = { sessionId: this.activeSessionId };
      this.currentClient.notify('session/cancel', cancelParams);
    } catch (err) {
      getLogger().warn(`[${this.logTag}] session/cancel failed: ${(err as Error).message}`);
    }
  }

  protected clearTurnState(): void {
    this.onClearTurnState();
    this.currentTranslator = null;
    this.promptSettled = false;
    this.promptSent = false;
    this.activeSessionId = null;
    // 未答的审批随轮次一起作废：连接是按工作区长驻的，请求 id 会从 1 重新
    // 计数，留着旧条目等于让下一轮的迟到的卡片点击回信到一条无关请求上。
    this.pendingApprovals.clear();
  }

  protected async releaseConnection(cwd: string): Promise<void> {
    await this.connectionManager.release(cwd);
  }

  protected notifyIdle(cwd: string): void {
    this.connectionManager.notifyIdle(cwd);
  }

  protected notifyConnectionActivity(cwd: string): void {
    this.connectionManager.notifyActivity(cwd);
  }

  /** Wire the acquired client's hooks into the turn dispatcher (anchor-guarded). */
  private installTurnHooks(anchor: TurnAnchor<JsonRpcClient>): void {
    anchor.client.setHooks({
      onNotification: this.forCurrentTurn(anchor, 'notification', (method, params) =>
        this.handleNotification(method, params),
      ),
      onServerRequest: this.forCurrentTurn(anchor, 'server request', (id, method, params) =>
        this.handleServerRequest(id, method, params),
      ),
      onClose: this.forCurrentTurn(anchor, 'connection close', () => {
        getLogger().warn(`[${this.logTag}] client connection closed`);
        this.onConnectionClosed();
        this.failTurn(this.connectionClosedMessage);
      }),
    });
  }

  protected async disposeConnections(): Promise<void> {
    await this.beforeDisposeConnections();
    await this.connectionManager.disposeAll();
  }

  /**
   * Respond to an approval server request. `response` is the bridge
   * ApprovalAction (`{ action: 'accept' | 'decline' | 'cancel' }`).
   */
  async respondApproval(requestId: number | string, response: unknown): Promise<void> {
    respondAcpApproval({
      client: this.currentClient,
      pendingApprovals: this.pendingApprovals,
      requestId,
      response,
      logTag: this.logTag,
      buildOutcome: (action, pending, resp) => this.buildApprovalOutcome(action, pending, resp),
    });
  }

  /** 各 ACP 服务端的 option kind 候选表；默认 buildApprovalOutcome 用它映射。 */
  protected abstract get approvalKinds(): AcpApprovalKinds;

  /**
   * Agent-specific outcome encoding. 默认实现按 approvalKinds 把 bridge 动作
   * 映射为 permission optionId；kimi 的 question 桥另有形态，覆写本方法。
   */
  protected buildApprovalOutcome(
    action: string,
    pending: AcpPendingApproval,
    _response: unknown,
  ): unknown {
    return buildAcpPermissionOutcome(action, pending.options, this.approvalKinds);
  }

  /** Shared tail of updateApprovalMode: re-send session/set_mode to the live session. */
  protected async sendApprovalModeUpdate(modeId: string): Promise<void> {
    await sendAcpSetMode({
      client: this.currentClient,
      activeSessionId: this.activeSessionId,
      modeId,
      logTag: this.logTag,
    });
  }

  /**
   * Register approval_requested events yielded by the translator into the
   * pendingApprovals map (shared tail of handleServerRequest).
   */
  protected registerApprovalEvents(
    events: AcpTranslatorEvent[],
    options: RequestPermissionParams['options'],
    proto?: AcpPendingApproval['proto'],
  ): void {
    for (const ev of events) {
      if (ev.type === 'approval_requested') {
        this.pendingApprovals.set(ev.requestId, {
          kind: ev.kind,
          view: ev.view,
          options,
          ...(proto ? { proto } : {}),
        });
        // 命令预览进日志：审批卡在飞书侧，日志是本地唯一的事后追溯通道
        // （kimi 的 request_permission 不带 rawInput，曾只剩 kind=command 可查）。
        const commandPreview = ev.view.command
          ? ` command=${truncateWithEllipsis(ev.view.command, 120)}`
          : '';
        getLogger().info(
          `[${this.logTag}] approval requested requestId=${ev.requestId} kind=${ev.kind}${commandPreview}`,
        );
      }
    }
  }

  /**
   * Standard prompt-settle translation: on resolve → result event (unless
   * stopRequested); on reject → error result (or warn when already stopped).
   * `context` only decorates the stopRequested warn line.
   */
  protected handlePromptRejected(
    err: unknown,
    translator: TTranslator,
    sessionId: string,
    context: string,
  ): void {
    this.promptSettled = true;
    if (this.stopRequested) {
      getLogger().warn(
        `[${this.logTag}] ${context} prompt rejected after stopRequested: ${(err as Error).message}`,
      );
      return;
    }
    const resultEvent = translator.produceErrorResult(sessionId, (err as Error).message);
    this.maybeHandleAuthenticationFailure(resultEvent);
    this.pushEvents([resultEvent]);
  }

  protected handlePromptResolved(
    result: SessionPromptResult,
    translator: TTranslator,
    sessionId: string,
  ): void {
    this.promptSettled = true;
    if (this.stopRequested) return; // already cancelled
    const resultEvent = translator.handlePromptResponse(sessionId, result);
    this.maybeHandleAuthenticationFailure(resultEvent);
    this.pushEvents([resultEvent]);
  }

  /**
   * translator 打标的 401 是身份失效信号：先丢掉本 cwd 的长驻连接，让下一轮
   * acquire 用磁盘上的新登录态重新 spawn。目录缓存 / 持久会话 / runner 槽位
   * 由 bridge 在消费这个 result 事件时一并清理（它同时持有这三份状态）。
   */
  private maybeHandleAuthenticationFailure(resultEvent: AgentEvent): void {
    if (resultEvent.type !== 'result' || !resultEvent.authFailure) return;
    const cwd = this.authFailureCwd;
    if (!cwd) return;
    getLogger().warn(
      `[${this.logTag}] upstream authentication failure, dropping cached connection cwd=${cwd}`,
    );
    void this.releaseConnection(cwd).catch((err: Error) => {
      getLogger().warn(
        `[${this.logTag}] release connection after auth failure failed: ${err.message}`,
      );
    });
  }

  // =========================================================================
  // Turn orchestration
  // =========================================================================

  /**
   * Acquire the connection and set up the turn: session/new (new session) or
   * session/resume (existing sessionId) → applyTurnSettings → session/prompt.
   */
  protected async setupTurn(message: string, opts: SpawnOptions): Promise<void> {
    this.authFailureCwd = opts.cwd;
    // 本轮回调归属锚点（代际 + client）由 acquireForTurn 捕获：旧轮迟到的
    // prompt 结果/通知在新轮开始时 stopRequested 已被重置，只有这对值能识别它。
    const anchor = await this.acquireForTurn(opts.cwd, () =>
      this.connectionManager.acquire(opts.cwd),
    );
    this.onConnectionAcquired(opts);
    this.installTurnHooks(anchor);
    const { client } = anchor;

    let sessionId: string;
    const plan = this.turnSessionPlan(opts);
    if (plan.mode === 'resume') {
      const resumeParams: SessionResumeParams = {
        sessionId: plan.sessionId,
        cwd: opts.cwd,
      };
      const resumeResult = await this.setupSessionWithRetry(opts.cwd, () =>
        client.request<SessionResumeParams, SessionResumeResult>('session/resume', resumeParams),
      );
      this.onSessionEstablished(resumeResult);
      sessionId = plan.sessionId;
    } else if (plan.mode === 'reuse') {
      // 会话已在本连接 open：跳过建会话 RPC，直接沿用（qoder 的 already-open
      // 语义，见 turnSessionPlan 注释）。
      sessionId = plan.sessionId;
    } else {
      const newParams: SessionNewParams = { cwd: opts.cwd, mcpServers: [] };
      const newResult = await this.setupSessionWithRetry(opts.cwd, () =>
        client.request<SessionNewParams, SessionNewResult>('session/new', newParams),
      );
      this.onSessionEstablished(newResult);
      sessionId = newResult.sessionId;
    }
    this.activeSessionId = sessionId;
    this.onTurnSessionReady(sessionId, opts);

    await this.applyTurnSettings(client, sessionId);

    const translator = this.createTranslator();
    this.currentTranslator = translator;

    // Emit turn_started before prompt
    const turnId = `turn-${Date.now()}`;
    const turnStarted = translator.produceTurnStarted(sessionId, turnId);
    this.currentTurnId = turnId;
    this.pushEvents([turnStarted]);

    // Send the prompt. The prompt request races with notifications (the
    // server streams session/update before the prompt response); the
    // response settles the turn and is translated into the result event.
    const promptParams: SessionPromptParams = {
      sessionId,
      prompt: [{ type: 'text', text: message }],
    };

    this.promptSettled = false;
    const promptPromise = client.request<SessionPromptParams, SessionPromptResult>(
      'session/prompt',
      promptParams,
      Number.POSITIVE_INFINITY, // response held for the whole turn; idle watchdog guards liveness
    );
    this.promptSent = true;

    promptPromise.then(
      this.forCurrentTurn(anchor, 'late prompt result', (result) =>
        this.handlePromptResolved(result, translator, sessionId),
      ),
      this.forCurrentTurn(anchor, 'late prompt rejection', (err) =>
        this.handlePromptRejected(err, translator, sessionId, ''),
      ),
    );
  }

  /**
   * Run a compact operation on the current session: resume → '/compact'
   * prompt text (both servers intercept it) → agent-specific result dispatch.
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    this.authFailureCwd = opts.cwd;
    yield* this.executeTurn(opts, async () => {
      // 同 setupTurn：acquireForTurn 捕获代际锚点，installTurnHooks 守卫 dispatch。
      const anchor = await this.acquireForTurn(opts.cwd, () =>
        this.connectionManager.acquire(opts.cwd),
      );
      this.onConnectionAcquired(opts);
      this.installTurnHooks(anchor);
      const { client } = anchor;

      const sessionId = opts.sessionId;
      if (!sessionId) {
        throw new Error('compact requires a sessionId');
      }
      this.activeSessionId = sessionId;
      this.onTurnSessionReady(sessionId, opts);

      // Cold-connection fallback: session/resume loads the session into
      // memory. On a reused connection the session may already be open —
      // whether re-resume is harmless is per-CLI semantics (qoder rejects
      // with "already open"), so the resume decision goes through the same
      // plan hook as setupTurn.
      const compactPlan = this.turnSessionPlan({ ...opts, sessionId });
      if (compactPlan.mode === 'resume') {
        const resumeParams: SessionResumeParams = {
          sessionId: compactPlan.sessionId,
          cwd: opts.cwd,
        };
        const resumeResult = await this.setupSessionWithRetry(opts.cwd, () =>
          client.request<SessionResumeParams, SessionResumeResult>('session/resume', resumeParams),
        );
        this.onSessionEstablished(resumeResult);
      }

      const translator = this.createTranslator();
      translator.setOperationKind('compact');
      this.currentTranslator = translator;

      // Emit turn_started with operationKind='compaction' before the prompt.
      const turnId = `compact-${Date.now()}`;
      const turnStarted = translator.produceTurnStarted(sessionId, turnId);
      this.currentTurnId = turnId;
      this.pushEvents([turnStarted]);

      const promptParams: SessionPromptParams = {
        sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      };

      // Baseline is captured BEFORE the prompt fires (kimi §5.2: a begin
      // record landing after the fire must count as "new activity").
      const baselineTotalCount = this.compactBaseline(sessionId, opts);

      this.promptSettled = false;
      // ACP holds the session/prompt response for the ENTIRE turn, so the
      // RPC-level timeout must not apply — turn liveness is guarded by the
      // rolling idle watchdog instead.
      const promptPromise = client.request<SessionPromptParams, SessionPromptResult>(
        'session/prompt',
        promptParams,
        Number.POSITIVE_INFINITY,
      );
      this.promptSent = true;

      this.onCompactPromptFired(promptPromise, translator, sessionId, opts, baselineTotalCount);
    });
  }

  // =========================================================================
  // Optional hooks (defaults: no-op)
  // =========================================================================

  /** After the connection is acquired per turn (kimi: record active cwd). */
  protected onConnectionAcquired(_opts: SpawnOptions): void {}

  /** When the ACP connection drops (kimi: kill live terminals). */
  protected onConnectionClosed(): void {}

  /** After the turn's session id is known (opencode: start log error monitor). */
  protected onTurnSessionReady(_sessionId: string, _opts: SpawnOptions): void {}

  /** After session/new|resume resolves (opencode: track configOptions). */
  protected onSessionEstablished(_result: SessionResumeResult | SessionNewResult): void {}

  /** Compaction baseline record count, captured before the compact prompt (kimi). */
  protected compactBaseline(_sessionId: string, _opts: SpawnOptions): number {
    return 0;
  }

  /** Wire the active client's JSON-RPC hooks into the subclass dispatcher. */
  protected abstract handleNotification(method: string, params: unknown): void;

  /**
   * 默认 server-request 编排：translator 产出事件 → 登记审批 + 推流；
   * 无事件 → respondError(METHOD_NOT_FOUND)，否则服务端会一直挂着等回信。
   * kimi 覆写（terminal/* 反向 RPC + question elicitation 特判）。
   */
  protected handleServerRequest(id: number | string, method: string, params: unknown): void {
    const events: AcpTranslatorEvent[] =
      this.currentTranslator?.handleServerRequest(id, method, params) ?? [];

    if (events.length === 0) {
      // Unhandled/unsupported server requests must be explicitly responded to
      // (error = "rejected"), otherwise the server hangs waiting for a
      // response（opencode / codebuddy 同口径；未声明的能力服务端不应发送）。
      this.currentClient?.respondError(
        id,
        RpcErrorCode.METHOD_NOT_FOUND,
        `Unsupported server request: ${method}`,
      );
      getLogger().info(
        `[${this.logTag}] rejected unsupported server request method=${method} id=${id}`,
      );
      return;
    }

    this.registerApprovalEvents(events, (params as RequestPermissionParams).options);
    this.pushEvents(events);
  }

  /** Extra per-turn state cleanup (kimi: active cwd; opencode: error monitor). */
  protected onClearTurnState(): void {}

  /** Extra dispose-time cleanup before connections are disposed (kimi: terminals). */
  protected async beforeDisposeConnections(): Promise<void> {}
}
