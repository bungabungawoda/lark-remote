/**
 * KimiAcpRunner: workspace-lifetime runner using the Kimi ACP protocol
 * (`kimi acp`, JSON-RPC over stdio).
 *
 * Flow per run: acquire persistent connection → session/new or session/resume
 * → synthetic init → session/prompt → consume session/update notifications
 * until prompt settles → result event.
 *
 * Structurally aligned with codex AppServerRunner (design doc §3.1) via the
 * shared ConnectionBasedRunner base: same notification queue + waitResolve
 * pattern, same forceFinish/stopRequested semantics, same turn idle timeout,
 * same ConnectionLostError retry.
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
  ConnectionManager as KimiAcpConnectionManager,
  type ConnectionManagerOptions as KimiAcpConnectionManagerOptions,
} from '../../common/jsonrpc/connection-manager.js';
import { JsonRpcClient as KimiAcpClient } from '../../common/jsonrpc/client.js';
import { KimiAcpTranslator, type AcpTranslatorEvent } from './translator.js';
import {
  type AcpMode,
  type SessionNewParams,
  type SessionNewResult,
  type SessionResumeParams,
  type SessionResumeResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionCancelParams,
  type SessionSetModeParams,
  type RequestPermissionParams,
  type RequestPermissionResponse,
  type ElicitationCreateResponse,
  type PermissionOption,
  RpcErrorCode,
  ServerRequestMethod,
} from '../../common/acp/protocol-types.js';
import { findOptionIdByKind } from '../../common/acp/protocol-helpers.js';
import { mapAnswersByIndex } from '../../question-common.js';
import { getLogger } from '../../../logger/index.js';
import { ConnectionBasedRunner } from '../../common/connection-based-runner.js';

// =============================================================================
// Configuration
// =============================================================================

export interface KimiAcpRunnerOptions {
  kind: AgentKind;
  sessionReader: AgentSessionReader;
  /** Path to the kimi binary. Defaults to `kimi`. */
  binary?: string;
  /** Environment variables. */
  env?: Record<string, string | undefined>;
  /** Args to spawn the ACP server with. Defaults to `['acp']`. */
  acpArgs?: string[];
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Idle TTL for connection manager. */
  idleTtlMs?: number;
  /** How long to wait for turn output before failing. Defaults to 10 min. */
  turnIdleTimeoutMs?: number;
  /** R2: how long to poll wire.jsonl for the compaction record after the
   *  /compact prompt settles. Defaults to 30s; WARN (not fail) on timeout. */
  compactPollTimeoutMs?: number;
  model?: string;
  /** Kimi permission mode (user-facing: manual/auto/yolo). */
  permissionMode?: 'manual' | 'auto' | 'yolo';
}

/** R2: how long to wait for the background compaction record after the
 *  /compact prompt settles (design doc §6.1). Real kimi 0.36.0 lands
 *  context.apply_compaction ~8s after end_turn. */
const COMPACT_POLL_TIMEOUT_MS = 30_000;
/** Poll interval for the wire.jsonl compaction record. */
const COMPACT_POLL_INTERVAL_MS = 1_000;

/** Minimal shape of a wire.jsonl compaction record (full source of truth:
 *  kimi-code wire-manifest — context.apply_compaction carries
 *  compactedCount/tokensBefore/tokensAfter; full_compaction.complete is
 *  {type, time} only). */
interface CompactionRecordLike {
  type: string;
  compactedCount?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  time: number;
}

/** Duck-typed capability on the session reader for R2 polling. */
interface CompactionRecordReader {
  readCompactionRecords?(sessionId: string, cwd: string): CompactionRecordLike[];
}

/**
 * Map user-facing permission mode to ACP mode id.
 *
 * ACP layer mode ids (acp-server/src/modes.ts:49):
 *   default → permission manual
 *   auto    → permission auto
 *   yolo    → permission yolo
 *   plan    → not exposed in v1
 *
 * This is not self-invented naming — both are official enums at their
 * respective layers. The mapping happens only at the ACP boundary.
 */
