/**
 * PiRpcRunner: workspace-lifetime runner driving pi in `--mode rpc`
 * (JSON-lines protocol over stdio).
 *
 * Flow per run: acquire persistent connection → resolve session id (via
 * `get_state`, or the spawn-bound `--session-id`) → synthetic init → send
 * `prompt` (fire-and-ack) → consume pi events until `agent_settled` → result.
 *
 * Compact flow: acquire → `compact` command → consume `compaction_*` events →
 * result from the compact response (completion signal).
 *
 * Structurally aligned with KimiAcpRunner / OpencodeAcpRunner via the shared
 * ConnectionBasedRunner base (notification queue, forceFinish/stopRequested,
 * turn idle watchdog, connection-lost retry). Differences:
 *   - pi binds the session at spawn via `--session-id` (no RPC resume-by-id);
 *     the PiRpcConnectionManager respawns when the requested session changes.
 *   - no approval server-requests (pi RPC exposes none in this scope) →
 *     respondApproval is a no-op.
 *   - `prompt` ack ≠ turn completion; the turn ends on `agent_settled`.
 */

import type { AgentSessionReader, AgentEvent, AgentStatusInfo, SpawnOptions } from '../../types.js';
import { ConnectionBasedRunner } from '../../common/connection-based-runner.js';
import { ConnectionManager } from '../../common/jsonrpc/connection-manager.js';
import { getLogger } from '../../../logger/index.js';
import { PiRpcClient } from './client.js';
import { PiRpcTranslator, type PiRpcTranslatorEvent } from './translator.js';
import type { PiRpcEvent } from './protocol-types.js';

export interface PiRpcRunnerOptions {
  /** LLM provider, e.g. 'Volcano'. */
  provider?: string;
  /** Model id or alias, e.g. 'glm-5.2'. */
  model?: string;
  /** Thinking level: off/minimal/low/medium/high/xhigh/max. */
  thinking?: string;
  /** Tool allowlist. */
  tools?: string[];
  workspace: string;
  sessionReader: AgentSessionReader;
  /** Path to the pi binary. Defaults to `pi`. */
  binary?: string;
  /** Environment variables to pass to the pi process. */
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  idleTtlMs?: number;
  turnIdleTimeoutMs?: number;
}

export class PiRpcRunner extends ConnectionBasedRunner<PiRpcClient, PiRpcTranslatorEvent> {
  private readonly manager: ConnectionManager<PiRpcClient>;
  private currentTranslator: PiRpcTranslator | null = null;
  private activeSessionId: string | null = null;
  private promptSettled = false;
  private readonly defaultModel: string;
  private readonly provider: string;
  private readonly thinking: string;

  constructor(opts: PiRpcRunnerOptions) {
    super({
      kind: 'pi',
      sessionReader: opts.sessionReader,
      turnIdleTimeoutMs: opts.turnIdleTimeoutMs,
    });
    this.defaultModel = opts.model ?? 'glm-5.2';
    this.provider = opts.provider ?? 'Volcano';
    this.thinking = opts.thinking ?? 'medium';
    const tools = (opts.tools ?? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']).join(',');
    this.manager = new ConnectionManager<PiRpcClient>({
      binary: opts.binary ?? 'pi',
      buildArgs: (req) =>
        buildPiArgs(this.provider, this.defaultModel, this.thinking, tools, req.sessionId),
      clientFactory: ({ transport, baseOnClose, requestTimeoutMs }) =>
        new PiRpcClient(transport, baseOnClose, requestTimeoutMs),
      shouldReuse: ({ client, req, boundSessionId }) =>
        req.sessionId !== undefined &&
        boundSessionId === req.sessionId &&
        client.ready &&
        client.healthy,
      env: opts.env,
      requestTimeoutMs: opts.requestTimeoutMs,
      idleTtlMs: opts.idleTtlMs,
      logTag: 'pi-rpc-connection-manager',
    });
  }

  protected get logTag(): string {
    return 'pi-rpc-runner';
  }

  protected get turnTimeoutErrorMessage(): string {
    return 'Pi RPC turn timed out';
  }

  protected get turnInterruptedErrorMessage(): string {
    return 'Pi RPC turn interrupted';
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
      this.currentClient.notify({ type: 'abort' });
    } catch (err) {
      getLogger().warn(`[${this.logTag}] abort failed: ${(err as Error).message}`);
    }
  }

