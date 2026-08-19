/**
 * OpencodeAcpRunner: workspace-lifetime runner using opencode's ACP mode
 * (`opencode acp`, JSON-RPC over stdio). Registered as the opencode agent's
 * runner.
 *
 * Flow per run: acquire persistent connection → session/new or session/resume
 * → synthetic init → session/prompt → consume session/update notifications
 * until prompt settles → result event.
 *
 * Structurally aligned with KimiAcpRunner via the shared ConnectionBasedRunner
 * base (same notification queue + waitResolve pattern, same forceFinish/
 * stopRequested semantics, same turn idle timeout, same ConnectionLostError
 * retry). Differences from kimi:
 * - session/set_mode applies the configured mode (build/plan; default 'build'
 *   keeps manual approvals flowing); opencode sends no set_mode notification,
 *   so the client refreshes the local mode view itself
 * - no wire.jsonl compaction polling (opencode /compact is synchronous:
 *   service.ts:555-571 summarize completes before the prompt response)
 * - text/thinking go to the assistant incremental channel (opencode wire
 *   deltas), not turn_diff snapshots
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
import { OpencodeAcpTranslator, type OpencodeAcpTranslatorEvent } from './translator.js';
import {
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
  type PermissionOption,
  RpcErrorCode,
} from '../../common/acp/protocol-types.js';
import { findOptionIdByKind } from '../../common/acp/protocol-helpers.js';
import { getLogger } from '../../../logger/index.js';
import { ConnectionBasedRunner } from '../../common/connection-based-runner.js';

// =============================================================================
// Configuration
// =============================================================================

export interface OpencodeAcpRunnerOptions {
  kind: AgentKind;
  sessionReader: AgentSessionReader;
  /** Path to the opencode binary. Defaults to `opencode`. */
  binary?: string;
  /** Environment variables. */
  env?: Record<string, string | undefined>;
  /** Args to spawn the ACP server with. Defaults to `['acp']`. Note: no
   *  explicit `--cwd` — opencode acp defaults --cwd to the process cwd, which
   *  the transport already sets to the workspace (cli/cmd/acp.ts:13-17). */
  acpArgs?: string[];
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Idle TTL for connection manager. */
  idleTtlMs?: number;
  /** How long to wait for turn output before failing. Defaults to 10 min. */
  turnIdleTimeoutMs?: number;
  model?: string;
  /** Configured session mode: 'build' (default) or 'plan' (opencode agent names). */
  mode?: 'build' | 'plan';
}

/**
 * Build the ACP protocol response for a permission approval decision.
 *
 * accept            → {outcome:{outcome:'selected', optionId:<allow_once kind>}}
 * accept_for_session → {outcome:{outcome:'selected', optionId:<allow_always kind>}}
 * decline           → {outcome:{outcome:'selected', optionId:<reject kind>}}
 * cancel            → {outcome:{outcome:'cancelled'}}
 *
 * optionId is opaque and echoed back as-is (opencode permission.ts:20-24
 * offers once/always/reject with kinds allow_once/allow_always/reject_once;
 * the server maps optionId 'once'/'always' → approve, anything else →
 * reject — permission.ts:219-223). If no matching option is found, fall
 * back to cancelled (safe universal default).
 */
