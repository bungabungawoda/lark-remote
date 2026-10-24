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
 *   - pi，极简风格，没有 Ask User question。
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
  cwd: string;
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
    // 协议停止通道：pi 的 cancel 是 `{type:'abort'}` 通知，已由
    // cancelCurrentTurn 实现；登记后 win32 优雅停止才有通道可用（否则一路树杀）。
    this.manager.stopper = ({ client }) => this.buildCooperativeStop(client);
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
    // 轮次代际锚点（与 BaseAcpRunner 同口径）：pi 的 shouldReuse 要求
    // sessionId 匹配，/new、/resume 切换后的首条消息会让 acquire **同步
    // dispose** 旧连接；terminator 等到进程退出后，旧 client 上残留的上一轮
    // onClose 闭包会把假错误推进新 turn 的共享队列（用户消息未发出即丢失）。
    // 旧轮迟到的 agent_settled 同理（新 turn 空转立即"成功"）。所有 hook
    // 落地前必须过 isCurrentTurn。
    const generation = this.turnGeneration;
    client.setHooks({
      onEvent: (evt) => {
        if (!this.isCurrentTurn(generation, client)) return;
        this.handleEvent(evt);
      },
      onClose: () => {
        if (!this.isCurrentTurn(generation, client)) return;
        this.failTurn('Pi RPC connection closed');
      },
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
    const response = await client.request({ type: 'prompt', message });
    if (!response.success) {
      // pi 返回 success:false（无效模型/provider 错误/忙）时立即失败，
      // 不能当成成功 ACK 继续等 agent_settled（否则最长 turn idle timeout）。
      throw new Error(
        `pi prompt failed: ${(response as { error?: string }).error ?? 'unknown error'}`,
      );
    }
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
      // 同 setupTurn：hook 带轮次代际锚点，旧连接的迟到回调不得进入本轮。
      const generation = this.turnGeneration;
      client.setHooks({
        onEvent: (evt) => {
          if (!this.isCurrentTurn(generation, client)) return;
          this.handleEvent(evt);
        },
        onClose: () => {
          if (!this.isCurrentTurn(generation, client)) return;
          this.failTurn('Pi RPC connection closed');
        },
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
      // compact 是完整的 LLM 请求（同步跑完才回响应，协议文档自述），大上下文
      // 压缩轻松超过默认 60s 请求超时——超时只会出假错误卡，压缩仍在后台完成。
      // 活性交给 turn idle 看门狗与 /stop（与 ACP 侧 turn 级请求同口径）。
      const response = await client.request({ type: 'compact' }, Number.POSITIVE_INFINITY);
      this.promptSettled = true;
      // Guard: a stop may have already ended this turn (deferred-stop during
      // compaction) — don't push a stale result into a (possibly reused) queue.
      if (this.stopRequested || !this._isRunning) return;
      this.pushEvents([translator.produceCompactResult(opts.sessionId, response)]);
    });
  }

  private handleEvent(evt: PiRpcEvent): void {
    this.pushEvents(this.currentTranslator?.handleEvent(evt) ?? []);
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