  protected clearTurnState(): void {
    this.currentTranslator = null;
    this.promptSettled = false;
    this.activeSessionId = null;
  }

  protected async releaseConnection(cwd: string): Promise<void> {
    await this.manager.release(cwd);
  }

  protected notifyIdle(cwd: string): void {
    this.manager.notifyIdle(cwd);
  }

  protected async disposeConnections(): Promise<void> {
    await this.manager.disposeAll();
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: 'pi',
      model: this.defaultModel,
      provider: this.provider,
      reasoning: this.thinking,
      extras: { mode: 'rpc' },
    };
  }

  /**
   * Normal turn: acquire → resolve session id → prompt (fire-and-ack) → the
   * `agent_settled` event produces the result.
   */
  protected async setupTurn(message: string, opts: SpawnOptions): Promise<void> {
    const client = await this.manager.acquire(opts.cwd, { sessionId: opts.sessionId });
    this.manager.notifyActivity(opts.cwd);
    this.currentClient = client;
    client.setHooks({
      onEvent: (evt) => this.handleEvent(evt),
      onClose: () => this.failTurn('Pi RPC connection closed'),
    });

    let sessionId = opts.sessionId;
    if (!sessionId) {
      const state = await client.request({ type: 'get_state' });
      if (state.success && state.data) {
        sessionId = (state.data as { sessionId?: string }).sessionId;
      }
      if (!sessionId) throw new Error('pi RPC did not report a session id');
      // Bind the discovered id so a following run resumes the SAME session on
      // this live connection instead of respawning it.
      this.manager.bindSession(opts.cwd, sessionId);
    }
    this.activeSessionId = sessionId;

    const translator = new PiRpcTranslator();
    translator.setSessionId(sessionId);
    this.currentTranslator = translator;

    const turnId = `turn-${Date.now()}`;
    this.currentTurnId = turnId;
    this.pushEvents([translator.produceTurnStarted(sessionId, turnId)]);

    this.promptSettled = false;
    await client.request({ type: 'prompt', message });
    this.promptSettled = true;
  }

  /**
   * Compact the current session. The `compact` command returns a response at
   * completion (the completion signal); `compaction_*` events stream meanwhile.
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    yield* this.executeTurn(opts, async () => {
      if (!opts.sessionId) {
        throw new Error('compact requires a sessionId');
      }
      const client = await this.manager.acquire(opts.cwd, { sessionId: opts.sessionId });
      this.manager.notifyActivity(opts.cwd);
      this.currentClient = client;
      client.setHooks({
        onEvent: (evt) => this.handleEvent(evt),
        onClose: () => this.failTurn('Pi RPC connection closed'),
      });

      this.activeSessionId = opts.sessionId;

      const translator = new PiRpcTranslator();
      translator.setSessionId(opts.sessionId);
      translator.setOperationKind('compact');
      this.currentTranslator = translator;

      const turnId = `compact-${Date.now()}`;
      this.currentTurnId = turnId;
      this.pushEvents([translator.produceTurnStarted(opts.sessionId, turnId)]);

      this.promptSettled = false;
      const response = await client.request({ type: 'compact' });
      this.promptSettled = true;
      // Guard: a stop may have already ended this turn (deferred-stop during
      // compaction) — don't push a stale result into a (possibly reused) queue.
      if (this.stopRequested || !this._isRunning) return;
      this.pushEvents([translator.produceCompactResult(opts.sessionId, response)]);
    });
  }

  /**
   * Approvals are out of scope for pi RPC (no server requests surface in this
   * integration); the bridge's duck-typed respondApproval call is a no-op.
   */
  async respondApproval(_requestId: number | string, _response: unknown): Promise<void> {
    // no-op
  }

  private handleEvent(evt: PiRpcEvent): void {
    const events = this.currentTranslator?.handleEvent(evt) ?? [];
    this.pushEvents(events);
  }
}

/** Build pi `--mode rpc` spawn args. `sessionId` is bound at spawn (pi has no
 *  RPC resume-by-id command); omitting it spawns a brand-new session. */
function buildPiArgs(
  provider: string,
  model: string,
  thinking: string,
  tools: string,
  sessionId?: string,
): string[] {
  const args = ['--mode', 'rpc', '--provider', provider, '--model', model];
  if (thinking && thinking !== 'off') args.push('--thinking', thinking);
  if (tools) args.push('--tools', tools);
  if (sessionId) args.push('--session-id', sessionId);
  return args;
}
