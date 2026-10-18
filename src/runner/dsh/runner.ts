/**
 * DshRunner — workspace-lifetime runner bridging to the DSH Web Host
 * (DeepSeek Harness) over plain HTTP. No local subprocess is spawned.
 *
 * Flow per run: session/create(cwd) (when no sessionId) → model/permission
 * alignment → synthetic system/init (DSH has no init event) → session/prompt
 * (mode:'queue') → consume `session/follow` + `$events` until turn/end.
 *
 * stop() → session/cancel + abort the mux subscription. killOrphan /
 * registerExitHandlers are no-ops (no local process). DSH approvals are
 * two-channel: durable `approval/asked` / `approval/decided` drive the Feishu
 * card, while the answerable `$events` waterfall supplies eventId/clientId.
 * If `$events` is unavailable, the runner falls back to the Web UI prompt.
 */

import type {
  AgentEvent,
  AgentSessionReader,
  AgentStatusInfo,
  ApprovalView,
  SpawnOptions,
} from '../types.js';
import type { AgentRunner } from '../types.js';
import { DshClient, DshError, newPromptRequestId, type WebSocketFactory } from './client.js';
import { DshTranslator } from './translator.js';
import { DshApprovalTracker, type DshApprovalAudit, type DshApprovalBinding } from './approval.js';
import { mergeAsync } from './merge.js';
import { getLogger } from '../../logger/index.js';
import type { DshDaemon } from './daemon.js';
import type {
  DshApprovalStreamItem,
  DshModelSelection,
  DshSessionEvent,
  DshStreamItem,
} from './types.js';

/**
 * Legacy provider for configs written before `agents.dsh.provider` existed.
 * New configs pin the provider explicitly; the card reads the live catalog.
 */
const DSH_MODEL_PROVIDER = 'deepseek-official';

/** DSH 内建手动压缩命令（dsh-command-compact，无参数、仅空闲可执行）。 */
const DSH_COMPACT_COMMAND = '/compact';

export interface DshRunnerOptions {
  kind: 'dsh';
  sessionReader: AgentSessionReader;
  /** Global DSH process manager; omitted in tests that drive a fake server. */
  daemon?: DshDaemon;
  /** DSH Web Host base URL, e.g. http://127.0.0.1:3080. */
  host?: string;
  /** Configured DSH home; selects `.credentials.yaml` when credentialsFile is unset. */
  dshHome?: string;
  /** Optional `dsh web` launch token (or its startup URL). */
  token?: string;
  /** DSH credentials file with the durable browser-session signing secret. */
  credentialsFile?: string;
  /** Session preset（agentPreset）固定于 session 创建时；undefined = 服务端默认。 */
  agentPreset?: string;
  /** 权限预设（沙箱 + 审批策略）；undefined = 不干预。 */
  permissionPreset?: string;
  /** Provider route id (e.g. deepseek-official / anthropic); undefined = legacy default. */
  provider?: string;
  /** Display model name. */
  model?: string;
  /** 推理强度（off/low/high/max）；undefined = 服务端默认。 */
  reasoningEffort?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable WebSocket factory (defaults to global WebSocket). */
  webSocketImpl?: WebSocketFactory;
  /** Unary request timeout in ms (default 60s); 0 disables. */
  requestTimeoutMs?: number;
}

/** Budget for the fire-and-forget session/cancel on stop (never block /stop). */
const CANCEL_TIMEOUT_MS = 5_000;

