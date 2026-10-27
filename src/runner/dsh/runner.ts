/**
 * DshRunner — workspace-lifetime runner bridging to the DSH Web Host
 * (DeepSeek Harness) over plain HTTP. No local subprocess is spawned.
 *
 * Flow per run: session/create(cwd) (when no sessionId) → model/permission
 * alignment → synthetic system/init (DSH has no init event) → session/prompt
 * (mode:'queue') → consume `session/follow` + `$events` until turn/end.
 *
 * stop() → session/cancel + abort the mux subscription. killOrphan is a no-op
 * (no local process); registerExitHandlers cancels the in-flight turn
 * synchronously on process exit, because the turn lives in the shared host and
 * would otherwise keep running with no subscriber. DSH approvals are
 * two-channel: durable `approval/asked` / `approval/decided` drive the Feishu
 * card, while the answerable `$events` waterfall supplies eventId/clientId.
 * `ask_user_question` prompts arrive only as a `user-questions/request`
 * waterfall (no durable event); they are rendered as a `kind:'question'`
 * approval on the same card. If `$events` is unavailable, the runner falls
 * back to the Web UI prompt.
 */

import type { AgentSessionReader } from '../../session-contract.js';
import type {
  AgentEvent,
  AgentStatusInfo,
  ApprovalView,
  GoalView,
  ResultEvent,
  SpawnOptions,
  StopOutcome,
} from '../types.js';
import type { AgentRunner } from '../types.js';
import { DshClient, DshError, newPromptRequestId, type WebSocketFactory } from './client.js';
import { DshTranslator } from './translator.js';
import { goalFromChange, goalFromProjection, goalStateEvent, sameGoal } from './goal-view.js';
import { DshApprovalTracker, type DshApprovalAudit, type DshApprovalBinding } from './approval.js';
import { mergeAsync } from './merge.js';
import { getLogger } from '../../logger/index.js';
import { registerExitCleanup, unregisterExitCleanup } from '../common/spawning-runner.js';
import { cancelSessionSync } from './exit-cancel.js';
import { DshInflightStore } from './inflight.js';
import type { DshDaemon } from './daemon.js';
import type {
  DshApprovalStreamItem,
  DshContextPressure,
  DshModelSelection,
  DshOpenTurnState,
  DshProjectionItem,
  DshSessionStats,
  DshQuestion,
  DshQuestionAnswer,
  DshRemoteEventOutcome,
  DshSessionEvent,
  DshStreamItem,
} from '../../dsh/types.js';

/**
 * Legacy provider for configs written before `agents.dsh.provider` existed.
 * New configs pin the provider explicitly; the card reads the live catalog.
 */
const DSH_MODEL_PROVIDER = 'deepseek-official';

/** DSH 内建手动压缩命令（dsh-command-compact，无参数、仅空闲可执行）。 */
const DSH_COMPACT_COMMAND = '/compact';

/**
 * 飞书提问卡的有效窗口。
 *
 * DSH 的 legacy `ask_user_question` 会无限等待（`timed:false`），Web UI 那侧
 * 也一直在等。飞书卡超时后只把这一路的应答权交回（outcome `next`），不取消
 * turn，所以窗口比审批默认的 5 分钟给得宽：用户通常要先读完上一条长回答。
 * 超时后问题仍可在 DSH Web UI 回答；之后由 idle 看门狗兜底（默认 15 分钟
 * 静默，见 `config.idle.watchdogMinutes`，等待提问期间暂停计时）。
 */
const DSH_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 卡片上实际生效的多选语义：无选项的 multiSelect 没有可勾内容，共享渲染层把它
 * 当自由文本题，coordinator 的 answerCustom 又拒绝 multiSelect——所以按单选处理，
 * 视图与答案编码必须用同一个判定，否则会编码出错答案。
 */
function isCardMultiSelect(question: DshQuestion): boolean {
  return question.multiSelect === true && (question.options?.length ?? 0) > 0;
}

/**
 * 把 coordinator 回传的「问题文本 → 答案」映射成 DSH 的 `{id, selected,
 * custom}` 批次。
 *
 * 契约见 `UserQuestion`：答案按问题文本回传；本函数按 id 回编。单选且文本
 * 不等于任何选项 label 时，按 DSH Web UI 的语义记为自由答案（`selected: []`
 * + `custom`）。
 */
function buildQuestionAnswers(questions: DshQuestion[], response: unknown): DshQuestionAnswer[] {
  const answers = (response as { answers?: Record<string, string | string[]> } | undefined)
    ?.answers;
  if (!answers) throw new Error('DSH 提问回答缺少 answers 载荷');
  return questions.map((question) => {
    const value = answers[question.question];
    if (value === undefined) throw new Error(`DSH 提问缺少答案: ${question.question}`);
    const values = (Array.isArray(value) ? value : [value]).filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
    if (values.length === 0) throw new Error(`DSH 提问答案为空: ${question.question}`);
    if (isCardMultiSelect(question)) return { id: question.id, selected: values };
    const selected = values[0]!;
    const isOption = (question.options ?? []).some((option) => option.label === selected);
    return isOption
      ? { id: question.id, selected: [selected] }
      : { id: question.id, selected: [], custom: selected };
  });
}

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
  /**
   * 退出路径上取消在途 turn 的传输实现（测试注入）。
   * 默认走同步 curl（`cancelSessionSync`）：`process.on('exit')` 里不能 await。
   */
  cancelOnExit?: (info: { baseUrl: string; sessionId: string }) => void;
  /**
   * 在途 prompt 的持久化记录文件（启动对账用）。省略 = 不记录（测试、临时实例）。
   */
  inflightPath?: string;
}