function toAcpMode(mode: 'manual' | 'auto' | 'yolo'): AcpMode {
  switch (mode) {
    case 'manual':
      return 'default';
    case 'auto':
      return 'auto';
    case 'yolo':
      return 'yolo';
  }
}

/**
 * Build the ACP protocol response for a permission approval decision.
 *
 * accept            → {outcome:{outcome:'selected', optionId:<approve_once kind>}}
 * accept_for_session → {outcome:{outcome:'selected', optionId:<approve_always kind>}}
 * decline           → {outcome:{outcome:'selected', optionId:<reject kind>}}
 * cancel            → {outcome:{outcome:'cancelled'}}
 *
 * optionId is looked up from the request's options[] by kind (approval.ts:28-29):
 * approve_once / approve_always / allow_once for accept;
 * approve_always / allow_always for accept_for_session;
 * reject / reject_once for decline. If not found, fall back to cancelled
 * (safe universal default — the server treats it as "user declined").
 *
 * 2026-08-15 live test: approve_once + approve_always + reject observed.
 */
function buildApprovalResponse(
  action: string,
  pending: PendingApproval,
): RequestPermissionResponse {
  if (action === 'cancel') {
    return { outcome: { outcome: 'cancelled' } };
  }
  if (action === 'accept') {
    const optionId = findOptionIdByKind(pending.options, [
      'approve_once',
      'approve_always',
      'allow_once',
    ]);
    if (optionId) {
      return { outcome: { outcome: 'selected', optionId } };
    }
    // Fallback: can't find allow option → cancel is safe
    return { outcome: { outcome: 'cancelled' } };
  }
  if (action === 'accept_for_session') {
    // §P4: 卡片「允许本次会话」→ always 类 optionId（kimi approve_always）
    const optionId = findOptionIdByKind(pending.options, ['approve_always', 'allow_always']);
    if (optionId) {
      return { outcome: { outcome: 'selected', optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }
  // decline
  const optionId = findOptionIdByKind(pending.options, ['reject', 'reject_once']);
  if (optionId) {
    return { outcome: { outcome: 'selected', optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * AskUserQuestion 回编（kind === 'question'）：
 * - elicitation form：answer → {action:'accept', content:{q0..qn}}（多选数组/
 *   单选字符串，key 按问题顺序）；decline → {action:'decline'}；cancel →
 *   {action:'cancel'}。
 * - request_permission 兜底桥：answer → 按 label 回显 q0_opt_{i} optionId；
 *   decline → q0_skip optionId（无则 cancelled）；cancel → cancelled。
 * 答案以 {问题文本: 值} 回传，先按问题顺序展开再协议编码。
 */
function buildQuestionResponse(
  action: string,
  pending: PendingApproval,
  response: unknown,
): RequestPermissionResponse | ElicitationCreateResponse {
  if (pending.proto === 'elicitation') {
    if (action === 'answer') {
      const answers = (response as { answers?: Record<string, string | string[]> }).answers;
      const questions = pending.view.questions ?? [];
      const byIndex = mapAnswersByIndex(questions, answers ?? {});
      const content: Record<string, string | string[]> = {};
      questions.forEach((q, i) => {
        const value = byIndex[i];
        if (value === undefined) return;
        if (q.multiSelect) {
          const values = Array.isArray(value) ? value : [value];
          const cleaned = values.filter((v) => typeof v === 'string' && v.length > 0);
          if (cleaned.length > 0) content[`q${i}`] = cleaned;
        } else {
          const single = Array.isArray(value) ? value[0] : value;
          if (typeof single === 'string' && single.length > 0) content[`q${i}`] = single;
        }
      });
      return { action: 'accept', content };
    }
    if (action === 'decline') return { action: 'decline' };
    return { action: 'cancel' };
  }

  // request_permission 兜底桥（单题单选）
  if (action === 'answer') {
    const answers = (response as { answers?: Record<string, string | string[]> }).answers;
    const first = pending.view.questions?.[0];
    const value = first ? answers?.[first.question] : undefined;
    const label = Array.isArray(value) ? value[0] : value;
    const option = (pending.options ?? []).find(
      (opt) => /^q\d+_opt_\d+$/.test(opt.optionId) && opt.name === label,
    );
    if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
    return { outcome: { outcome: 'cancelled' } };
  }
  if (action === 'decline') {
    const skip = (pending.options ?? []).find((opt) => /^q\d+_skip$/.test(opt.optionId));
    if (skip) return { outcome: { outcome: 'selected', optionId: skip.optionId } };
    return { outcome: { outcome: 'cancelled' } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

interface PendingApproval {
  kind: 'command' | 'file' | 'permissions' | 'question' | 'tool';
  view: ApprovalView;
  options: PermissionOption[];
  /** 提问来源：elicitation form / request_permission 兜底桥（决定回编形状）。 */
  proto?: 'elicitation' | 'permission';
}

// =============================================================================
// Runner
// =============================================================================

export class KimiAcpRunner extends ConnectionBasedRunner<KimiAcpClient, AcpTranslatorEvent> {
  private connectionManager: KimiAcpConnectionManager;
  private currentTranslator: KimiAcpTranslator | null = null;
  private activeSessionId: string | null = null;
  private model?: string;
  private permissionMode: 'manual' | 'auto' | 'yolo';
  private readonly compactPollTimeoutMs: number;

  /** Pending approval requests: requestId → kind + view + options. */
  private pendingApprovals = new Map<number | string, PendingApproval>();

  /** Tracker for the in-flight prompt request — needed for cancellation. */
  private promptSettled = false;

  constructor(opts: KimiAcpRunnerOptions) {
    super({ kind: opts.kind, sessionReader: opts.sessionReader }, opts.turnIdleTimeoutMs);
    this.model = opts.model;
    this.permissionMode = opts.permissionMode ?? 'manual';
    this.compactPollTimeoutMs = opts.compactPollTimeoutMs ?? COMPACT_POLL_TIMEOUT_MS;

    const managerOpts: KimiAcpConnectionManagerOptions = {
      binary: opts.binary ?? 'kimi',
      args: opts.acpArgs ?? ['acp'],
      env: opts.env,
      requestTimeoutMs: opts.requestTimeoutMs,
      idleTtlMs: opts.idleTtlMs,
      initializeParams: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // AskUserQuestion 走 elicitation form（原生多题+多选；form 失败时
          // kimi 服务端自动回退 request_permission 桥，客户端两者都处理）。
          // 注意：ACP SDK 对 elicitation.form 的 zod schema 是对象
          // （z.record(z.string(), z.any())），布尔 true 会被 kimi 服务端静默
          // 丢弃 → elicitationForm=false → 多选回退成 request_permission 单选
          // 桥（勾一个选项即提交）。必须用空对象 {}。
          elicitation: { form: {} },
        },
      },
    };
    this.connectionManager = new KimiAcpConnectionManager(managerOpts);
  }

  protected get logTag(): string {
    return 'kimi-acp-runner';
  }

  protected get turnTimeoutErrorMessage(): string {
    return 'Kimi ACP turn timed out';
  }

  protected get turnInterruptedErrorMessage(): string {
    return 'Kimi ACP turn interrupted';
  }

  protected currentSessionId(): string | null {
    return this.activeSessionId;
  }

  protected shouldDeferStop(): boolean {
    return !this.promptSettled;
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
    this.currentTranslator = null;
    this.promptSettled = false;
    this.activeSessionId = null;
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
   * Run a compact operation on the current session.
   *
   * Design doc §6.1: acquire → session/resume → session/prompt with "/compact"
   * text (builtin slash command, host intercepts) → consume notifications until
   * prompt settles.
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    yield* this.executeTurn(opts, async () => {
      const client = await this.connectionManager.acquire(opts.cwd);
      this.connectionManager.notifyActivity(opts.cwd);
      this.currentClient = client;
      client.setHooks({
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
        onClose: () => this.failTurn('Kimi ACP connection closed'),
      });

      const sessionId = opts.sessionId;
      if (!sessionId) {
        throw new Error('compact requires a sessionId');
      }
      this.activeSessionId = sessionId;

      // Cold-connection fallback: session/resume loads the session into memory.
      // On a reused connection the session is already loaded — resume is
      // idempotent and harmless; after connection rebuild it's required.
      const resumeParams: SessionResumeParams = {
        sessionId,
        cwd: opts.cwd,
      };
      await client.request<SessionResumeParams, SessionResumeResult>(
        'session/resume',
        resumeParams,
      );

      const translator = new KimiAcpTranslator();
      translator.setOperationKind('compact');
      this.currentTranslator = translator;

      // Emit turn_started with operationKind='compaction' before the prompt
      // (consumeTurn yields it while the background compaction runs).
      const turnId = `compact-${Date.now()}`;
      const turnStarted = translator.produceTurnStarted(sessionId, turnId);
      this.currentTurnId = turnId;
      this.pushEvents([turnStarted]);

      // Send /compact as prompt text
      const promptParams: SessionPromptParams = {
        sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      };

      // R2: compaction is a BACKGROUND task — the prompt settles before the
      // wire.jsonl compaction record lands (real kimi: ~8s). Baseline the
      // record count, fire the prompt without awaiting (notifications flow
      // through consumeTurn), then poll for a NEW record before producing
      // the result. This keeps the connection alive while the background
      // compaction finishes — otherwise dispose/exit kills it and the record
      // never lands (S5/S6 打回复现).
      const compactionReader = (this.sessionReader as CompactionRecordReader).readCompactionRecords;
      const baselineCount = compactionReader
        ? compactionReader.call(this.sessionReader, sessionId, opts.cwd).length
        : 0;

      this.promptSettled = false;
      // ACP holds the session/prompt response for the ENTIRE turn (unlike
      // codex turn/start), so the RPC-level timeout must not apply here —
      // turn liveness is guarded by the rolling idle watchdog instead.
      const promptPromise = client.request<SessionPromptParams, SessionPromptResult>(
        'session/prompt',
        promptParams,
        Number.POSITIVE_INFINITY,
      );

      promptPromise.then(
        async (result) => {
          this.promptSettled = true;
          if (this.stopRequested) return; // already cancelled
          if (compactionReader) {
            await this.waitForCompactionRecord(compactionReader, opts, baselineCount);
          }
          if (this.forceFinish) return; // stopped while polling
          // Translate prompt result into a result event
          const resultEvent = translator.handlePromptResponse(sessionId, result);
          this.pushEvents([resultEvent]);
        },
        (err) => {
          this.promptSettled = true;
          if (this.stopRequested) {
            getLogger().warn(
              `[${this.logTag}] compact prompt rejected after stopRequested: ${(err as Error).message}`,
            );
            return;
          }
          const resultEvent = translator.produceErrorResult(sessionId, (err as Error).message);
          this.pushEvents([resultEvent]);
        },
      );
    });
  }

  /**
   * Respond to an approval server request. `response` is the bridge
   * ApprovalAction (`{ action: 'accept' | 'decline' | 'cancel' }`).
   */
  async respondApproval(requestId: number | string, response: unknown): Promise<void> {
    const client = this.currentClient;
    const pending = this.pendingApprovals.get(requestId);
    if (!client || !pending) return;

    const action = (response as { action?: string })?.action ?? 'decline';
    const acpResponse =
      pending.kind === 'question'
        ? buildQuestionResponse(action, pending, response)
        : buildApprovalResponse(action, pending);
    client.respond(requestId, acpResponse);
    this.pendingApprovals.delete(requestId);
    getLogger().info(`[${this.logTag}] approval responded requestId=${requestId} action=${action}`);
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: this.kind,
      model: this.model ?? '(kimi-acp)',
      extras: {
        mode: 'acp',
        permissionMode: this.permissionMode,
      },
    };
  }

  /**
   * Hot-apply a permission-mode change to the live ACP session (§P5).
   *
   * The local cache is always updated so `getStatusInfo()` (and therefore
   * `/s`) reflects the new mode immediately. When a session is connected,
   * re-sends `session/set_mode` so the running session picks up the new mode
   * without waiting for the runner to be evicted/recreated. Failure is
   * non-fatal: the next setupTurn re-applies the cached mode unconditionally.
   */
  async updateApprovalMode(settings: {
    permissionMode?: 'manual' | 'auto' | 'yolo';
  }): Promise<void> {
    if (settings.permissionMode !== undefined) {
      this.permissionMode = settings.permissionMode;
    }
    if (!this.currentClient || !this.activeSessionId) return;

    const modeParams: SessionSetModeParams = {
      sessionId: this.activeSessionId,
      modeId: toAcpMode(this.permissionMode),
    };
    try {
      await this.currentClient.request('session/set_mode', modeParams);
      getLogger().info(
        `[${this.logTag}] session/set_mode hot-applied session=${this.activeSessionId} modeId=${modeParams.modeId}`,
      );
    } catch (err) {
      getLogger().warn(
        `[${this.logTag}] session/set_mode failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  // =========================================================================
  // Internal
  // =========================================================================

  /**
   * Acquire the connection and set up the turn:
   * session/new (new session) or session/resume (existing sessionId)
   * → set permission mode if needed → session/prompt.
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
        this.failTurn('Kimi ACP connection closed');
      },
    });

    let sessionId: string;
    if (opts.sessionId) {
      const resumeParams: SessionResumeParams = {
        sessionId: opts.sessionId,
        cwd: opts.cwd,
      };
      await client.request<SessionResumeParams, SessionResumeResult>(
        'session/resume',
        resumeParams,
      );
      sessionId = opts.sessionId;
    } else {
      const newParams: SessionNewParams = { cwd: opts.cwd, mcpServers: [] };
      const newResult = await client.request<SessionNewParams, SessionNewResult>(
        'session/new',
        newParams,
      );
      sessionId = newResult.sessionId;
    }
    this.activeSessionId = sessionId;

    // CC-07: 下发配置的模型（provider/model）。session/new|resume 只带 cwd/mcpServers，
    // 不带 model；不主动下发则实际跑 kimi 服务端默认模型（旧 KimiRunner 通过 -m 传模型，
    // 迁移到纯 ACP 后丢失）。仿 opencode 用 session/set_config_option。失败仅告警不阻断。
    if (this.model) {
      try {
        await client.request('session/set_config_option', {
          sessionId,
          configId: 'model',
          value: this.model,
        });
      } catch (err) {
        getLogger().warn(
          `[${this.logTag}] set_config_option model failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }

    // Set permission mode (§5.1): EVERY fresh ACP session starts in
    // 'default' (= manual approvals, acp-server modes.ts DEFAULT_MODE_ID),
    // so the mode must be sent unconditionally — skipping yolo leaves the
    // session in manual and tool calls stall on unanswered approvals
    // (live dark-test repro: approval_requested → idle timeout).
    const modeParams: SessionSetModeParams = {
      sessionId,
      modeId: toAcpMode(this.permissionMode),
    };
    try {
      await client.request('session/set_mode', modeParams);
    } catch (err) {
      getLogger().warn(
        `[${this.logTag}] session/set_mode failed (non-fatal): ${(err as Error).message}`,
      );
    }

    const translator = new KimiAcpTranslator();
    this.currentTranslator = translator;

    // Emit turn_started before prompt
    const turnId = `turn-${Date.now()}`;
    const turnStarted = translator.produceTurnStarted(sessionId, turnId);
    this.currentTurnId = turnId;
    this.pushEvents([turnStarted]);

    // Send the prompt
    const promptParams: SessionPromptParams = {
      sessionId,
      prompt: [{ type: 'text', text: message }],
    };

    // Fire the prompt request; notifications will be buffered in the queue.
    // We process them concurrently.
    this.promptSettled = false;

    const promptPromise = client.request<SessionPromptParams, SessionPromptResult>(
      'session/prompt',
      promptParams,
      Number.POSITIVE_INFINITY, // response held for the whole turn; idle watchdog guards liveness
    );

    // Wait for prompt to settle, then push the result event.
    // Notifications are pushed concurrently by the hook handlers.
    promptPromise.then(
      (result) => {
        this.promptSettled = true;
        if (this.stopRequested) return; // already cancelled
        const resultEvent = translator.handlePromptResponse(sessionId, result);
        this.pushEvents([resultEvent]);
      },
      (err) => {
        this.promptSettled = true;
        if (this.stopRequested) {
          getLogger().warn(
            `[${this.logTag}] prompt rejected after stopRequested: ${(err as Error).message}`,
          );
          return;
        }
        const resultEvent = translator.produceErrorResult(sessionId, (err as Error).message);
        this.pushEvents([resultEvent]);
      },
    );
  }

  /**
   * R2: poll wire.jsonl until a NEW compaction record
   * (context.apply_compaction / full_compaction.complete) appears.
   *
   * The /compact prompt settles before the background compaction lands its
   * record; returning early would let the caller dispose the connection and
   * kill the background job. Timeout is WARN-only (the compact may have been
   * a no-op) — never fails the turn. Aborts early on stop/forceFinish.
   */
  private async waitForCompactionRecord(
    reader: (sessionId: string, cwd: string) => CompactionRecordLike[],
    opts: SpawnOptions,
    baselineCount: number,
  ): Promise<void> {
    const sessionId = this.activeSessionId ?? opts.sessionId ?? '';
    const deadline = Date.now() + this.compactPollTimeoutMs;
    while (Date.now() < deadline) {
      if (this.forceFinish || this.stopRequested) return;
      const records = reader.call(this.sessionReader, sessionId, opts.cwd);
      if (records.length > baselineCount) {
        getLogger().info(
          `[${this.logTag}] compaction record observed (${records.length} > baseline ${baselineCount})`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, COMPACT_POLL_INTERVAL_MS));
    }
    getLogger().warn(
      `[${this.logTag}] compaction record not observed within ${this.compactPollTimeoutMs}ms (baseline=${baselineCount}); proceeding without confirmation`,
    );
  }

  private handleNotification(method: string, params: unknown): void {
    const events = this.currentTranslator?.handleNotification(method, params) ?? [];
    this.pushEvents(events);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const events = this.currentTranslator?.handleServerRequest(id, method, params) ?? [];

    if (events.length === 0) {
      // Unhandled/unsupported server request must be explicitly responded to
      // (error = "rejected"), otherwise the server hangs waiting for a
      // response. For question elicitation (§5.4), auto-respond cancelled.
      const rpParams = params as RequestPermissionParams;
      if (
        method === ServerRequestMethod.REQUEST_PERMISSION &&
        (rpParams.isQuestion || !rpParams.toolCall)
      ) {
        this.currentClient?.respond(id, { outcome: { outcome: 'cancelled' } });
        getLogger().info(
          `[${this.logTag}] auto-responded cancelled to question elicitation requestId=${id}`,
        );
      } else {
        this.currentClient?.respondError(
          id,
          RpcErrorCode.METHOD_NOT_FOUND,
          `Unsupported server request: ${method}`,
        );
      }
      return;
    }

    for (const ev of events) {
      if (ev.type === 'approval_requested') {
        this.pendingApprovals.set(ev.requestId, {
          kind: ev.kind,
          view: ev.view,
          options: (params as RequestPermissionParams).options,
          proto: method === ServerRequestMethod.ELICITATION_CREATE ? 'elicitation' : 'permission',
        });
        getLogger().info(
          `[${this.logTag}] approval requested requestId=${ev.requestId} kind=${ev.kind}`,
        );
      }
    }
    this.pushEvents(events);
  }
}
