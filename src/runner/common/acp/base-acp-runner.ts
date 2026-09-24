/**
 * BaseAcpRunner: shared turn machinery for the kimi / opencode ACP runners.
 *
 * Both runners extend ConnectionBasedRunner and were structurally aligned
 * (kimi's header even said so) — but session/resume→set_config→turn_started→
 * prompt orchestration, compact orchestration, approval response dispatch,
 * cancel/clear/release plumbing and the pendingApprovals registry were
 * line-for-line duplicated with only constants/field names differing
 * (2026-09 round-2 simplification). This base absorbs them; what stays in
 * subclasses:
 *   - applyTurnSettings: mode/model下发 semantics differ (kimi unconditional,
 *     opencode conditional on cached values)
 *   - onCompactPromptFired: kimi polls wire.jsonl compaction records (§5.2,
 *     background compaction), opencode settles synchronously
 *   - shouldDeferStop: kimi defers while prompt unsettled, opencode defers
 *     until the prompt has been SENT (deliberately narrower window)
 *   - handleNotification/handleServerRequest: kimi filters terminal-backed
 *     Bash notifications and serves terminal/* reverse RPC; opencode is plain
 *   - getStatusInfo / updateApprovalMode: agent-specific extras & mode vocab
 */
import type { AgentEvent, AgentKind, AgentSessionReader, SpawnOptions } from '../../types.js';
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
} from './protocol-types.js';
import {
  respondAcpApproval,
  sendAcpSetMode,
  truncateWithEllipsis,
  type AcpPendingApproval,
} from './protocol-helpers.js';
import { getLogger } from '../../../logger/index.js';
import { ConnectionBasedRunner } from '../connection-based-runner.js';
import { BaseAcpTranslator, type AcpTranslatorEvent } from './base-translator.js';

// Re-export for subclass convenience (kimi/opencode runners import from here).
export type { AcpTranslatorEvent } from './base-translator.js';

export abstract class BaseAcpRunner<
  TTranslator extends BaseAcpTranslator,
> extends ConnectionBasedRunner<JsonRpcClient, AcpTranslatorEvent> {
  protected readonly connectionManager: ConnectionManager;
  protected currentTranslator: TTranslator | null = null;
  protected activeSessionId: string | null = null;
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
   * Dispatch the compact prompt result once fired. kimi: background
   * compaction — poll wire.jsonl for a NEW terminal record before translating
   * (§5.2). opencode: synchronous — standard prompt-settle translation.
   */
  protected abstract onCompactPromptFired(
    promptPromise: Promise<SessionPromptResult>,
    translator: TTranslator,
    sessionId: string,
    opts: SpawnOptions,
    baselineTotalCount: number,
  ): void;

  // =========================================================================
  // Shared plumbing
  // =========================================================================

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

  /** Agent-specific outcome encoding (kimi: question bridge; opencode: permission). */
  protected abstract buildApprovalOutcome(
    action: string,
    pending: AcpPendingApproval,
    response: unknown,
  ): unknown;

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
    this.pushEvents([resultEvent]);
  }

  // =========================================================================
  // Turn orchestration
  // =========================================================================

  /**
   * Acquire the connection and set up the turn: session/new (new session) or
   * session/resume (existing sessionId) → applyTurnSettings → session/prompt.
   */
  protected async setupTurn(message: string, opts: SpawnOptions): Promise<void> {
    const client = await this.connectionManager.acquire(opts.cwd);
    this.connectionManager.notifyActivity(opts.cwd);
    this.currentClient = client;
    this.onConnectionAcquired(opts);
    client.setHooks({
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onClose: () => {
        getLogger().warn(`[${this.logTag}] client connection closed`);
        this.onConnectionClosed();
        this.failTurn(this.connectionClosedMessage);
      },
    });

    let sessionId: string;
    if (opts.sessionId) {
      const resumeParams: SessionResumeParams = {
        sessionId: opts.sessionId,
        cwd: opts.cwd,
      };
      const resumeResult = await client.request<SessionResumeParams, SessionResumeResult>(
        'session/resume',
        resumeParams,
      );
      this.onSessionEstablished(resumeResult);
      sessionId = opts.sessionId;
    } else {
      const newParams: SessionNewParams = { cwd: opts.cwd, mcpServers: [] };
      const newResult = await client.request<SessionNewParams, SessionNewResult>(
        'session/new',
        newParams,
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
      (result) => this.handlePromptResolved(result, translator, sessionId),
      (err) => this.handlePromptRejected(err, translator, sessionId, ''),
    );
  }

  /**
   * Run a compact operation on the current session: resume → '/compact'
   * prompt text (both servers intercept it) → agent-specific result dispatch.
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    yield* this.executeTurn(opts, async () => {
      const client = await this.connectionManager.acquire(opts.cwd);
      this.connectionManager.notifyActivity(opts.cwd);
      this.currentClient = client;
      this.onConnectionAcquired(opts);
      client.setHooks({
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
        onClose: () => {
          this.onConnectionClosed();
          this.failTurn(this.connectionClosedMessage);
        },
      });

      const sessionId = opts.sessionId;
      if (!sessionId) {
        throw new Error('compact requires a sessionId');
      }
      this.activeSessionId = sessionId;
      this.onTurnSessionReady(sessionId, opts);

      // Cold-connection fallback: session/resume loads the session into
      // memory. On a reused connection the session is already loaded —
      // resume is idempotent and harmless.
      const resumeParams: SessionResumeParams = { sessionId, cwd: opts.cwd };
      const resumeResult = await client.request<SessionResumeParams, SessionResumeResult>(
        'session/resume',
        resumeParams,
      );
      this.onSessionEstablished(resumeResult);

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
  protected abstract handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void;

  /** Extra per-turn state cleanup (kimi: active cwd; opencode: error monitor). */
  protected onClearTurnState(): void {}

  /** Extra dispose-time cleanup before connections are disposed (kimi: terminals). */
  protected async beforeDisposeConnections(): Promise<void> {}
}
