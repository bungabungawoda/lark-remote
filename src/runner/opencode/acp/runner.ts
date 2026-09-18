/**
 * OpencodeAcpRunner: workspace-lifetime runner using opencode's ACP mode
 * (`opencode acp`, JSON-RPC over stdio). Registered as the opencode agent's
 * runner.
 *
 * Flow per run: acquire persistent connection → session/new or session/resume
 * → synthetic init → session/prompt → consume session/update notifications
 * until prompt settles → result event.
 *
 * Turn/connection/compact/approval orchestration lives in BaseAcpRunner;
 * opencode-specific parts:
 * - session/set_mode applies the configured mode (build/plan; default 'build'
 *   keeps manual approvals flowing); opencode sends no set_mode notification,
 *   so the client refreshes the local mode view itself
 * - no wire.jsonl compaction polling (opencode /compact is synchronous:
 *   service.ts:555-571 summarize completes before the prompt response)
 * - text/thinking go to the assistant incremental channel (opencode wire
 *   deltas), not turn_diff snapshots
 * - OpencodeLogErrorMonitor tails opencode's own log for LLM stream errors
 *   the ACP protocol never forwards
 */

import type { AgentKind, AgentSessionReader, AgentStatusInfo } from '../../types.js';
import {
  ConnectionManager,
  type ConnectionManagerOptions,
} from '../../common/jsonrpc/connection-manager.js';
import { JsonRpcClient } from '../../common/jsonrpc/client.js';
import { OpencodeAcpTranslator } from './translator.js';
import {
  type SessionNewResult,
  type SessionResumeResult,
  type SessionPromptResult,
  type SessionSetModeParams,
  type RequestPermissionParams,
  RpcErrorCode,
} from '../../common/acp/protocol-types.js';
import {
  OPENCODE_APPROVAL_KINDS,
  type AcpPendingApproval,
  buildAcpPermissionOutcome,
} from '../../common/acp/protocol-helpers.js';
import { getLogger } from '../../../logger/index.js';
import { BaseAcpRunner, type AcpTranslatorEvent } from '../../common/acp/base-acp-runner.js';
import { OpencodeLogErrorMonitor, resolveOpencodeLogPath } from './error-monitor.js';

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
  /** How long to wait for turn output before failing. Defaults to 30 min. */
  turnIdleTimeoutMs?: number;
  model?: string;
  /** Configured session mode: 'build' (default) or 'plan' (opencode agent names). */
  mode?: 'build' | 'plan';
  /** Path to opencode's own log file (default: resolveOpencodeLogPath()). */
  errorMonitorLogPath?: string;
  /** Tail poll interval for the opencode log error monitor. Defaults to 2000ms. */
  errorMonitorPollIntervalMs?: number;
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

export class OpencodeAcpRunner extends BaseAcpRunner<OpencodeAcpTranslator> {
  /** Configured session mode applied via session/set_mode (§P5). */
  private configuredMode: 'build' | 'plan';
  /** Current session mode id, parsed from session/new|resume configOptions. */
  private currentModeId?: string;
  /** Current model value (`provider/model`), parsed from configOptions. */
  private currentModelValue?: string;
  /** Tails opencode's own log to surface LLM stream errors the ACP protocol
   *  never forwards (quota/limit errors back off for ~1h → turn would hang). */
  private readonly errorMonitor: OpencodeLogErrorMonitor;

  constructor(opts: OpencodeAcpRunnerOptions) {
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
    super(
      {
        kind: opts.kind,
        sessionReader: opts.sessionReader,
        turnIdleTimeoutMs: opts.turnIdleTimeoutMs,
      },
      new ConnectionManager(managerOpts),
    );
    this.model = opts.model;
    this.configuredMode = opts.mode ?? 'build';
    this.errorMonitor = new OpencodeLogErrorMonitor({
      logPath: opts.errorMonitorLogPath ?? resolveOpencodeLogPath(),
      pollIntervalMs: opts.errorMonitorPollIntervalMs,
    });
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

  protected get connectionClosedMessage(): string {
    return 'opencode ACP connection closed';
  }

  protected shouldDeferStop(): boolean {
    return !this.promptSent;
  }

  /**
   * Start watching opencode's own log for LLM stream errors of the active
   * session. opencode ACP does not surface retry/error state to the client
   * (no error/status notification type, session/list has no status field), so
   * the log is the only channel that carries the real provider error. Without
   * this, a quota error (e.g. opencode-go weekly limit) leaves session/prompt
   * pending for the full retry-after backoff (~1h) and the Feishu card hangs
   * until the idle watchdog.
   */
  private startErrorMonitor(sessionId: string): void {
    this.errorMonitor.start(sessionId, (message) => {
      getLogger().warn(
        `[${this.logTag}] opencode stream error detected (log), failing turn: ${message}`,
      );
      this.failTurn(`opencode LLM stream error: ${message}`);
    });
  }

  protected createTranslator(): OpencodeAcpTranslator {
    return new OpencodeAcpTranslator();
  }

  protected async applyTurnSettings(client: JsonRpcClient, sessionId: string): Promise<void> {
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
  }

  /**
   * opencode /compact is synchronous server-side — standard prompt-settle
   * translation (no wire.jsonl polling, unlike kimi).
   */
  protected onCompactPromptFired(
    promptPromise: Promise<SessionPromptResult>,
    translator: OpencodeAcpTranslator,
    sessionId: string,
    _opts: unknown,
    _baselineTotalCount: number,
  ): void {
    promptPromise.then(
      (result) => this.handlePromptResolved(result, translator, sessionId),
      (err) => this.handlePromptRejected(err, translator, sessionId, 'compact'),
    );
  }

  protected buildApprovalOutcome(
    action: string,
    pending: AcpPendingApproval,
    _response: unknown,
  ): unknown {
    return buildAcpPermissionOutcome(action, pending.options, OPENCODE_APPROVAL_KINDS);
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
    await this.sendApprovalModeUpdate(this.configuredMode);
  }

  // =========================================================================
  // Internal
  // =========================================================================

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

  protected override onTurnSessionReady(sessionId: string): void {
    this.startErrorMonitor(sessionId);
  }

  protected override onSessionEstablished(result: SessionResumeResult | SessionNewResult): void {
    this.trackConfigOptions(result as { configOptions?: unknown });
  }

  protected override onClearTurnState(): void {
    this.errorMonitor.stop();
  }

  protected override handleNotification(method: string, params: unknown): void {
    const events = this.currentTranslator?.handleNotification(method, params) ?? [];
    this.pushEvents(events);
  }

  protected override handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    const events: AcpTranslatorEvent[] =
      this.currentTranslator?.handleServerRequest(id, method, params) ?? [];

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

    this.registerApprovalEvents(events, (params as RequestPermissionParams).options);
    this.pushEvents(events);
  }
}