/** Budget for one session/cancel attempt on stop. */
const CANCEL_TIMEOUT_MS = 5_000;

/**
 * goal 探测的预算。goal 是"增强信息"：读不到就按没有（known:false）继续跑，
 * 但绝不允许一次慢投影把整个 run 的启动/收尾拖住。
 */
const GOAL_PROBE_TIMEOUT_MS = 5_000;
/** Total stop budget: withdraw + cancel + verify must not hold the lane forever. */
const STOP_BUDGET_MS = 5_000;
/** A prompt request that was still in flight can land after stop's abort. */
const STOP_ADMIT_ATTEMPTS = 5;
const STOP_ADMIT_DELAY_MS = 250;
/** Cancel is applied synchronously; give the turn a moment to unwind. */
const STOP_VERIFY_ATTEMPTS = 4;
const STOP_VERIFY_DELAY_MS = 350;
/** Per-read budget for inbox/status probes on the stop path. */
const STOP_PROBE_TIMEOUT_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 状态条累计值（跨投影帧合并后的当前快照）。 */
interface LiveStatusAccumulator {
  contextUsed?: number;
  contextLimit?: number;
  steps?: number;
  toolMs?: number;
}

/**
 * 把一帧 `session/control` 投影写进状态条累计值。
 * @returns 本仓库消费的字段是否真的变了（未变不必刷新卡片）。
 */
function applyProjection(live: LiveStatusAccumulator, key: string, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (key === 'contextPressure') {
    const pressure = value as DshContextPressure;
    // 官方 UI 的口径：优先 projectedTokens（下一次请求的预估），退回实际占用。
    const used = pressure.projectedTokens ?? pressure.pressureTokens;
    let changed = false;
    if (typeof used === 'number' && used !== live.contextUsed) {
      live.contextUsed = used;
      changed = true;
    }
    if (
      typeof pressure.contextWindow === 'number' &&
      pressure.contextWindow > 0 &&
      pressure.contextWindow !== live.contextLimit
    ) {
      live.contextLimit = pressure.contextWindow;
      changed = true;
    }
    return changed;
  }
  if (key === 'sessionStats') {
    const stats = value as DshSessionStats;
    let changed = false;
    if (typeof stats.steps === 'number' && stats.steps !== live.steps) {
      live.steps = stats.steps;
      changed = true;
    }
    if (typeof stats.toolMs === 'number' && stats.toolMs !== live.toolMs) {
      live.toolMs = stats.toolMs;
      changed = true;
    }
    return changed;
  }
  return false;
}