function buildApprovalResponse(
  action: string,
  pending: PendingApproval,
): RequestPermissionResponse {
  if (action === 'cancel') {
    return { outcome: { outcome: 'cancelled' } };
  }
  if (action === 'accept') {
    const optionId = findOptionIdByKind(pending.options, ['allow_once', 'allow_always']);
    if (optionId) {
      return { outcome: { outcome: 'selected', optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }
  if (action === 'accept_for_session') {
    // §P4: 卡片「允许本次会话」→ always 类 optionId（opencode 'always'）
    const optionId = findOptionIdByKind(pending.options, ['allow_always', 'approve_always']);
    if (optionId) {
      return { outcome: { outcome: 'selected', optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }
  // decline
  const optionId = findOptionIdByKind(pending.options, ['reject_once', 'reject']);
  if (optionId) {
    return { outcome: { outcome: 'selected', optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

interface PendingApproval {
  kind: 'command' | 'file' | 'permissions' | 'question' | 'tool';
  view: ApprovalView;
  options: PermissionOption[];
}

/** Minimal configOption shape we read back for the current session mode. */
interface SessionConfigOptionLike {
  id?: string;
  category?: string;
  currentValue?: unknown;
}

// =============================================================================
// Runner
// =============================================================================

export class OpencodeAcpRunner extends ConnectionBasedRunner<
  JsonRpcClient,
  OpencodeAcpTranslatorEvent
> {
  private connectionManager: ConnectionManager;
  private currentTranslator: OpencodeAcpTranslator | null = null;
  private activeSessionId: string | null = null;
  private model?: string;
  /** Configured session mode applied via session/set_mode (§P5). */
  private configuredMode: 'build' | 'plan';
  /** Current session mode id, parsed from session/new|resume configOptions. */
  private currentModeId?: string;
  /** Current model value (`provider/model`), parsed from configOptions. */
  private currentModelValue?: string;

  /** Pending approval requests: requestId → kind + view + options. */
  private pendingApprovals = new Map<number | string, PendingApproval>();

  /** Tracker for the in-flight prompt request — needed for cancellation. */
  private promptSettled = false;
  /** Whether the prompt request has been fired (distinguishes "stop before
   *  prompt sent" from "stop while prompt in-flight" — the latter sends
   *  session/cancel immediately). */
  private promptSent = false;

  constructor(opts: OpencodeAcpRunnerOptions) {
    super({ kind: opts.kind, sessionReader: opts.sessionReader }, opts.turnIdleTimeoutMs);
    this.model = opts.model;
    this.configuredMode = opts.mode ?? 'build';

    const managerOpts: ConnectionManagerOptions = {
      binary: opts.binary ?? 'opencode',
      args: opts.acpArgs ?? ['acp'],
      env: opts.env,
      requestTimeoutMs: opts.requestTimeoutMs,
      idleTtlMs: opts.idleTtlMs,
      // ACP handshake: declare no fs/terminal capabilities — opencode only
      // reads _meta['terminal-auth'] (service.ts:102) and gates edit-apply on
      // the client's fs capability (permission.ts:99-115), which we refuse.
      initializeParams: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
    };
    this.connectionManager = new ConnectionManager(managerOpts);
  }

  protected get logTag(): string {
    return 'opencode-acp-runner';
  }

  protected get turnTimeoutErrorMessage(): string {
    return 'opencode ACP turn timed out';
  }

  protected get turnInterruptedErrorMessage(): string {
    return 'opencode ACP turn interrupted';
  }

  protected currentSessionId(): string | null {
    return this.activeSessionId;
  }

  protected shouldDeferStop(): boolean {
    return !this.promptSent;
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
    this.promptSent = false;
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
   * opencode special-cases the `/compact` text prompt server-side
   * (service.ts:555-571): it runs session.summarize synchronously and the
   * prompt response settles only after compaction completes — no background
   * record polling needed (unlike kimi).
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    yield* this.executeTurn(opts, async () => {
      const client = await this.connectionManager.acquire(opts.cwd);
      this.connectionManager.notifyActivity(opts.cwd);
      this.currentClient = client;
      client.setHooks({
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
        onClose: () => this.failTurn('opencode ACP connection closed'),
      });

      const sessionId = opts.sessionId;
      if (!sessionId) {
        throw new Error('compact requires a sessionId');
      }
      this.activeSessionId = sessionId;

      // Cold-connection fallback: session/resume loads the session into
      // memory. On a reused connection the session is already loaded —
      // resume is idempotent and harmless.
      const resumeParams: SessionResumeParams = { sessionId, cwd: opts.cwd };
      const resumeResult = await client.request<SessionResumeParams, SessionResumeResult>(
        'session/resume',
        resumeParams,
      );
      this.trackConfigOptions(resumeResult as { configOptions?: unknown });

      const translator = new OpencodeAcpTranslator();
      translator.setOperationKind('compact');
      this.currentTranslator = translator;

      // Emit turn_started with operationKind='compaction' before the prompt.
      const turnId = `compact-${Date.now()}`;
      const turnStarted = translator.produceTurnStarted(sessionId, turnId);
      this.currentTurnId = turnId;
      this.pushEvents([turnStarted]);

      // Send /compact as prompt text (opencode intercepts it server-side).
      const promptParams: SessionPromptParams = {
        sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      };

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
    const acpResponse = buildApprovalResponse(action, pending);
    client.respond(requestId, acpResponse);
    this.pendingApprovals.delete(requestId);
    getLogger().info(`[${this.logTag}] approval responded requestId=${requestId} action=${action}`);
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: this.kind,
      model: this.model ?? '(opencode-acp)',
      extras: {
        mode: 'acp',
        ...(this.currentModeId ? { sessionMode: this.currentModeId } : {}),
      },
    };
  }

  /**
   * Hot-apply a mode change to the live ACP session (§P5).
   *
   * opencode's session/set_mode sends no notification — the client refreshes
   * the local mode view itself. The local mode is always updated so
   * `getStatusInfo()` (and therefore `/s`) reflects the new value
   * immediately; when a session is connected, also re-sends session/set_mode
   * so the running session picks up the new mode without waiting for the
   * runner to be evicted/recreated. Failure is non-fatal: the next setupTurn
   * re-applies the cached mode when it differs from the session's current
   * mode.
   */
  async updateApprovalMode(settings: { mode?: 'build' | 'plan' }): Promise<void> {
    if (settings.mode !== undefined) {
      this.configuredMode = settings.mode;
      this.currentModeId = settings.mode;
    }
    if (!this.currentClient || !this.activeSessionId) return;

    const modeParams: SessionSetModeParams = {
      sessionId: this.activeSessionId,
      modeId: this.configuredMode,
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
   * → session/prompt.
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
        this.failTurn('opencode ACP connection closed');
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
      this.trackConfigOptions(resumeResult as { configOptions?: unknown });
      sessionId = opts.sessionId;
    } else {
      const newParams: SessionNewParams = { cwd: opts.cwd, mcpServers: [] };
      const newResult = await client.request<SessionNewParams, SessionNewResult>(
        'session/new',
        newParams,
      );
      this.trackConfigOptions(newResult as { configOptions?: unknown });
      sessionId = newResult.sessionId;
    }
    this.activeSessionId = sessionId;

    // §P5: apply the configured mode (build/plan). If the session already
    // runs it (from session/new|resume configOptions), skip the wire call;
    // otherwise send session/set_mode and refresh the local view (opencode
    // sends no notification for set_mode).
    if (this.currentModeId !== this.configuredMode) {
      const modeParams: SessionSetModeParams = {
        sessionId,
        modeId: this.configuredMode,
      };
      try {
        await client.request('session/set_mode', modeParams);
        this.currentModeId = this.configuredMode;
      } catch (err) {
        getLogger().warn(
          `[${this.logTag}] session/set_mode failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }

    // Apply the configured model (`provider/model`) via set_config_option.
    // Without this the session runs opencode's own default model (e.g.
    // opencode/big-pickle), which may be unusable — 2026-08-17 live smoke:
    // default zen model left session/prompt hanging with no response.
    // Non-fatal on failure (unknown model → server InvalidModelError).
    if (this.model && this.currentModelValue !== this.model) {
      try {
        await client.request('session/set_config_option', {
          sessionId,
          configId: 'model',
          value: this.model,
        });
        this.currentModelValue = this.model;
      } catch (err) {
        getLogger().warn(
          `[${this.logTag}] set_config_option model failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }

    const translator = new OpencodeAcpTranslator();
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
   * Track the current session mode and model from a session/new|resume
   * result's configOptions (opencode buildModeSelectOption/buildModelSelectOption:
   * {id, category, currentValue}).
   */
  private trackConfigOptions(result: { configOptions?: unknown }): void {
    const options = result.configOptions;
    if (!Array.isArray(options)) return;
    const mode = (options as SessionConfigOptionLike[]).find(
      (opt) => opt?.category === 'mode' || opt?.id === 'mode',
    );
    if (typeof mode?.currentValue === 'string') {
      this.currentModeId = mode.currentValue;
    }
    const model = (options as SessionConfigOptionLike[]).find(
      (opt) => opt?.category === 'model' || opt?.id === 'model',
    );
    if (typeof model?.currentValue === 'string') {
      this.currentModelValue = model.currentValue;
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const events = this.currentTranslator?.handleNotification(method, params) ?? [];
    this.pushEvents(events);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const events = this.currentTranslator?.handleServerRequest(id, method, params) ?? [];

    if (events.length === 0) {
      // Unhandled/unsupported server requests must be explicitly responded
      // to (error = "rejected"), otherwise the server hangs waiting.
      // This includes fs/write_text_file: we do NOT declare the fs
      // capability, and if opencode still calls it (edit approved →
      // writeProposedEdit), we refuse with method-not-found — the server
      // side tolerates the error (permission.ts writeProposedEdit catches).
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

    for (const ev of events) {
      if (ev.type === 'approval_requested') {
        this.pendingApprovals.set(ev.requestId, {
          kind: ev.kind,
          view: ev.view,
          options: (params as RequestPermissionParams).options,
        });
        getLogger().info(
          `[${this.logTag}] approval requested requestId=${ev.requestId} kind=${ev.kind}`,
        );
      }
    }
    this.pushEvents(events);
  }
}