/** Parse tool-call arguments without letting malformed JSON crash the run. */
function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class DshRunner implements AgentRunner {
  readonly kind = 'dsh' as const;
  /**
   * Session identity lives in the DSH Web Host (server-side), not in a local
   * process, so a finished run is still addressable — the same property the
   * bridge uses before recording a run as compactable. Without it the Compact
   * button renders (capability is declared) but every click answers
   * 「该任务已结束或不属于当前会话」.
   */
  readonly lifetime = 'workspace' as const;
  readonly sessionReader: AgentSessionReader;
  readonly client: DshClient;
  /** 用户配置的模型 ID（run 前 selectModel 对齐用）；undefined = 服务端默认。 */
  private readonly configuredModel: string | undefined;
  /** 用户配置的 provider route；undefined = 兼容旧配置，按 deepseek-official 处理。 */
  private readonly configuredProvider: string | undefined;
  private readonly agentPreset: string | undefined;
  private configuredPermissionPreset: string | undefined;
  private readonly reasoningEffort: string | undefined;

  private activeAbort: AbortController | null = null;
  private activeSessionId: string | null = null;
  private running = false;
  private readonly daemon: DshDaemon | undefined;
  /**
   * 已对齐模型的 session 集合：同一 session 二次 run 不再重发 selectModel
   * （session/selectModel 会写服务端全局默认，每次 run 都写是写放大）。
   * configuredModel / configuredProvider 在实例生命周期内不变（/config 改动
   * 会 clearRunners 重建实例），故「每 session 对齐一次」足以覆盖配置变化。
   */
  private readonly alignedSessions = new Set<string>();
  /** 已对齐权限预设的 session；同一 session 只执行一次 `/permission`。 */
  private readonly permissionAlignedSessions = new Set<string>();
  /** `$events` approval waterfall state for the current run. */
  private readonly approvalTracker = new DshApprovalTracker();
  /** callId → tool call, used to render the command in the approval card. */
  private readonly toolCalls = new Map<
    string,
    { name: string; arguments: string; turn?: number }
  >();
  /** False after `$events` is unavailable; approval/asked then falls back to text. */
  private approvalChannelAvailable = true;

  constructor(opts: DshRunnerOptions) {
    this.sessionReader = opts.sessionReader;
    this.daemon = opts.daemon;
    this.configuredModel = opts.model;
    this.configuredProvider = opts.provider;
    this.agentPreset = opts.agentPreset;
    this.configuredPermissionPreset = opts.permissionPreset;
    this.reasoningEffort = opts.reasoningEffort;
    this.client = new DshClient(opts.host ?? 'http://127.0.0.1:3080', {
      dshHome: opts.dshHome,
      token: opts.token,
      credentialsFile: opts.credentialsFile,
      fetchImpl: opts.fetchImpl,
      webSocketImpl: opts.webSocketImpl,
      requestTimeoutMs: opts.requestTimeoutMs,
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  getStatusInfo(): AgentStatusInfo {
    const extras: Record<string, string> = { host: this.client.baseUrl };
    if (this.agentPreset) extras.preset = this.agentPreset;
    if (this.configuredPermissionPreset) {
      extras.permissionPreset = this.configuredPermissionPreset;
    }
    if (this.reasoningEffort) extras.reasoning = this.reasoningEffort;
    return {
      kind: this.kind,
      model: this.configuredModel ?? 'DSH',
      provider: this.configuredProvider ?? DSH_MODEL_PROVIDER,
      extras,
    };
  }

  /**
   * Resolve the configured provider/model pair.
   *
   * A model-only config keeps the legacy `deepseek-official` route, so
   * existing configs behave exactly as before. A provider-only config asks
   * the live catalog for that provider's default (or first) model.
   */
  private async resolveModelSelection(signal: AbortSignal): Promise<DshModelSelection> {
    const provider = this.configuredProvider ?? DSH_MODEL_PROVIDER;
    if (this.configuredModel) {
      return {
        provider,
        model: this.configuredModel,
        ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
      };
    }

    const catalog = await this.client.listModels({ signal });
    const group = catalog.groups.find((entry) => entry.id === provider);
    if (!group || group.models.length === 0) {
      throw new Error(`Provider "${provider}" 在 DSH 模型目录中不可用（没有可用模型）`);
    }

    const defaultModel = catalog.default?.provider === provider ? catalog.default.model : undefined;
    const model =
      defaultModel && group.models.some((entry) => entry.id === defaultModel)
        ? defaultModel
        : group.models[0]!.id;
    const entry = group.models.find((candidate) => candidate.id === model);
    const efforts = entry?.reasoning?.efforts.map((effort) => effort.id) ?? [];

    let reasoningEffort: string | undefined;
    if (this.reasoningEffort) {
      if (efforts.length === 0 || efforts.includes(this.reasoningEffort)) {
        reasoningEffort = this.reasoningEffort;
      } else {
        getLogger().warn(
          `[dsh] reasoningEffort "${this.reasoningEffort}" 不被 ${provider}/${model} 支持，改用模型默认档位`,
        );
      }
    }

    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }

  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (this.running) {
      throw new Error('DshRunner is already running');
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    this.running = true;

    let sessionId = opts.sessionId;
    let terminalEmitted = false;
    try {
      // DSH is a shared, machine-wide process. Reuse it when it is already
      // listening; otherwise start it detached so lark-remote exiting does not
      // stop it for every other instance.
      if (this.daemon) await this.daemon.ensure();

      // session/create 必须包进同一 try/finally，否则创建失败（服务端不可达/报错）
      // 会在进入旧 try 之前抛异常，finally 不执行 → running 恒 true、activeAbort 残留。
      if (!sessionId) {
        const createPromise = this.client.createSession({
          cwd: opts.cwd,
          ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}),
        });
        // 不把 run 的 abort signal 直接交给 create：abort 掉请求会丢掉刚创建
        // 的 sessionId，服务端若已完成创建就留下一个无法 cancel 的孤儿 session。
        // 改为 abort 时立即放行 run（队列不被挂起），create 后台落定后再补 cancel。
        const created = await this.awaitOrAbort(createPromise, abort.signal);
        if (!created) {
          void createPromise.then(
            (c) => this.cancelSessionQuietly(c.sessionId),
            () => {
              /* create failed after stop — nothing to cancel */
            },
          );
          getLogger().info('[dsh] run stopped during session/create; will cancel if it settles');
          terminalEmitted = true;
          yield {
            type: 'result',
            subtype: 'interrupted',
            session_id: '',
            errorMessage: 'run stopped',
          };
          return;
        }
        sessionId = created.sessionId;
      }
      this.activeSessionId = sessionId;

      // Startup abort：createSession 挂起期间 stop() 已 abort（此时 sessionId 尚
      // 未知，stop() 无法 cancel）。createSession 返回后立即检查——已 abort 则
      // cancel 这个刚建的 session 并中断，不让启动流程继续（selectModel/prompt）。
      // 必须 yield interrupted result（不能裸 return）：调用方依赖 result 收尾
      // run 卡，否则 for-await 自然结束后无终态、卡片停留「运行中」。
      if (abort.signal.aborted) {
        await this.cancelSessionQuietly(sessionId);
        getLogger().info(`[dsh] run aborted during startup, cancelled session ${sessionId}`);
        terminalEmitted = true;
        yield {
          type: 'result',
          subtype: 'interrupted',
          session_id: sessionId,
          errorMessage: 'run stopped',
        };
        return;
      }

      // provider/模型/推理强度对齐：会话首次 run 时 selectModel 一次
      // （该调用同时写服务端全局默认，故不重复写）；同一 session 后续 run
      // 跳过。显式配置 provider 时失败必须 fail closed：静默回退到其他
      // provider 会让用户以为切换成功，实际模型与账单都错。
      if (
        (this.configuredModel || this.configuredProvider) &&
        !this.alignedSessions.has(sessionId)
      ) {
        try {
          const selection = await this.resolveModelSelection(abort.signal);
          await this.client.selectModel({ sessionId, ...selection }, { signal: abort.signal });
          this.alignedSessions.add(sessionId);
        } catch (err) {
          if (abort.signal.aborted) {
            getLogger().info(`[dsh] run stopped during selectModel session=${sessionId}`);
            terminalEmitted = true;
            yield {
              type: 'result',
              subtype: 'interrupted',
              session_id: sessionId,
              errorMessage: 'run stopped',
            };
            return;
          }
          if (this.configuredProvider) {
            throw new Error(
              `Provider "${this.configuredProvider}" 的模型对齐失败：${(err as Error).message}。` +
                '请在 DSH Web UI → 设置 → Models 检查该 Provider 的凭据与模型目录',
              { cause: err },
            );
          }
          getLogger().warn(
            `[dsh] selectModel failed for session ${sessionId} (run continues): ${(err as Error).message}`,
          );
        }
      }

      // 权限预设对齐：与模型对齐同语义，同一 session 只执行一次
      // `/permission <preset>`。失败必须 fail closed——用户明确选了安全策略，
      // 不能在错误的权限下继续跑 prompt。
      await this.alignPermissionPreset(sessionId, abort.signal);

      // Abort 可能在上述 unary 完成与检查之间到达：不进入 prompt/turn。
      if (abort.signal.aborted) {
        terminalEmitted = true;
        yield {
          type: 'result',
          subtype: 'interrupted',
          session_id: sessionId,
          errorMessage: 'run stopped',
        };
        return;
      }

      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        cwd: opts.cwd,
        model: this.configuredModel ?? 'DSH',
      };

      try {
        // Snapshot the pre-prompt high-water mark before mutating the session.
        // DSH session/page returns the whole session, so starting from seq 0
        // would replay the first completed turn on every follow-up prompt.
        const prePromptSeq = await this.client.latestEventSeq(sessionId, {
          signal: abort.signal,
        });

        await this.client.unary(
          'session/prompt',
          {
            requestId: newPromptRequestId(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: message }],
          },
          { signal: abort.signal },
        );

        if (abort.signal.aborted) {
          // stop() 在 prompt 已受理后到达：cancel 由 stop() 发出，这里直接收尾，
          // 不再打开 mux（否则会看到 cancel 产生的 turn/end 事件）。
          terminalEmitted = true;
          yield {
            type: 'result',
            subtype: 'interrupted',
            session_id: sessionId,
            errorMessage: 'run stopped',
          };
          return;
        }

        try {
          for await (const ev of this.runTurn(sessionId, opts.cwd, prePromptSeq, abort)) {
            yield ev;
            if (ev.type === 'result') {
              terminalEmitted = true;
              return;
            }
          }
        } catch (err) {
          if (abort.signal.aborted) throw err;
          getLogger().error(`[dsh] run consume error: ${(err as Error).message}`);
          yield {
            type: 'result',
            subtype: 'error',
            session_id: sessionId,
            errorMessage: `DSH stream error: ${(err as Error).message}`,
          };
          terminalEmitted = true;
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          yield {
            type: 'result',
            subtype: 'error',
            session_id: sessionId,
            errorMessage: `DSH run failed: ${(err as Error).message}`,
          };
          terminalEmitted = true;
        }
      }
    } catch (err) {
      // createSession 等启动期失败也产出 error result（而非抛异常），
      // 由本 catch 统一转 error result；state 清理在 finally。
      if (!abort.signal.aborted) {
        getLogger().error(
          `[dsh] run startup failed session=${sessionId ?? '(none)'}: ${(err as Error).message}`,
        );
        yield {
          type: 'result',
          subtype: 'error',
          session_id: sessionId ?? '',
          errorMessage: `DSH run failed: ${(err as Error).message}`,
        };
        terminalEmitted = true;
      }
    } finally {
      this.running = false;
      this.activeSessionId = null;
      this.activeAbort = null;
    }

    if (!terminalEmitted) {
      yield {
        type: 'result',
        subtype: abort.signal.aborted ? 'interrupted' : 'error',
        session_id: sessionId ?? '',
        errorMessage: abort.signal.aborted ? 'run stopped' : 'turn ended without a terminal event',
      };
    }
  }

  /**
   * Consume one turn from both transports. `session/follow` owns transcript
   * events; `$events` owns the answerable approval waterfall. The merged
   * stream keeps either transport from starving the other.
   */
  private async *runTurn(
    sessionId: string,
    cwd: string,
    prePromptSeq: number,
    abort: AbortController,
  ): AsyncGenerator<AgentEvent> {
    const streamAbort = new AbortController();
    const signal = AbortSignal.any([abort.signal, streamAbort.signal]);
    const translator = new DshTranslator();
    const emittedApprovals = new Set<string>();
    this.approvalTracker.clear();
    this.toolCalls.clear();
    this.approvalChannelAvailable = true;

    try {
      const sources = [
        this.client.sessionEvents(sessionId, signal, prePromptSeq),
        this.client.approvalEvents(sessionId, signal),
      ];
      for await (const item of mergeAsync<DshStreamItem | DshApprovalStreamItem>(sources)) {
        if (abort.signal.aborted) return;

        if (item.kind === 'ready') {
          this.approvalChannelAvailable = true;
          continue;
        }
        if (item.kind === 'unavailable') {
          this.approvalChannelAvailable = false;
          getLogger().warn(`[dsh] approval channel unavailable: ${item.message}`);
          continue;
        }
        if (item.kind === 'request') {
          this.approvalTracker.onWaterfall({
            eventId: item.eventId,
            clientId: item.clientId,
            ...(item.callId ? { callId: item.callId } : {}),
            toolName: item.toolName,
            ...(item.reason ? { reason: item.reason } : {}),
          });
          continue;
        }
        if (item.kind === 'cancelled') {
          const binding = this.approvalTracker.onCancelled(item.eventId);
          if (binding) yield this.approvalResolved(binding.audit.approvalId);
          continue;
        }
        if (item.kind === 'approval') {
          const audit: DshApprovalAudit = {
            approvalId: item.approvalId,
            toolName: item.toolName,
            ...(item.callId ? { callId: item.callId } : {}),
            ...(item.reason ? { reason: item.reason } : {}),
          };
          const binding = this.approvalTracker.onAuditAsked(audit);
          if (!this.approvalChannelAvailable) {
            getLogger().warn(
              `[dsh] approval requested approvalId=${item.approvalId} tool=${item.toolName}; live channel unavailable — falling back to Web UI`,
            );
            yield this.approvalFallbackText(item.toolName);
            continue;
          }
          if (emittedApprovals.has(item.approvalId)) continue;
          emittedApprovals.add(item.approvalId);
          yield this.buildApprovalRequested(sessionId, audit, binding, cwd);
          continue;
        }
        if (item.kind === 'assistant-stream') {
          for (const ev of translator.streamFrameToAgentEvents(item.frame, sessionId)) {
            yield ev;
          }
          continue;
        }

        const event: DshSessionEvent = item.event;
        if (event.type === 'tool/call') {
          const data = event.data as {
            callId?: string;
            name?: string;
            arguments?: string;
            turn?: number;
          };
          if (data.callId && data.name) {
            this.toolCalls.set(data.callId, {
              name: data.name,
              arguments: data.arguments ?? '',
              ...(data.turn === undefined ? {} : { turn: data.turn }),
            });
            if (this.toolCalls.size > 100) {
              const oldest = this.toolCalls.keys().next().value;
              if (oldest !== undefined) this.toolCalls.delete(oldest);
            }
          }
          continue;
        }
        if (event.type === 'approval/decided') {
          const data = event.data as { id?: string; outcome?: string };
          if (!data.id) continue;
          this.approvalTracker.onDecided(data.id);
          yield this.approvalResolved(data.id);
          continue;
        }

        for (const ev of translator.eventToAgentEvents(event, sessionId)) {
          yield ev;
          if (ev.type === 'result') return;
        }
      }
    } finally {
      streamAbort.abort();
      this.approvalTracker.clear();
      this.toolCalls.clear();
    }
  }

  /** Apply the configured permission preset once per session, before prompt. */
  private async alignPermissionPreset(sessionId: string, signal: AbortSignal): Promise<void> {
    const preset = this.configuredPermissionPreset;
    if (!preset || this.permissionAlignedSessions.has(sessionId)) return;
    const result = await this.client.executeCommand(sessionId, `/permission ${preset}`, { signal });
    if (!result) {
      throw new DshError(
        'command-unavailable',
        `DSH 未提供 /permission 命令，无法应用权限预设 ${preset}`,
      );
    }
    if (result.kind !== 'success') {
      throw new DshError(
        'command-failed',
        `DSH 应用权限预设 ${preset} 失败: ${result.text ?? 'unknown error'}`,
      );
    }
    this.permissionAlignedSessions.add(sessionId);
    getLogger().info(`[dsh] permission preset aligned session=${sessionId} preset=${preset}`);
  }

  /** Hot-update the configured preset; the next run aligns it. */
  async updateApprovalMode(settings: { permissionPreset?: string }): Promise<void> {
    this.configuredPermissionPreset = settings.permissionPreset;
    this.permissionAlignedSessions.clear();
    getLogger().info(
      `[dsh] permission preset updated to ${settings.permissionPreset ?? '(follow default)'}; applies to the next run`,
    );
  }

  /**
   * Answer one DSH approval. `accept` / `decline` are the only user decisions
   * exposed by the DSH Web UI; `cancel` stops the turn through session/cancel.
   */
  async respondApproval(requestId: number | string, response: unknown): Promise<void> {
    const approvalId = String(requestId);
    const binding =
      this.approvalTracker.getBinding(approvalId) ??
      (await this.approvalTracker.waitForBinding(approvalId, 2_000, this.activeAbort?.signal));
    if (!binding) {
      throw new Error('DSH 审批通道尚未就绪，请稍后重试或到 DSH Web UI 处理');
    }

    const action = (response as { action?: string } | undefined)?.action;
    if (action === 'accept' || action === 'decline') {
      await this.client.answerRemoteEvent(
        binding.waterfall.clientId,
        binding.waterfall.eventId,
        { kind: 'result', value: action === 'accept' ? 'allowed-once' : 'rejected' },
        { signal: this.activeAbort?.signal },
      );
    } else if (action === 'cancel') {
      const sessionId = this.activeSessionId;
      if (!sessionId) throw new Error('DSH session 已结束，无法取消审批');
      await this.client.unary('session/cancel', { sessionId }, { timeoutMs: CANCEL_TIMEOUT_MS });
    } else {
      throw new Error(`DSH 不支持审批决策: ${String(action)}`);
    }

    this.approvalTracker.onDecided(approvalId);
    getLogger().info(
      `[dsh] approval responded approvalId=${approvalId} action=${String(action)} eventId=${binding.waterfall.eventId}`,
    );
  }

  private buildApprovalRequested(
    sessionId: string,
    audit: DshApprovalAudit,
    binding: DshApprovalBinding | undefined,
    cwd: string,
  ): AgentEvent {
    const call = audit.callId ? this.toolCalls.get(audit.callId) : undefined;
    const args = parseToolArguments(call?.arguments);
    const command = typeof args.command === 'string' ? args.command : undefined;
    const commandCwd = typeof args.workdir === 'string' ? args.workdir : cwd;
    const reason = binding?.waterfall.reason ?? audit.reason;
    const view: ApprovalView = {
      requestId: audit.approvalId,
      kind: command ? 'command' : 'tool',
      ...(reason ? { reason } : {}),
      ...(command
        ? { command, commandCwd }
        : {
            toolName: audit.toolName,
            ...(call?.arguments ? { toolInput: call.arguments } : {}),
          }),
      availableDecisions: ['accept', 'decline'],
      note: '仅放行这一次调用；不会改变会话权限预设。若飞书提交失败，请到 DSH Web UI 处理。',
    };
    return {
      type: 'approval_requested',
      requestId: audit.approvalId,
      kind: view.kind,
      threadId: sessionId,
      turnId: call?.turn === undefined ? '' : String(call.turn),
      itemId: audit.callId ?? audit.approvalId,
      view,
      timestamp: new Date().toISOString(),
    };
  }

  private approvalResolved(requestId: string): AgentEvent {
    return {
      type: 'approval_resolved',
      requestId,
      outcome: 'resolved',
      timestamp: new Date().toISOString(),
    };
  }

  private approvalFallbackText(toolName: string): AgentEvent {
    return {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: `⚠️ 需要授权（${toolName}）：请在 DSH Web UI 处理 ${this.client.baseUrl}`,
          },
        ],
      },
    };
  }

  /**
   * Compact the session through DSH's `/compact` command.
   *
   * Commands are a separate RPC from turns (`commands/execute`, idle-only), so
   * this never prompts the model and never waits for a `turn/end`: the RPC
   * itself settles when the compaction finishes, which is why the unary budget
   * is disabled here (stop + the idle watchdog bound it instead). DSH reports
   * expected refusals (busy / nothing to compact / summary failure) as
   * `kind:'error'` values rather than RPC errors — those must become an error
   * result, not a success card.
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (this.running) {
      throw new Error('DshRunner is already running');
    }
    const sessionId = opts.sessionId;
    if (!sessionId) {
      throw new Error('compact requires a sessionId');
    }

    const abort = new AbortController();
    this.activeAbort = abort;
    this.running = true;
    this.activeSessionId = sessionId;
    let terminalEmitted = false;

    try {
      if (this.daemon) await this.daemon.ensure();

      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        cwd: opts.cwd,
        model: this.configuredModel ?? 'DSH',
      };

      const outcome = await this.client.executeCommand(sessionId, DSH_COMPACT_COMMAND, {
        signal: abort.signal,
        // 压缩是一次长 unary（服务端等压缩结束才回），60s 默认预算会误杀；
        // 由 /stop 的 abort 与卡片空闲看门狗兜底。
        timeoutMs: 0,
      });

      if (abort.signal.aborted) {
        terminalEmitted = true;
        yield {
          type: 'result',
          subtype: 'interrupted',
          session_id: sessionId,
          errorMessage: 'compact stopped',
        };
        return;
      }

      if (!outcome) {
        terminalEmitted = true;
        yield {
          type: 'result',
          subtype: 'error',
          session_id: sessionId,
          errorMessage: 'DSH 未执行压缩：该 session 没有 /compact 命令',
        };
        return;
      }

      const text = typeof outcome.text === 'string' ? outcome.text.trim() : '';
      if (text) {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
          timestamp: new Date().toISOString(),
        };
      }

      const failed = outcome.kind === 'error';
      terminalEmitted = true;
      yield {
        type: 'result',
        subtype: failed ? 'error' : 'success',
        session_id: sessionId,
        ...(failed ? { errorMessage: text || 'DSH 压缩失败' } : {}),
      };
    } catch (err) {
      terminalEmitted = true;
      const aborted = abort.signal.aborted;
      getLogger().warn(
        `[dsh] compact failed session=${sessionId}: ${(err as Error).message}` +
          (aborted ? ' (stopped)' : ''),
      );
      yield {
        type: 'result',
        subtype: aborted ? 'interrupted' : 'error',
        session_id: sessionId,
        errorMessage: aborted ? 'compact stopped' : `DSH compact failed: ${(err as Error).message}`,
      };
    } finally {
      this.running = false;
      this.activeSessionId = null;
      this.activeAbort = null;
    }

    if (!terminalEmitted) {
      yield {
        type: 'result',
        subtype: 'error',
        session_id: sessionId,
        errorMessage: 'compact ended without a terminal event',
      };
    }
  }

  /**
   * Resolve with the promise's value, or `undefined` as soon as `signal` aborts.
   * The underlying promise keeps running (its own timeout still applies) — the
   * caller decides what to do with a late settlement.
   */
  private async awaitOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    if (signal.aborted) return undefined;
    return new Promise<T | undefined>((resolve, reject) => {
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        resolve(undefined);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  /** Send session/cancel with a short bound; never throws (cleanup path). */
  private async cancelSessionQuietly(sessionId: string): Promise<void> {
    try {
      await this.client.unary('session/cancel', { sessionId }, { timeoutMs: CANCEL_TIMEOUT_MS });
    } catch (err) {
      getLogger().warn(`[dsh] session/cancel failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  async stop(_opts?: { immediate?: boolean }): Promise<void> {
    const sessionId = this.activeSessionId;
    const abort = this.activeAbort;
    if (abort && !abort.signal.aborted) abort.abort();
    if (sessionId) {
      // Do NOT reuse the run's (already aborted) signal: cancel must be sent,
      // but bounded — a hung server must not block /stop or the queue.
      await this.cancelSessionQuietly(sessionId);
      getLogger().info(`[dsh] cancelled session ${sessionId}`);
    }
  }

  killOrphan(): void {
    // No local subprocess for DSH — nothing to reap.
  }

  registerExitHandlers(): void {
    // No local subprocess for DSH — nothing to register.
  }

  unregisterExitHandlers(): void {
    // No-op (see registerExitHandlers).
  }
}