/** Build the `run_status` event for the card's status strip. */
function statusEventOf(live: LiveStatusAccumulator): AgentEvent {
  return {
    type: 'run_status',
    ...(live.contextUsed === undefined ? {} : { contextUsed: live.contextUsed }),
    ...(live.contextLimit === undefined ? {} : { contextLimit: live.contextLimit }),
    ...(live.steps === undefined ? {} : { steps: live.steps }),
    ...(live.toolMs === undefined ? {} : { toolMs: live.toolMs }),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Attach the context window to the result usage.
 *
 * DSH 的会话读取端只产出占用、不产出窗口上限，终态卡因此只能显示绝对量；
 * 控制流拿到的 `contextWindow` 是唯一的百分比来源。已有上限（未来 DSH 自带）
 * 时不覆盖。
 */
function attachContextLimit(ev: AgentEvent, limit: number | undefined): AgentEvent {
  if (ev.type !== 'result' || limit === undefined || !ev.usage) return ev;
  if (ev.usage.context_limit !== undefined) return ev;
  return { ...ev, usage: { ...ev.usage, context_limit: limit } };
}

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

/**
 * 用户 stop 的终态结果（run() 的 5 个中止点各 yield 同一形状）。
 *
 * 必须 yield result 而不是裸 return：调用方靠 result 收尾 run 卡，否则卡片
 * 停留在「运行中」（见 run() 内 startup abort 注释）。
 */
function interruptedResult(sessionId: string): ResultEvent {
  return {
    type: 'result',
    subtype: 'interrupted',
    session_id: sessionId,
    errorMessage: 'run stopped',
  };
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
  /** This run's prompt identity (`source.rpcId`); null outside a submitted prompt. */
  private activePromptRequestId: string | null = null;
  /** Whether the current prompt request was accepted by the host. */
  private promptAdmitted = false;
  /**
   * Releases the next run's prompt only after this stop's withdraw/cancel has
   * been applied. Aborting the local mux lets the queue advance immediately;
   * without the gate the successor's prompt can reach the host before the
   * cancel, and a session-scoped cancel would then hit the *new* turn.
   */
  private pendingStopGate: Promise<void> | null = null;
  private pendingStopSessionId: string | null = null;
  private readonly inflight: DshInflightStore | null;
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
  /**
   * eventId → 待回答的 DSH `ask_user_question` waterfall。
   *
   * 提问没有 durable 审计事件，eventId 本身就是卡片 requestId；这里保存应答
   * 所需的 clientId 与题面（DSH 回编按题目 id）。每轮 run 清空。
   */
  private readonly pendingQuestions = new Map<
    string,
    { clientId: string; questions: DshQuestion[] }
  >();
  /** callId → tool call, used to render the command in the approval card. */
  private readonly toolCalls = new Map<
    string,
    { name: string; arguments: string; turn?: number }
  >();
  /** False after `$events` is unavailable; approval/asked then falls back to text. */
  private approvalChannelAvailable = true;
  /** 退出路径的取消实现（默认同步 curl，见 `cancelSessionSync`）。 */
  private readonly cancelOnExit: (info: { baseUrl: string; sessionId: string }) => void;

  constructor(opts: DshRunnerOptions) {
    this.sessionReader = opts.sessionReader;
    this.daemon = opts.daemon;
    this.configuredModel = opts.model;
    this.configuredProvider = opts.provider;
    this.agentPreset = opts.agentPreset;
    this.configuredPermissionPreset = opts.permissionPreset;
    this.reasoningEffort = opts.reasoningEffort;
    this.inflight = opts.inflightPath ? new DshInflightStore(opts.inflightPath) : null;
    this.client = new DshClient(opts.host ?? 'http://127.0.0.1:3080', {
      dshHome: opts.dshHome,
      token: opts.token,
      credentialsFile: opts.credentialsFile,
      fetchImpl: opts.fetchImpl,
      webSocketImpl: opts.webSocketImpl,
      requestTimeoutMs: opts.requestTimeoutMs,
    });
    this.cancelOnExit =
      opts.cancelOnExit ??
      (({ baseUrl, sessionId }) => {
        cancelSessionSync({
          baseUrl,
          sessionId,
          dshHome: opts.dshHome,
          credentialsFile: opts.credentialsFile,
        });
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

  /**
   * 新建 DSH session 并取回 sessionId；run 在挂起期间被 stop 时返回 undefined。
   *
   * 红线：不把 run 的 abort signal 直接交给 create —— abort 掉请求会丢掉刚创建的
   * sessionId，服务端若已完成创建就留下一个无法 cancel 的孤儿 session。改为 abort
   * 时立即放行 run（队列不被挂起），create 后台落定后再补 cancel。
   */
  private async acquireSessionId(cwd: string, signal: AbortSignal): Promise<string | undefined> {
    const createPromise = this.client.createSession({
      cwd,
      ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}),
    });
    const created = await this.awaitOrAbort(createPromise, signal);
    if (created) return created.sessionId;
    void createPromise.then(
      (c) => this.cancelSessionQuietly(c.sessionId),
      () => {
        /* create failed after stop — nothing to cancel */
      },
    );
    getLogger().info('[dsh] run stopped during session/create; will cancel if it settles');
    return undefined;
  }

  /**
   * 把本轮消息交给 DSH 的排队收件箱，返回本轮的身份与起始水位。
   *
   * 三条不变量（都关系到「迟到/抢先的 stop 能否被正确撤销」）：
   * - 起始水位取 prompt **之前**的 latestEventSeq：session/page 返回整个会话，
   *   从 0 开始会把首轮已完成 turn 在每次后续消息时重放一遍。
   * - 身份（requestId）在请求发出**之前**就公布：stop 可能落在 session/prompt 的
   *   在途窗口里，那时它必须知道宿主受理后该撤销哪个收件项。
   * - `promptAdmitted` 只在宿主接受后置真：撤销路径据此区分「还没进去」与「已排队」。
   */
  private async submitPrompt(
    sessionId: string,
    cwd: string,
    message: string,
    signal: AbortSignal,
  ): Promise<{ prePromptSeq: number; promptRequestId: string }> {
    const prePromptSeq = await this.client.latestEventSeq(sessionId, { signal });
    const promptRequestId = newPromptRequestId();
    this.activePromptRequestId = promptRequestId;
    this.promptAdmitted = false;
    this.inflight?.record({
      sessionId,
      promptRequestId,
      baseUrl: this.client.baseUrl,
      cwd,
    });
    await this.client.unary(
      'session/prompt',
      {
        requestId: promptRequestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
      },
      { signal },
    );
    this.promptAdmitted = true;
    return { prePromptSeq, promptRequestId };
  }

  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (this.running) {
      throw new Error('DshRunner is already running');
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    this.running = true;

    // A stop releases the local lane before its cancel has been applied; the
    // next prompt must not race that cancel (see `pendingStopGate`). State is
    // already published above so an immediate stop can abort this run too.
    await this.awaitStopGate(opts.sessionId);

    let sessionId = opts.sessionId;
    let terminalEmitted = false;
    let promptRequestId: string | null = null;
    try {
      // DSH is a shared, machine-wide process. Reuse it when it is already
      // listening; otherwise start it detached so lark-remote exiting does not
      // stop it for every other instance.
      if (this.daemon) await this.daemon.ensure();

      // session/create 必须包进同一 try/finally，否则创建失败（服务端不可达/报错）
      // 会在进入旧 try 之前抛异常，finally 不执行 → running 恒 true、activeAbort 残留。
      if (!sessionId) {
        const created = await this.acquireSessionId(opts.cwd, abort.signal);
        if (created === undefined) {
          terminalEmitted = true;
          yield interruptedResult('');
          return;
        }
        sessionId = created;
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
        yield interruptedResult(sessionId);
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
            yield interruptedResult(sessionId);
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
        yield interruptedResult(sessionId);
        return;
      }

      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        cwd: opts.cwd,
        model: this.configuredModel ?? 'DSH',
      };

      // Goal seed：卡片从第一帧就知道这个会话有没有长期目标。放在 init 之后、
      // prompt 之前——用户发消息时若是 queued，卡片会长时间停在「运行中」，
      // 这期间"目标是什么、第几轮"是唯一能解释"为什么还不停"的信息。
      const seedGoal = await this.client.goalState(sessionId, {
        signal: abort.signal,
        timeoutMs: GOAL_PROBE_TIMEOUT_MS,
      });
      const lastGoal: GoalView | null | undefined = seedGoal.known ? seedGoal.goal : undefined;
      // 只有确实存在 goal 才产事件：没有 goal 的会话保持事件序列不变（少一次
      // 渲染，也不让"读不到"变成一张多出来的卡片事件）。
      if (seedGoal.known && seedGoal.goal) yield goalStateEvent(seedGoal.goal, true);

      try {
        const submitted = await this.submitPrompt(sessionId, opts.cwd, message, abort.signal);
        promptRequestId = submitted.promptRequestId;

        if (abort.signal.aborted) {
          // stop() 在 prompt 已受理后到达：cancel 由 stop() 发出，这里直接收尾，
          // 不再打开 mux（否则会看到 cancel 产生的 turn/end 事件）。
          terminalEmitted = true;
          yield interruptedResult(sessionId);
          return;
        }

        try {
          for await (const ev of this.runTurn(
            sessionId,
            opts.cwd,
            submitted.prePromptSeq,
            promptRequestId,
            abort,
            { last: lastGoal },
          )) {
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
      this.activePromptRequestId = null;
      this.promptAdmitted = false;
      // On abort the stop path decides whether the marker is settled (verified
      // stop) or must survive for startup reconciliation (cancel failed). A
      // naturally finished run owns its terminal result, so drop it here.
      if (!abort.signal.aborted && sessionId && promptRequestId) {
        this.inflight?.clear(sessionId, promptRequestId);
      }
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
    promptRequestId: string,
    abort: AbortController,
    goal: { last: GoalView | null | undefined },
  ): AsyncGenerator<AgentEvent> {
    const streamAbort = new AbortController();
    const signal = AbortSignal.any([abort.signal, streamAbort.signal]);
    const translator = new DshTranslator();
    const emittedApprovals = new Set<string>();
    this.approvalTracker.clear();
    this.pendingQuestions.clear();
    this.toolCalls.clear();
    this.approvalChannelAvailable = true;

    // 状态条累计值（contextPressure / sessionStats 投影）。`contextWindow` 同时
    // 用于给 result.usage.context_limit 兜底：DSH 的会话读取端不产出上限，
    // 没有它终态卡只能显示绝对量、算不出百分比。
    const live: LiveStatusAccumulator = {};

    try {
      const sources = [
        this.client.sessionEvents(sessionId, signal, prePromptSeq, promptRequestId),
        this.client.approvalEvents(sessionId, signal),
        this.client.controlFrames(signal),
      ];
      for await (const item of mergeAsync<
        DshStreamItem | DshApprovalStreamItem | DshProjectionItem
      >(sources)) {
        if (abort.signal.aborted) return;

        if (item.kind === 'projection') {
          // 全 Host 流：只认本 session。未知 key 直接忽略（投影是能力发现式
          // 扩展的，不能因为多了个 key 就报错）。
          if (item.sessionId !== sessionId) continue;
          // goal 是会话级长期目标，单独成事件：卡片要在 agent 创建目标的当下
          // 就显示它（否则用户只会在一小时后看到「完成」才发现有个 40 轮任务）。
          if (item.key === 'goal') {
            const parsed = goalFromProjection(item.value);
            if (parsed !== undefined && !sameGoal(parsed, goal.last)) {
              goal.last = parsed;
              yield goalStateEvent(parsed, true);
            }
            continue;
          }
          // 只在消费字段真的变了时才产出事件：投影帧本身按 key 去重推送，
          // 这里再挡掉"值没变"的重复帧。不需要时间节流——卡片更新本来就有
          // 100ms 合批窗口，与正文 delta 共用同一条节流路径。
          if (!applyProjection(live, item.key, item.value)) continue;
          yield statusEventOf(live);
          continue;
        }

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
        if (item.kind === 'question') {
          // 同一 waterfall 在重连后会带新的 clientId 重投：覆盖写回，卡片的
          // requestId（eventId）不变，coordinator 按重投语义刷新视图。
          this.pendingQuestions.set(item.eventId, {
            clientId: item.clientId,
            questions: item.questions,
          });
          getLogger().info(
            `[dsh] user question surfaced eventId=${item.eventId} questions=${item.questions.length}`,
          );
          yield this.buildQuestionRequested(sessionId, item.eventId, item.questions);
          continue;
        }
        if (item.kind === 'cancelled') {
          // 提问与审批共用 cancel 帧：提问在别处（DSH Web UI）被回答或超时后
          // 也要清掉飞书卡片，否则上面还留着可点但已无 responder 的问题区。
          if (this.pendingQuestions.delete(item.eventId)) {
            getLogger().info(`[dsh] user question resolved elsewhere eventId=${item.eventId}`);
            yield this.approvalResolved(item.eventId);
            continue;
          }
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
        if (event.type === 'goal/change') {
          // 权威变更（create/edit/pause/resume/complete/block/clear）：不等投影
          // 推送，直接按事件更新——agent 刚 create 的那一刻卡片就该显示目标。
          const parsed = goalFromChange(event.data);
          if (parsed !== undefined && !sameGoal(parsed, goal.last)) {
            goal.last = parsed;
            yield goalStateEvent(parsed, true);
          }
          continue;
        }
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
          // 记账后继续往下走：tool/call 同时是卡片工具行的来源（translator 翻
          // 译成 assistant.tool_use）。早期版本在这里 `continue`，把调用轨迹整个
          // 吞掉——卡片因此只有正文、没有任何工具行。
        }
        if (event.type === 'approval/decided') {
          const data = event.data as { id?: string; outcome?: string };
          if (!data.id) continue;
          this.approvalTracker.onDecided(data.id);
          yield this.approvalResolved(data.id);
          continue;
        }

        for (const ev of translator.eventToAgentEvents(event, sessionId)) {
          if (ev.type === 'result') {
            if (!abort.signal.aborted) {
              for (const jobsEvent of await this.collectBackgroundJobs(sessionId, abort.signal)) {
                yield jobsEvent;
              }
              // 收尾复核：这一轮结束时 goal 是否仍 active，决定卡片能不能收尾。
              // 必须现读宿主，不能沿用过程中的最后一次观测——goal 可能在本轮
              // 最后一个 step 才被 complete，也可能刚被 driver 置为 blocked。
              const finalGoal = await this.client.goalState(sessionId, {
                signal,
                timeoutMs: GOAL_PROBE_TIMEOUT_MS,
              });
              if (finalGoal.known && !sameGoal(finalGoal.goal, goal.last)) {
                goal.last = finalGoal.goal;
                yield goalStateEvent(finalGoal.goal, true);
              }
            }
            yield attachContextLimit(ev, live.contextLimit);
            return;
          }
          yield ev;
        }
      }
    } finally {
      streamAbort.abort();
      this.approvalTracker.clear();
      this.pendingQuestions.clear();
      this.toolCalls.clear();
    }
  }

  /**
   * 收尾时仍在跑的后台任务。
   *
   * 只保留非终态（running/stopping）：已完成的任务由 agent 自己的 output 呈
   * 现，卡片列出来只会误导"还没跑完"。`job/list` 拿不到时返回空数组——没有
   * 任务列表不等于有任务在跑。
   */
  private async collectBackgroundJobs(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<AgentEvent[]> {
    const rows = await this.client.jobRows(sessionId, { signal });
    if (!rows) return [];
    const live = rows.filter((job) => job.status === 'running' || job.status === 'stopping');
    if (live.length === 0) return [];
    return [
      {
        type: 'background_jobs',
        jobs: live.map((job) => ({
          id: job.id,
          label: job.label ?? job.id,
          ...(job.status === undefined ? {} : { status: job.status }),
          ...(job.progress === undefined ? {} : { progress: job.progress }),
        })),
        timestamp: new Date().toISOString(),
      },
    ];
  }

  /** Kill one background job of this runner's session (card button path). */
  async killJob(sessionId: string, jobId: string): Promise<boolean> {
    return await this.client.jobKill(sessionId, jobId);
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
   * Answer one DSH approval or `ask_user_question` prompt.
   *
   * Approvals: `accept` / `decline` are the only user decisions exposed by the
   * DSH Web UI; `cancel` stops the turn through session/cancel.
   *
   * Questions: `answer` / `decline`（跳过回答）resolve the `user-questions/request`
   * waterfall with an answer batch; `cancel`（飞书卡超时）只把这一路交回
   * `next`，让 DSH Web UI 仍可回答，不取消 turn。
   */
  async respondApproval(requestId: number | string, response: unknown): Promise<void> {
    const approvalId = String(requestId);
    const question = this.pendingQuestions.get(approvalId);
    if (question) {
      await this.respondQuestion(approvalId, question, response);
      return;
    }

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

  /** Resolve one pending `ask_user_question` waterfall from a card action. */
  private async respondQuestion(
    eventId: string,
    pending: { clientId: string; questions: DshQuestion[] },
    response: unknown,
  ): Promise<void> {
    const action = (response as { action?: string } | undefined)?.action;
    let outcome: DshRemoteEventOutcome;
    if (action === 'answer') {
      outcome = {
        kind: 'result',
        value: { answers: buildQuestionAnswers(pending.questions, response) },
      };
    } else if (action === 'decline') {
      // 「跳过回答」：与 DSH Web UI 的 skip 同语义，逐题回空 selected，
      // 工具把这次提问当作已跳过，agent 拿到结果后继续。
      outcome = {
        kind: 'result',
        value: {
          answers: pending.questions.map((question) => ({ id: question.id, selected: [] })),
        },
      };
    } else if (action === 'cancel') {
      // 飞书卡超时/放弃：只交回这一路的应答权（outcome next）。DSH Web UI
      // 仍是 owner Client 且持有该 waterfall，可以继续回答；没有其他 Client
      // 时才 settle 为 next（工具报 no user-questions answerer）。
      outcome = { kind: 'next' };
    } else {
      throw new Error(`DSH 提问不支持审批决策: ${String(action)}`);
    }

    await this.client.answerRemoteEvent(pending.clientId, eventId, outcome, {
      signal: this.activeAbort?.signal,
    });
    this.pendingQuestions.delete(eventId);
    getLogger().info(`[dsh] user question responded eventId=${eventId} action=${String(action)}`);
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

  /**
   * Render one `user-questions/request` waterfall as a `kind:'question'`
   * approval area. The card renderer is agent-agnostic: it draws options,
   * the Other input, multi-select submit and skip from this view alone.
   */
  private buildQuestionRequested(
    sessionId: string,
    eventId: string,
    questions: DshQuestion[],
  ): AgentEvent {
    const view: ApprovalView = {
      requestId: eventId,
      kind: 'question',
      note: '仅影响本次回答；若飞书提交失败，请到 DSH Web UI 处理。',
      // 提问不是审批：超时只是把这一路交回 Web UI，卡上要如实说清还能去哪答。
      expiredHint: '仍可在 DSH Web UI 继续回答；本卡不再接收回答。',
      questions: questions.map((question) => {
        const options = (question.options ?? []).map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        }));
        return {
          id: question.id,
          question: question.question,
          // plan-review 提问把计划全文放在 detail；丢了就成了「看不见计划就批准」。
          ...(question.detail ? { detail: question.detail } : {}),
          ...(question.header ? { header: question.header } : {}),
          // 共享渲染层把「无选项」当自由文本题，而 coordinator 的 answerCustom
          // 拒绝 multiSelect——无选项的多选在卡片上等于无解，按单选渲染。
          ...(isCardMultiSelect(question) ? { multiSelect: true } : {}),
          options,
        };
      }),
      availableDecisions: [],
    };
    return {
      type: 'approval_requested',
      requestId: eventId,
      kind: 'question',
      threadId: sessionId,
      turnId: '',
      itemId: eventId,
      view,
      // legacy ask_user_question 没有服务端期限；给飞书卡一个宽窗口，
      // 超时只交回应答权、不取消 turn（见 respondQuestion）。
      timeoutMs: DSH_QUESTION_TIMEOUT_MS,
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

    // Same barrier as run(): a stop of this session must reach the host before
    // the next compact is submitted.
    await this.awaitStopGate(sessionId);

    try {
      if (this.daemon) await this.daemon.ensure();

      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        cwd: opts.cwd,
        model: this.configuredModel ?? 'DSH',
      };

      // 桥接重启后内存里没有在途 run，但服务端可能还在跑上一轮：先用只读
      // 探测兜底，别把注定被拒的 /compact 发出去（DSH 只回一句把「有压缩
      // 在跑」和「agent 不空闲」合并在一起的文案，用户看不出真实原因）。
      if (await this.client.hasOpenTurn(sessionId, { signal: abort.signal })) {
        terminalEmitted = true;
        yield {
          type: 'result',
          subtype: 'error',
          session_id: sessionId,
          errorMessage: '当前会话还有一轮在跑（DSH 服务端未空闲），等它结束后再压缩',
        };
        return;
      }

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

  /**
   * Stop this run's work in the shared host.
   *
   * Two distinct things can be running, and DSH needs a different call for each:
   *
   * 1. A prompt that was accepted but not claimed yet still sits in the host
   *    inbox. `session/cancel` would NOT drop it (`keepInbox`), so the turn would
   *    start later with no subscriber — an orphan. Withdraw it by `rpcId` via
   *    `session/updateQueue` instead, and leave the (foreign) active turn alone.
   * 2. An already-claimed turn (or a compact) can only be stopped with
   *    `session/cancel`. Since that request is session-scoped and only an
   *    acknowledgement, verify the session went idle before reporting success.
   *
   * The gate is held until the host-side action has landed. For a cancel that
   * includes the verification (and possible retry), because a retry cancel is
   * session-scoped and would otherwise hit the successor's new turn.
   */
  async stop(_opts?: { immediate?: boolean }): Promise<StopOutcome> {
    const sessionId = this.activeSessionId;
    const promptRequestId = this.activePromptRequestId;
    const promptAdmitted = this.promptAdmitted;
    const abort = this.activeAbort;
    // Free the local mux/queue first; the host-side stop continues below.
    if (abort && !abort.signal.aborted) abort.abort();
    if (!sessionId) return { status: 'noop' };

    let releaseGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.pendingStopGate = gate;
    this.pendingStopSessionId = sessionId;
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      releaseGate();
    };

    try {
      return await this.performStop(sessionId, promptRequestId, promptAdmitted, release);
    } finally {
      // Safety net for early returns/throws; performStop normally releases first.
      release();
      if (this.pendingStopGate === gate) {
        this.pendingStopGate = null;
        this.pendingStopSessionId = null;
      }
    }
  }

  /** Wait for a concurrent stop to reach the host before submitting a new prompt. */
  private async awaitStopGate(sessionId?: string): Promise<void> {
    const gate = this.pendingStopGate;
    if (!gate) return;
    if (
      sessionId === undefined ||
      this.pendingStopSessionId === null ||
      sessionId !== this.pendingStopSessionId
    ) {
      return;
    }
    await gate;
  }

  private async performStop(
    sessionId: string,
    promptRequestId: string | null,
    promptAdmitted: boolean,
    releaseGate: () => void,
  ): Promise<StopOutcome> {
    const deadline = Date.now() + STOP_BUDGET_MS;
    try {
      if (promptRequestId) {
        const itemId = await this.findPendingPromptWithin(
          sessionId,
          promptRequestId,
          promptAdmitted,
          deadline,
        );
        if (itemId && (await this.removePendingPrompt(sessionId, itemId, deadline))) {
          releaseGate();
          this.inflight?.clear(sessionId, promptRequestId);
          getLogger().info(`[dsh] stop withdrew queued prompt session=${sessionId}`);
          return { status: 'withdrawn', sessionId };
        }
      }

      // Nothing (or nothing claimable) in the inbox: the turn/compact is live.
      if (!(await this.cancelWithRetry(sessionId, deadline))) {
        releaseGate();
        getLogger().warn(`[dsh] stop unconfirmed session=${sessionId}: cancel not accepted`);
        return { status: 'unconfirmed', sessionId, detail: 'session/cancel was not accepted' };
      }

      const state = await this.waitForClosed(sessionId, deadline);
      if (state === 'closed') {
        releaseGate();
        // cancel 是 keepInbox：prompt 可能仍在 inbox 里，等下一个无人订阅的
        // turn 认领（探测超时/迟到 admit 退到 cancel 分支时，
        // 旧实现直接清 inflight 标记——被停的 prompt 会被后续 turn 隐形执行
        //（耗 token、改工作区，卡片不可见），启动对账安全网也被解除）。
        // closed 后补一次撤回：在 inbox 就撤走，确认不在才清标记。
        if (promptRequestId) {
          await this.withdrawPendingPromptAfterCancel(sessionId, promptRequestId, deadline);
        }
        getLogger().info(`[dsh] cancelled session ${sessionId}`);
        return { status: 'cancelled', sessionId };
      }
      if (state === 'unknown') {
        releaseGate();
        return { status: 'unconfirmed', sessionId, detail: 'turn state unavailable after cancel' };
      }

      // The host still reports an open turn (slow unwind or lost cancel): one
      // more attempt, then report honestly instead of pretending it stopped.
      // Keep the gate closed through the retry: it is session-scoped, so the
      // successor must not submit its prompt until this attempt has landed.
      await this.cancelWithRetry(sessionId, deadline);
      const retryState = await this.waitForClosed(sessionId, deadline);
      releaseGate();
      if (retryState === 'closed') {
        if (promptRequestId) {
          await this.withdrawPendingPromptAfterCancel(sessionId, promptRequestId, deadline);
        }
        return { status: 'cancelled', sessionId };
      }
      getLogger().warn(`[dsh] stop unconfirmed session=${sessionId}: turn still open`);
      return { status: 'unconfirmed', sessionId, detail: 'turn still open after cancel' };
    } catch (err) {
      releaseGate();
      getLogger().warn(`[dsh] stop failed session=${sessionId}: ${(err as Error).message}`);
      return { status: 'unconfirmed', sessionId, detail: (err as Error).message };
    }
  }

  /**
   * Locate this run's unclaimed prompt.
   *
   * An already-admitted prompt is visible immediately. A request still in
   * flight can be admitted after stop aborted it, so poll the inbox briefly —
   * that is the only client-side protection against a late orphan turn.
   */
  private async findPendingPromptWithin(
    sessionId: string,
    requestId: string,
    admitted: boolean,
    deadline: number,
  ): Promise<string | undefined> {
    const attempts = admitted ? 1 : STOP_ADMIT_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && !(await this.sleepWithin(deadline, STOP_ADMIT_DELAY_MS))) return undefined;
      try {
        const itemId = await this.client.findPendingPrompt(sessionId, requestId, {
          timeoutMs: this.stopProbeTimeout(deadline),
        });
        if (itemId) return itemId;
        if (admitted) return undefined;
      } catch (err) {
        // 单次探测错误只消耗一次尝试（不提前放弃）：探测失败就 return 会把
        // 仍在 inbox 的 prompt 交给 cancel 分支处理——cancel 是 keepInbox，
        // prompt 会留到下一个无人订阅的 turn 被隐形执行。
        getLogger().warn(
          `[dsh] stop inbox probe failed session=${sessionId}: ${(err as Error).message}`,
        );
        continue;
      }
    }
    return undefined;
  }

  /**
   * cancel 确认 closed 后的收尾：cancel 是 keepInbox，prompt 可能仍在 inbox。
   * 在则撤回（防被下一个 turn 隐形认领），确认不在（已被本 turn 消费）或
   * 撤回成功才清 inflight 标记；探测/撤回失败保留标记，交给下次启动的
   * reconcile（findPendingPrompt 落空即自然清除，无副作用）。
   */
  private async withdrawPendingPromptAfterCancel(
    sessionId: string,
    promptRequestId: string,
    deadline: number,
  ): Promise<void> {
    try {
      const itemId = await this.client.findPendingPrompt(sessionId, promptRequestId, {
        timeoutMs: this.stopProbeTimeout(deadline),
      });
      if (itemId) {
        const removed = await this.client.removeQueuedPrompt(sessionId, itemId, {
          timeoutMs: this.stopProbeTimeout(deadline),
        });
        if (removed) {
          getLogger().info(
            `[dsh] stop withdrew inbox prompt left behind by cancel session=${sessionId}`,
          );
          this.inflight?.clear(sessionId, promptRequestId);
        }
        return;
      }
      this.inflight?.clear(sessionId, promptRequestId);
    } catch (err) {
      getLogger().warn(
        `[dsh] post-cancel withdraw probe failed session=${sessionId}: ${(err as Error).message}`,
      );
    }
  }

  private async removePendingPrompt(
    sessionId: string,
    itemId: string,
    deadline: number,
  ): Promise<boolean> {
    try {
      return await this.client.removeQueuedPrompt(sessionId, itemId, {
        timeoutMs: this.stopProbeTimeout(deadline),
      });
    } catch (err) {
      getLogger().warn(
        `[dsh] stop withdraw failed session=${sessionId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** One cancel attempt, then one retry (the request is idempotent when idle). */
  private async cancelWithRetry(sessionId: string, deadline: number): Promise<boolean> {
    if (await this.cancelOnce(sessionId, deadline)) return true;
    if (!(await this.sleepWithin(deadline, 150))) return false;
    return this.cancelOnce(sessionId, deadline);
  }

  private async cancelOnce(sessionId: string, deadline: number): Promise<boolean> {
    const timeoutMs = Math.max(1, Math.min(CANCEL_TIMEOUT_MS, deadline - Date.now()));
    try {
      await this.client.unary('session/cancel', { sessionId }, { timeoutMs });
      return true;
    } catch (err) {
      getLogger().warn(`[dsh] session/cancel failed for ${sessionId}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Poll the host until the session reports idle, or the budget runs out. */
  private async waitForClosed(sessionId: string, deadline: number): Promise<DshOpenTurnState> {
    let state: DshOpenTurnState = 'unknown';
    for (let attempt = 0; attempt < STOP_VERIFY_ATTEMPTS; attempt++) {
      if (attempt > 0 && !(await this.sleepWithin(deadline, STOP_VERIFY_DELAY_MS))) break;
      state = await this.client.openTurnState(sessionId, {
        timeoutMs: this.stopProbeTimeout(deadline),
      });
      if (state === 'closed') return 'closed';
    }
    return state;
  }

  /** Sleep, but never past the stop deadline. Returns false when out of budget. */
  private async sleepWithin(deadline: number, ms: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(ms, remaining));
    return Date.now() < deadline;
  }

  private stopProbeTimeout(deadline: number): number {
    return Math.max(1, Math.min(STOP_PROBE_TIMEOUT_MS, deadline - Date.now()));
  }

  killOrphan(): void {
    // No local subprocess for DSH — nothing to reap.
  }

  /**
   * 退出前取消在途 turn。
   *
   * turn 跑在常驻共享的 `dsh web` host 里，不在本进程的子进程树上；所以
   * "杀自己的子进程"这套退出清理对它无效，桥接一退出，turn 继续无人接收地跑
   * （2026-10-19 实测：一个孤儿 turn 在桥接死后又跑了 2h21m / 345 个 step）。
   * 这里复用进程级退出分发器，用同步 curl 发一次 `session/cancel`。
   */
  registerExitHandlers(): void {
    registerExitCleanup(this);
  }

  unregisterExitHandlers(): void {
    unregisterExitCleanup(this);
  }

  /** Exit dispatcher hook: cancel the in-flight turn, bounded and never throwing. */
  cleanupOnExit(): void {
    if (!this.running || !this.activeSessionId) return;
    const sessionId = this.activeSessionId;
    try {
      this.cancelOnExit({ baseUrl: this.client.baseUrl, sessionId });
      getLogger().info(`[dsh] exit-cancel sent session=${sessionId}`);
    } catch (err) {
      getLogger().warn(`[dsh] exit-cancel failed session=${sessionId}: ${(err as Error).message}`);
    }
  }
}
