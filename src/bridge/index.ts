import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Runner, AgentRunner, AgentEvent } from '../runner/index.js';
import { isContentFilterFailure } from '../common/turn-failure.js';
import type { AgentRegistry } from '../runner/registry.js';
import type { SessionReaderRegistry, SessionStore } from '../session/index.js';
import { getAgentConfig, type AppConfig } from '../config/index.js';
import {
  defaultCodebuddyProductConfigCacheDir,
  ensureCodebuddyRegion,
  invalidateCodebuddyCatalogCache,
  invalidateCodebuddyRegion,
  scheduleCodebuddyRegionRedetect,
} from '../config/codebuddy-catalog.js';
import {
  readCodebuddyModelError,
  recordCodebuddyModelRejection,
  recordCodebuddyModelSuccess,
  resolveCodebuddyModel,
} from '../config/codebuddy-model-state.js';
import {
  codebuddyProjectsDir,
  encodeCodebuddyProjectDirName,
} from '../session/codebuddy/sessions.js';
import { resolveFinalUsage, errorMessage } from './final-usage.js';
import { getLogger } from '../logger/index.js';
import { RunCardSession, type RunCardChannel } from '../card/run-card-session.js';
import { renderRunCardDetailed, type RunCardRenderOptions } from '../card/run-renderer.js';
import { writeFinalAnswerFile, finalAnswerFileFailureCard } from '../card/final-answer-file.js';
import { bestEffortUnlink } from '../common/fs.js';
import { isRunActive, isRunTerminal, type RunState, type RunTerminal } from '../card/run-state.js';
import { buildSessionHistoryCard } from '../card/card-helpers.js';
import { agentDisplayName, resumeUseButton } from '../card/card-shared.js';
import { enforceCardBudget } from '../card/card-budget.js';
import { RunUsageCollector } from './run-usage.js';
import type { AgentKind } from '../agent-kinds.js';
import type { StopOutcome } from '../runner/types.js';
import { CompactLifecycle, runnerSupportsCompact, terminalReactionEmoji } from './compact.js';
import { HostTurnStop, type HostTurnStopResult } from './host-stop.js';
import { JobWatchLifecycle } from './job-watch.js';
import { BashRunLifecycle } from './bash-run.js';
import {
  QueueManager,
  type QueuedTask,
  type EnqueueOptions,
  type AgentBinding,
  type ExecutingInfo,
} from './queue-manager.js';
import { ApprovalCoordinator } from './approval-coordinator.js';
import { ApprovalActions } from './approval-actions.js';
import { createRunApprovalCoordinator, remindPendingApproval } from './run-approval.js';
import {
  writeBackInitSession,
  writeBackResultSession,
  writeBackTurnStarted,
  type WritebackContext,
} from './session-writeback.js';
import { InboundMediaHandler } from './inbound-media.js';
import type { InboundMediaPayload } from '../connector/index.js';
import type { MediaOutcome } from '../inbound/turn.js';

/**
 * Max events to read for the completion notification card (mirror router's
 * AUTO_RESUME_MAX_EVENTS = 5). Without a cap, readSessionContent returns every
 * event after the last user message and the card blows past Feishu's 28KB
 * budget.
 */
const COMPLETION_NOTIFICATION_MAX_EVENTS = 5;

/**
 * runner 缓存的工作区数量上限：超过后创建新工作区槽位时
 * 顺带回收「非 active 且进程已停」的死缓存，防止随访问过的工作区数量
 * 无界增长。活进程/在途 run 一律保留（workspace-lifetime 长驻连接不能误杀）。
 */
const MAX_CACHED_RUNNER_WORKSPACES = 10;

/**
 * Max idle time (no stdout events) before a claude run is considered hung
 * (§9.12). When this fires the bridge calls `runner.stop()` to unblock the
 * serial queue — otherwise a single hung run would block every subsequent
 * message forever.
 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 401 终态的恢复指引。只追加到 errorMsg 文本上，不动最终回答卡片结构
 * （仓库对 run-card 有硬闸）。用户看到的是「发生了什么 + 下一步做什么」，
 * 而不是一句裸的 401 后面继续 auto-resume 同一个死会话。
 */
const CODEBUDDY_AUTH_RECOVERY_HINT =
  '\n\n【已自动重置】登录态或区域已失效：旧会话、模型目录与长驻连接均已清除。' +
  '\n区域正在后台重新判定，下一条消息会新建会话并自动使用判定结果。' +
  '\n若仍失败，请在终端执行 codebuddy /login 重新登录；也可在 /config 的「区域」里手动选 internal / external 锁定端点。' +
  '\n重新打开 /config 可刷新模型列表。';

/**
 * 完成通知卡的标题 / 配色 / 结果行。
 *
 * 这张卡只在流式卡失败（settle==='unsent'）时补发，但终态必须如实反映：
 * 写死「✅ 会话已完成」会把出错/中断的 run 报成成功。
 */
function completionNotificationPresentation(terminal: RunTerminal): {
  title: string;
  template: string;
  result?: string;
} {
  switch (terminal) {
    case 'error':
      return { title: '⚠️ 会话出错', template: 'red' };
    case 'interrupted':
      return { title: '⏹ 会话已中断', template: 'grey' };
    case 'idle_timeout':
      return { title: '⏱ 会话已超时', template: 'orange' };
    case 'goal_continuing':
      return { title: '⏳ 本轮结束，目标继续', template: 'orange' };
    case 'finalizing':
      return { title: '⏳ 会话仍在收尾', template: 'orange' };
    case 'running':
      return { title: '🔴 会话运行中', template: 'blue' };
    case 'done':
      return { title: '✅ 会话已完成', template: 'green', result: 'completed' };
  }
}

// --- approvalModeSettingsFor 的逐 agent 快照（字段口径单表 + 单函数） ---
// Map 查表避免 constructor/toString 之类键命中 Object.prototype；字段顺序
// 与原 switch 分支逐字一致。不碰 Bridge 实例状态，避免 this 绑定问题。

/** 各 agent 审批设置快照的字段口径（顺序 = 原分支逐字）。 */
const APPROVAL_SETTINGS_FIELDS = new Map<AgentKind, readonly string[]>([
  ['codex', ['approvalPolicy', 'sandbox']],
  ['kimi', ['permissionMode']],
  ['opencode', ['mode']],
  ['dsh', ['permissionPreset']],
]);

function approvalSettingsFor(
  agents: AppConfig['agents'],
  kind: AgentKind,
): Record<string, unknown> | undefined {
  const fields = APPROVAL_SETTINGS_FIELDS.get(kind);
  if (!fields) return undefined;
  const cfg = agents?.[kind as 'codex' | 'kimi' | 'opencode' | 'dsh'] as
    Record<string, unknown> | undefined;
  if (!cfg) return undefined;
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = cfg[field];
  return out;
}

// --- runAgentStreamToEnd 的模块级原语与状态容器 ---
// 闭包/纯计算抽到模块顶层（显式传状态），不碰 Bridge 私有成员、无 this 绑定问题。

type UsageAuthority = 'live' | 'jsonl';

/** runner 是否使用 live result 事件（显式传 runner + usageAuthority 状态）。 */
function computeLiveResultEvents(
  runner: Runner,
  usageAuthority: UsageAuthority | undefined,
): boolean {
  return (runner as AgentRunner).usesLiveResultEvents?.() ?? usageAuthority === 'live';
}

/** 待审批计数（startIdleWatchdog 的 pendingApprovals 回调，显式传 coordinators 表）。 */
function pendingApprovalCount(
  coordinators: Map<string, ApprovalCoordinator>,
  runId: string,
): number {
  return coordinators.get(runId)?.pendingCount() ?? 0;
}

/** 事件循环的可变状态（跨 executeStream / handleStreamFailure / cleanupStream 共享）。 */
interface StreamRunState {
  watchdog: IdleWatchdog | null;
  sawResult: boolean;
  sawAnyResult: boolean;
  pendingPreInitTerminal: { subtype: 'error' | 'interrupted'; errorMessage?: string } | undefined;
}

/** 一次 agent stream run 的全部入参 + 运行期状态（显式打包传状态）。 */
interface AgentStreamRun {
  runner: Runner;
  cardSession: RunCardSession;
  activeRun: ActiveRun;
  sessionId: string | undefined;
  sessionEpochAtStart: number;
  ctx: CommandContext;
  cwd: string;
  runId: string;
  message: string;
  agentKind: AgentKind;
  usage: RunUsageCollector;
  usageAuthority: UsageAuthority | undefined;
  liveResultEvents: boolean;
  state: StreamRunState;
}

/**
 * Seam (§7): the channel capabilities the bridge needs. `sendWithRetry` is
 * the minimum a Feishu channel must offer for the bridge to push messages
 * through it. Declared here so tests can satisfy it structurally without
 * `as unknown as` casts.
 */
export interface BridgeChannel extends RunCardChannel {
  sendWithRetry(
    chatId: string,
    input: { text: string } | { markdown: string } | { card: object },
    opts?: { replyTo?: string },
  ): Promise<string>;
  sendFile(chatId: string, filePath: string): Promise<string>;
  addReaction(messageId: string, emoji: string): Promise<void>;
  removeReactionByEmoji(messageId: string, emoji: string): Promise<void>;
}

/**
 * 终态卡的渲染快照：run 结束后唯一还能改这张卡的地方。
 *
 * 后台任务的生命周期跨 turn，卡片收尾只是"这一轮的投影结束了"，任务本身还在
 * 跑；订阅拿到新名单后必须按 runId 找回同一张卡（state + 渲染选项 + 消息 id）。
 */
export interface RunCardSnapshot {
  state: RunState;
  options: RunCardRenderOptions;
  cwd: string;
  agentKind: AgentKind;
  /**
   * 这张终态卡的消息 id。缺失（流式卡没建起来、走了兜底纯发送）时后台任务
   * 订阅无法落地——宁可退化成收尾快照，也不能凭空补发一张新卡。
   */
  messageId?: string;
}

/** Caller context shared by bridge operations and router command handling. */
export interface CommandContext {
  userId: string;
  chatId: string;
  messageId: string;
  /**
   * 本轮（装配窗口）全部入站 messageId，`messageId` 是其中最后一条。
   * 只有走入站装配器的路径会填；卡片动作等单消息路径留空，收尾退化为只处理
   * `messageId`。缺它会导致合并轮次里先到的消息挂着 Typing 不撤。
   */
  turnMessageIds?: string[];
}

/** A sendable result payload returned by a command handler. */
export interface CommandResult {
  text?: string;
  markdown?: string;
  card?: object;
}

/** Detailed result of one interrupt, for callers that must not over-promise. */
export interface InterruptOutcome {
  stopped: boolean;
  /** 本次实际停掉的 run 数（activeRuns + bash）。多个 workspace 并行时可能 >1。 */
  stoppedCount?: number;
  agentKind?: AgentKind;
  /** Present for DSH: what the remote stop actually achieved. */
  stop?: StopOutcome;
}

export interface ActiveRunSnapshot {
  runId: string;
  userId: string;
  chatId: string;
  cwd: string;
  sessionId?: string;
  terminal: RunTerminal;
  contextLength?: number;
  compactCount?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface BridgeDeps {
  connector: BridgeChannel;
  sessionStore: SessionStore;
  config: AppConfig;
  /** Workspace store for fallback when sessionStore has no cwd */
  workspaceStore?: {
    get(name: string): string | undefined;
    list(): Array<{ name: string; path: string; lastUsedAt: number }>;
  };
  /** Override the idle watchdog timeout (default 15 min). Tests use a small value. */
  idleTimeoutMs?: number;
  /**
   * Multi-agent registry. `getRunner(cwd)` looks up
   * `config.defaultAgent` here.
   */
  agentRegistry: AgentRegistry;
  /**
   * Session reader registry. Used by `resolveFinalUsage` and
   * `sendCompletionNotificationCard` to read session content via
   * `registry.get(config.defaultAgent)`.
   */
  sessionReaderRegistry: SessionReaderRegistry;
  /**
   * CodeBuddy 会话根目录（默认 `~/.codebuddy`）。测试注入临时目录，
   * 避免读到真实家目录里的会话文件。
   */
  codebuddyHome?: string;
}

export interface ActiveRun {
  runId: string;
  userId: string;
  chatId: string;
  session: RunCardSession;
  cwd: string;
  /**
   * The exact runner instance that is running this run. interruptCurrentRun
   * stops THIS instance directly rather than re-resolving via getRunner(cwd),
   * so the runner is reachable even after clearRunners() empties the cache
   * mid-run (a fresh empty runner's stop() was a no-op,
   * leaving the real subprocess alive and the queue chain blocked forever).
   */
  runner: Runner;
  /**
   * The agent kind that this run started with. The runner cache is keyed by
   * (cwd, agentKind); eviction must use THIS kind, not `this.config.defaultAgent`
   * at eviction time. Otherwise switching defaultAgent mid-run
   * (via `/config`, whose clearRunners skips the active cwd) makes finalizeRun
   * delete the wrong slot — the original agent's runner lingers in the cache
   * with a stale config snapshot.
   */
  agentKind: AgentKind;
  /**
   * Session id this run actually used (from system.init / turn_started).
   * Immutable run identity for final usage: a mid-run /new //resume //cd moves
   * the global session pointer, so reading `sessionStore.getSessionId()` at the
   * end attributes another session's tokens to this run.
   */
  sessionId?: string;
}

/** `startIdleWatchdog` 的句柄：事件到达时 `touch()`，流结束/收尾时 `stop()`。 */
export interface IdleWatchdog {
  touch(): void;
  stop(): void;
}

/**
 * Bridge owns the per-workspace serial processing queue (§9.6) and the
 * single-card streaming forwarding loop (§9.12 watchdog + session sync).
 *
 * The router delegates non-command messages here via `forwardToClaude` and
 * sends command results via `sendResult`. Serial processing is enforced per
 * cwd by `enqueue`: each cwd has its own Promise chain, so at
 * most one agent process runs per cwd at a time, while different
 * workspaces run in parallel (see `activeRuns`, §9.6). This is a load-bearing
 * invariant — concurrent spawns within one cwd would corrupt session
 * state. Most card actions go through `enqueueImmediate` (fire-and-forget,
 * outside the serial chain); only run-forwarding is serialized.
 *
 * The idle watchdog (§9.12) is also load-bearing: without it a hung agent
 * process would block its workspace's serial queue forever. Both invariants
 * now have a single owner (this class) and a test surface via the
 * Runner/BridgeChannel seams.
 */
export class Bridge {
  /** 飞书连接通道（public：集成测试的 seam，替代 as unknown as 访问）。 */
  connector: BridgeChannel;
  /** 会话存储（public：测试辅助读取/写入 cwd 等，替代私有访问）。 */
  sessionStore: SessionStore;
  private config: AppConfig;
  private workspaceStore?: {
    get(name: string): string | undefined;
    list(): Array<{ name: string; path: string; lastUsedAt: number }>;
  };
  private idleTimeoutMs: number;
  /** Multi-agent registry. */
  private agentRegistry: AgentRegistry;
  /** Session reader registry for usage and completion cards. */
  private sessionReaderRegistry: SessionReaderRegistry;
  /** 入站媒体（图片/文件）落盘 + 合批提示。 */
  private readonly mediaHandler: InboundMediaHandler;
  /**
   * Per-workspace runner instances, keyed by (cwd, agentKind).
   * Each agentKind has its own cache slot, so switching
   * defaultAgent creates a NEW runner without evicting the old one. This
   * eliminates the need for clearRunners() on agent switch, preventing the
   * regression where clearRunners() orphaned a running subprocess and
   * blocked the queue forever.
   */
  private runners = new Map<string, Map<AgentKind, Runner>>();
  /**
   * Runner 槽位在「活跃运行期间配置变更」时被标 stale：clearRunners() 对
   * 活跃 cwd 只标 stale、不立即 evict（避免误杀长驻连接），当前 run 结束后由
   * finalizeRun 安全 evict+dispose，下一轮 getRunner 创建新配置的 runner。
   * key 为 `${cwd}\u0000${agentKind}`。
   */
  private staleRunnerSlots = new Set<string>();
  /** Queue manager for per-workspace serial processing queue. */
  /** 普通消息队列管理器（public：测试注入 queue-card 状态用）。 */
  queueManager: QueueManager;
  /** Active runs per cwd (cwd). Multiple workspaces can run in parallel. */
  private activeRuns = new Map<string, ActiveRun>();
  /** Approval coordinators keyed by runId. */
  private approvalCoordinators = new Map<string, ApprovalCoordinator>();
  /** 审批卡动作的实现（只读上面那张表；见 approval-actions.ts）。 */
  private approvalActions = new ApprovalActions({
    coordinatorFor: (runId) => this.approvalCoordinators.get(runId),
  });
  /**
   * Compact 生命周期（见 compact.ts）：可压缩 run 记账、终态卡 / resume 卡
   * 两条 Compact 入口、kimi 在途检测与压缩流式卡。activeRuns 槽位表按引用
   * 共用——压缩注册前确认槽位空闲，否则 /stop 停错对象。
   */
  private readonly compact: CompactLifecycle;

  /**
   * 终态卡片的渲染快照（runId → state + options）：run 结束后 activeRuns 已
   * 清空，而卡片上的「⏹ 停止」后台任务按钮（job.kill）还活着，需要按 runId
   * 反查该 run 的 sessionId/cwd 才能停对任务。只保留最近若干条：单条快照受
   * MAX_BLOCKS 约束（几十 KB 以内），用户只会点刚收到的卡；超出窗口的旧卡
   * 会得到明确的「记录已回收」提示，不假装任务仍在。
   */
  private runCardSnapshots = new Map<string, RunCardSnapshot>();
  private static readonly RUN_CARD_SNAPSHOT_MAX = 8;

  /**
   * 终态卡后台任务订阅与停止（见 job-watch.ts）：job.kill、名单订阅与
   * PATCH 串行链收在该模块；jobCardPatches 链内渲染读 snapshot.state，
   * 「停止」与「订阅帧」并发不会把卡片写回旧内容。
   */
  private readonly jobWatch: JobWatchLifecycle;

  /**
   * `!` bash 命令执行（见 bash-run.ts）：独立 runId 空间、独立登记表，不进
   * activeRuns；绝不 re-chain 到 QueueManager（会自等待死锁）。/stop 的 bash
   * 侧匹配与中断也收在该模块，避免误杀并行跑的 `!` 任务。
   */
  private readonly bashRuns: BashRunLifecycle;

  /**
   * 宿主轮次的 stop（见 host-stop.ts）：恢复会话 / 上一个实例留下的 turn
   * 没有本地 activeRun，但 DSH 仍认 sessionId。`/stop` 的 fallback 与恢复卡
   * 「终止」按钮共用这一条路径。
   */
  private readonly hostStop: HostTurnStop;
  /**
   * CodeBuddy 会话根目录（默认 `~/.codebuddy`）。生产恒为默认值；测试注入
   * 临时目录，避免读写真实家目录。
   */
  private readonly codebuddyHome?: string;

  constructor(deps: BridgeDeps) {
    this.connector = deps.connector;
    this.sessionStore = deps.sessionStore;
    this.config = deps.config;
    this.workspaceStore = deps.workspaceStore;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.agentRegistry = deps.agentRegistry;
    this.sessionReaderRegistry = deps.sessionReaderRegistry;
    this.codebuddyHome = deps.codebuddyHome;

    this.queueManager = new QueueManager(
      (cwd) => this.activeRuns.has(cwd),
      (chatId, card, opts) =>
        this.connector.sendWithRetry(chatId, { card }, { replyTo: opts?.replyTo }),
      (messageId, card) => this.connector.updateCard(messageId, card),
    );
    this.mediaHandler = new InboundMediaHandler({
      resolveCwd: (userId) => this.resolveCwd(userId),
      getConfig: () => this.config,
    });
    this.compact = new CompactLifecycle({
      activeRuns: this.activeRuns,
      connector: this.connector,
      sessionStore: this.sessionStore,
      sessionReaderRegistry: this.sessionReaderRegistry,
      getConfig: () => this.config,
      getRunner: (cwd, kind, opts) => this.getRunner(cwd, kind, opts),
      sendResult: (result, ctx, opts) => this.sendResult(result, ctx, opts),
      startIdleWatchdog: (opts) => this.startIdleWatchdog(opts),
      finishTurnReactions: (ctx, emoji) => this.finishTurnReactions(ctx, emoji),
      resolveCwd: (userId) => this.resolveCwd(userId),
    });
    this.jobWatch = new JobWatchLifecycle({
      getRunner: (cwd, kind) => this.getRunner(cwd, kind),
      getRunCardSnapshot: (runId) => this.runCardSnapshots.get(runId),
      updateCardInPlace: (card, ctx) => this.updateCardInPlace(card, ctx),
      patchCard: (messageId, card) => this.patchCard(messageId, card),
    });
    this.bashRuns = new BashRunLifecycle({
      connector: this.connector,
      sessionStore: this.sessionStore,
      resolveCwd: (userId) => this.resolveCwd(userId),
      sendResult: (result, ctx) => this.sendResult(result, ctx),
      finishTurnReactions: (ctx, emoji) => this.finishTurnReactions(ctx, emoji),
    });
    this.hostStop = new HostTurnStop({
      sessionStore: this.sessionStore,
      sessionReaderRegistry: this.sessionReaderRegistry,
      getConfig: () => this.config,
      getRunner: (cwd, kind, opts) => this.getRunner(cwd, kind, opts),
      sendResult: (result, ctx) => this.sendResult(result, ctx),
    });
  }

  /**
   * Get or create a runner for the given cwd, keyed by current defaultAgent.
   *
   * Cache key includes agentKind, so switching defaultAgent
   * creates a NEW runner under a different key without evicting the old one.
   * This eliminates the need for clearRunners() on agent switch.
   */
  private getRunner(
    cwd: string,
    kind: AgentKind = this.config.defaultAgent,
    opts?: {
      /**
       * 「这一轮即将开跑」：槽位被标 stale 且当前没有活跃 run 时，先 evict 旧
       * 实例再新建。用于让 `/config` 变更（clearRunners 标 stale）不被中断路径
       * 拖成「下一轮仍用旧配置」——旧实现只靠 finalizeRun 的守卫消费 stale，
       * 而 `/stop` 会先摘槽位让守卫失效，stale 便留到再下一轮。
       *
       * 仅在开跑路径（forwardToClaude / streamCompact）与宿主轮次的 stop
       * 传 true：hasRunCompact、killBackgroundJob 这类「借 runner 看一眼」
       * 的调用不能触发实例替换。
       */
      replaceStale?: boolean;
    },
  ): Runner {
    // Fix 4: Check for runner under (cwd, kind) key
    const workspaceMap = this.runners.get(cwd);
    const slotKey = `${cwd}\u0000${kind}`;
    const cached = workspaceMap?.get(kind);
    // 活跃 run 期间不替换：queue 链可能在 interrupt 的 await 窗口里推进，把
    // 正在跑的那一轮手里的实例换掉会脱管长驻连接。
    const replaceStaleInstance =
      cached !== undefined &&
      opts?.replaceStale === true &&
      this.staleRunnerSlots.has(slotKey) &&
      !this.activeRuns.has(cwd);
    if (cached && !replaceStaleInstance) {
      return cached;
    }
    if (replaceStaleInstance) {
      getLogger().info(`[lark-remote] replace stale runner before run cwd=${cwd} kind=${kind}`);
      this.evictRunnerSlot(cwd, kind);
    }

    // 缓存超过上限且是新工作区时才回收死槽位——刚创建未 run
    // 的 runner 同样是 isRunning=false，小缓存下立即回收会破坏「创建即注册」
    // 的既有语义（exit-dispatcher 计数回归）。
    if (this.runners.size >= MAX_CACHED_RUNNER_WORKSPACES && !this.runners.has(cwd)) {
      for (const [cwd, slotMap] of [...this.runners.entries()]) {
        if (this.activeRuns.has(cwd)) continue;
        for (const [slotKind, r] of [...slotMap.entries()]) {
          if (!r.isRunning) {
            this.evictRunnerSlot(cwd, slotKind);
          }
        }
      }
    }

    // Create new runner for this (cwd, kind) slot
    const runner = this.agentRegistry.get(kind, cwd);
    runner.killOrphan();
    runner.registerExitHandlers();

    // Store in nested map: Map<cwd, Map<kind, Runner>>。必须重新取一次：
    // replaceStale 刚把槽位 evict 掉，上面的局部 workspaceMap 可能已随空槽
    // 从 this.runners 移除——继续写它会生成一个「缓存里查不到」的 runner，
    // 下一次 getRunner 会再建一个（实例数翻倍）。
    const currentWorkspaceMap = this.runners.get(cwd);
    if (!currentWorkspaceMap) {
      this.runners.set(cwd, new Map([[kind, runner]]));
    } else {
      currentWorkspaceMap.set(kind, runner);
    }
    return runner;
  }

  /** Update the config reference (call after `/config set` reloads). */
  setConfig(config: AppConfig): void {
    this.config = config;
    // 同步更新 registry 的 configContainer，让 factory 能读取最新 config
    const container = this.agentRegistry.getConfigContainer();
    if (container) {
      container.current = config;
    }
  }

  /**
   * Push updated approval-mode settings to active workspace-lifetime runners.
   * `clearRunners()` deliberately skips workspaces with active runs; this
   * gives those runners a chance to apply the new settings immediately via
   * the unified duck method `updateApprovalMode` (codex → thread/settings/
   * update, kimi → session/set_mode, opencode → session/set_mode) instead of
   * keeping a stale snapshot until the runner is evicted/recreated.
   */
  syncActiveApprovalModes(): void {
    for (const [cwd, active] of this.activeRuns) {
      const runner = active.runner as AgentRunner;
      if (typeof runner.updateApprovalMode !== 'function') continue;
      const settings = this.approvalModeSettingsFor(active.agentKind);
      if (!settings) continue;
      void runner.updateApprovalMode(settings).catch((err: Error) => {
        getLogger().warn(`[lark-remote] sync approval mode failed cwd=${cwd}: ${err.message}`);
      });
    }
  }

  /** Per-agent approval-mode settings snapshot from the current config. */
  private approvalModeSettingsFor(kind: AgentKind): Record<string, unknown> | undefined {
    return approvalSettingsFor(this.config.agents, kind);
  }

  /** Get the current runner for a cwd. Used by router for agent-specific commands (.2). */
  getCurrentRunner(cwd: string): AgentRunner {
    return this.getRunner(cwd) as AgentRunner;
  }

  /**
   * Whether the runner for the given agent kind has runCompact capability.
   * Used by router for compact button gating (duck-typing
   * instead of hardcoding agentKind === 'codex').
   */
  hasRunCompact(cwd: string, kind: AgentKind = this.config.defaultAgent): boolean {
    const runner = this.getRunner(cwd, kind);
    return runnerSupportsCompact(runner, kind);
  }

  /** 入队时刻快照：当前 defaultAgent + 该 agent 的 sessionId（无 session 则 undefined）。
   *  唯一捕获点：排队消息在入队时刻把 agent+session 钉进 AgentBinding，随任务闭包带到执行时刻
   *  执行时刻，避免 /new、/config 在排队期间改写 live 状态导致语义漂移。 */
  currentBinding(userId: string): AgentBinding {
    const agent = this.config.defaultAgent;
    return {
      agent,
      sessionId: this.sessionStore.getSessionId(userId, agent),
      sessionEpoch: this.sessionStore.getSessionEpoch(userId, agent),
    };
  }

  /**
   * Clear all cached runner instances. Call after config changes that affect runner config.
   */
  clearRunners(): void {
    // Skip workspaces with an active run: evicting their runner would orphan
    // the instance that owns the live subprocess — the running runner would
    // become unreachable, stop() would hit a fresh empty runner, the real
    // subprocess would never be killed and the queue chain would block forever.
    // The running run already started with its (possibly now-stale) config, so
    // keeping it is correct; finalizeRun deletes the cache entry when the run
    // ends, and the next run picks up the new config/agent via getRunner.
    for (const cwd of [...this.runners.keys()]) {
      if (this.activeRuns.has(cwd)) {
        // 活跃 cwd 不能立即 evict（会误杀长驻连接），但必须标记 stale，
        // 否则 finalizeRun 对 workspace-lifetime runner 也不 evict → 下一轮复用旧配置实例。
        // 这里只标待淘汰，当前 run 结束后由 finalizeRun 安全 evict。
        for (const kind of [...this.runners.get(cwd)!.keys()]) {
          this.staleRunnerSlots.add(`${cwd}\u0000${kind}`);
        }
        continue;
      }
      for (const kind of [...this.runners.get(cwd)!.keys()]) {
        this.evictRunnerSlot(cwd, kind);
        this.staleRunnerSlots.delete(`${cwd}\u0000${kind}`);
      }
    }
  }

  /**
   * Evict a (cwd, agentKind) runner cache slot. Unregisters the runner from the
   * process-level exit dispatcher first (without removal the singleton
   * Set<Runner> retains every historical runner instance, so memory still grows
   * with run count), then deletes the slot. Every runner-discarding path
   * (clearRunners / finalizeRun / interruptCurrentRun) must go through this.
   */
  private evictRunnerSlot(cwd: string, kind: AgentKind): void {
    const workspaceMap = this.runners.get(cwd);
    if (!workspaceMap) return;
    const evicted = workspaceMap.get(kind);
    if (evicted && typeof evicted.unregisterExitHandlers === 'function') {
      evicted.unregisterExitHandlers();
    }
    // 先标记 orphan 再 dispose：evict 与「run 刚拿走本实例」竞态时
    // （queue 链在 interruptCurrentRun await 期间推进），dispose 只能关掉当时
    // 已存在的连接，run 后续 acquire 的新连接会挂在无人托管的实例上——orphan
    // 标记让 executeTurn 在 run 结束时主动 dispose 这批连接，而不是挂 idle
    // timer 等待 30 分钟（期间持有 agent 侧会话写锁，codex 报
    // "thread already has an active writer"）。鸭子探测与 dispose/unregister
    // 一致：claude（stream-json，无长驻连接）无此方法，跳过。
    if (
      evicted &&
      typeof (evicted as unknown as { markOrphaned?: () => void }).markOrphaned === 'function'
    ) {
      (evicted as unknown as { markOrphaned: () => void }).markOrphaned();
    }
    // App-server runner owns a persistent connection — dispose it so the
    // `codex app-server` child process does not leak across runs/evictions.
    if (evicted && typeof evicted.dispose === 'function') {
      void evicted.dispose();
    }
    workspaceMap.delete(kind);
    this.staleRunnerSlots.delete(`${cwd}\u0000${kind}`);
    if (workspaceMap.size === 0) {
      this.runners.delete(cwd);
    }
  }

  /**
   * Update the idle watchdog window at runtime.
   * Called by router constructor and `config.save` (when `idle.watchdogMinutes` changes
   * via `/config` card). The idle interval reads `this.idleTimeoutMs` live on every
   * tick, so the new threshold takes effect immediately for any in-flight run —
   * there is no per-event timer to reset.
   */
  setIdleTimeout(ms: number): void {
    this.idleTimeoutMs = ms;
  }

  /**
   * Extract agent-specific run options from config.
   * Returns model/effort/etc. based on current defaultAgent.
   */
  /** 解析某 agent 的 run 选项（forwardToClaude 用；测试直接调用的 seam）。 */
  getAgentRunOptions(agent: AgentKind = this.config.defaultAgent): {
    model?: string;
    effort?: string;
    thinking?: string;
    reasoningEffort?: string;
  } {
    const agents = this.config.agents;
    const result: { model?: string; effort?: string; thinking?: string; reasoningEffort?: string } =
      {};

    switch (agent) {
      case 'claude':
        // Claude uses top-level claude config
        if (this.config.claude) {
          if (this.config.claude.model) result.model = this.config.claude.model;
          if (this.config.claude.effort) result.effort = this.config.claude.effort;
        }
        break;
      case 'codex':
        if (agents?.codex?.model) result.model = agents.codex.model;
        if (agents?.codex?.reasoningEffort) result.reasoningEffort = agents.codex.reasoningEffort;
        break;
      case 'pi':
        if (agents?.pi?.model) result.model = agents.pi.model;
        if (agents?.pi?.thinking) result.thinking = agents.pi.thinking;
        break;
      case 'opencode':
        // opencode model is set as provider/model in the constructor (defaultModel);
        // returning bare modelID here would override it with a provider-less string.
        break;
      case 'qoder':
        // qoder 与 codex 同字段：reasoningEffort 走 SpawnOptions.reasoningEffort，
        // session buildArgv 落到 --reasoning-effort；没有这个 case 时配置卡选的
        // 模型只进 /status 展示、永远到不了 CLI（2026-11-05 实测缺口）。
        if (agents?.qoder?.model) result.model = agents.qoder.model;
        if (agents?.qoder?.reasoningEffort) result.reasoningEffort = agents.qoder.reasoningEffort;
        break;
    }

    return result;
  }

  /**
   * Enqueue a task into the workspace-level serial bridge queue.
   * Delegates to QueueManager for actual implementation.
   */
  enqueue(cwd: string, task: () => Promise<void>, opts?: EnqueueOptions): void {
    this.queueManager.enqueue(cwd, task, opts);
  }

  /**
   * Execute a task immediately without going through the queue.
   * Used for / commands that should respond immediately.
   */
  enqueueImmediate(cwd: string, task: () => Promise<void>): void {
    this.queueManager.enqueueImmediate(cwd, task);
  }

  /** Get queue info for a cwd. */
  getQueueInfo(cwd: string): { position: number; tasksAhead: number; isRunning: boolean } {
    return this.queueManager.getQueueInfo(cwd);
  }

  /**
   * lane 当前占用者的展示信息（排队卡与「立即执行」守卫共用）。
   * 典型用途：占用者是 Compact 时拒绝 queue.immediate，避免中断压缩。
   */
  getQueueExecutingInfo(cwd: string): ExecutingInfo | undefined {
    return this.queueManager.getExecutingInfo(cwd);
  }

  /** Remove a task from the queue by messageId. Returns true if found and removed. */
  removeFromQueue(cwd: string, messageId: string): boolean {
    const removed = this.queueManager.removeFromQueue(cwd, messageId);
    // 单一收口：撤销卡片跟着移除动作一起发生，不再依赖调用方记得配对调
    // updateQueueCardToCancelled（漏配对会让卡片永久停在「等待中」，而映射
    // 已被消费，之后再也修不回来）。fire-and-forget 保持
    // 「移除同步发生」的队列不变式——queue.immediate 依赖先清空再让出事件循环。
    if (removed) {
      void this.updateQueueCardToCancelled(cwd, messageId);
    }
    return removed;
  }

  /**
   * One-shot: replace the execution closure of an existing queued task in
   * place, preserving its queue position. Used by queue.immediate after the
   * user edits a queued message (see router handleQueueImmediate).
   */
  setTaskReplacement(cwd: string, messageId: string, task: () => Promise<void>): void {
    this.queueManager.setTaskReplacement(cwd, messageId, task);
  }

  /**
   * One-shot: hold the target's run-card start until the returned release is
   * called. queue.immediate uses it so its final toast is sent before the run
   * card — the toast would otherwise be the newest message and the chat list
   * would stop previewing the run card's title changes. The queue slot itself
   * still begins normally; only run-card creation waits (see
   * QueueManager.holdTaskRunStart).
   */
  holdQueueTaskRun(cwd: string, messageId: string): () => void {
    return this.queueManager.holdTaskRunStart(cwd, messageId);
  }

  /** Update queue card to "cancelled" status when user clicks 撤销. */
  async updateQueueCardToCancelled(cwd: string, messageId: string): Promise<void> {
    await this.queueManager.updateQueueCardToCancelled(cwd, messageId);
  }

  /** Mark a queued task's card as executing immediately (grey out buttons).
   *  Called by handleQueueImmediate so the user sees feedback right away
   *  instead of waiting for the queue callback. Idempotent: the queue
   *  callback's own updateQueueCardToExecuting call becomes a no-op because
   *  updateQueueCardToExecuting deletes the card-message mapping in finally. */
  async markQueueCardExecuting(cwd: string, messageId: string): Promise<void> {
    const task = this.getQueuedTask(cwd, messageId);
    await this.queueManager.updateQueueCardToExecuting(
      cwd,
      messageId,
      task?.messagePreview ?? '',
      false,
    );
  }

  /** Get task metadata from queue. */
  getQueuedTask(cwd: string, messageId: string): QueuedTask | undefined {
    return this.queueManager.getQueuedTask(cwd, messageId);
  }

  /**
   * Whether a task with the given messageId has begun executing and has not
   * settled yet. Lets handleQueueImmediate's final feedback distinguish a
   * target that was cancelled from one that began while the interrupt was in
   * flight (the latter is already running, so the toast must not claim
   * "未安排执行").
   */
  hasTaskBegan(messageId: string): boolean {
    return this.queueManager.hasBegan(messageId);
  }

  /** Get all queued tasks for a cwd. Returns a copy to prevent aliasing bugs. */
  getQueuedTasks(cwd: string): QueuedTask[] {
    return this.queueManager.getQueuedTasks(cwd);
  }

  /**
   * Update the messagePreview for a queued task and build the updated queue
   * card. Returns the card object to send back as the cardAction callback
   * response (Feishu renders it in place), or null if the task is no longer
   * queued. Returning the card via the callback response avoids the
   * PATCH-vs-callback-response race that left the card stuck in edit state.
   */
  async updateMessagePreview(
    cwd: string,
    messageId: string,
    newMessage: string,
  ): Promise<object | null> {
    const updated = this.queueManager.updateQueuedTaskMessage(cwd, messageId, newMessage);
    if (!updated) return null;
    return this.queueManager.buildQueueCardForEdit(cwd, messageId, newMessage);
  }

  /** Whether a claude run is currently in progress in the given cwd. */
  isBusyFor(cwd: string): boolean {
    return this.activeRuns.has(cwd);
  }

  getActiveRunFor(cwd: string): ActiveRunSnapshot | undefined {
    const active = this.activeRuns.get(cwd);
    if (!active) return undefined;
    const state = active.session.currentState;
    return {
      runId: active.runId,
      userId: active.userId,
      chatId: active.chatId,
      cwd: active.cwd,
      sessionId: state.sessionId,
      terminal: state.terminal,
      contextLength: state.contextLength,
      compactCount: state.compactCount,
      cacheReadTokens: state.cacheReadTokens,
      cacheCreationTokens: state.cacheCreationTokens,
    };
  }

  /** Whether any claude run is currently in progress (any cwd). */
  get isBusy(): boolean {
    return this.activeRuns.size > 0;
  }

  /** Get all active runs across all workspaces. */
  getAllActiveRuns(): Map<string, { runId: string; userId: string; chatId: string; cwd: string }> {
    const result = new Map<
      string,
      { runId: string; userId: string; chatId: string; cwd: string }
    >();
    for (const [cwd, active] of this.activeRuns) {
      result.set(cwd, {
        runId: active.runId,
        userId: active.userId,
        chatId: active.chatId,
        cwd: active.cwd,
      });
    }
    return result;
  }

  /** Get all active runs with their state for /active command (memory-based). */
  getActiveRuns(): Array<{
    runId: string;
    sessionId: string;
    cwd: string;
    userId: string;
    chatId: string;
    terminal: RunTerminal;
  }> {
    const result: Array<{
      runId: string;
      sessionId: string;
      cwd: string;
      userId: string;
      chatId: string;
      terminal: RunTerminal;
    }> = [];

    for (const [_cwd, active] of this.activeRuns) {
      const state = active.session.currentState;
      // Only include non-terminal runs
      if (isRunActive(state.terminal)) {
        result.push({
          runId: active.runId,
          sessionId: state.sessionId ?? '',
          cwd: active.cwd,
          userId: active.userId,
          chatId: active.chatId,
          terminal: state.terminal,
        });
      }
    }

    return result;
  }

  /** Get all active bash runs with their state for /active command. */
  getActiveBashRuns(): Array<{
    runId: string;
    cwd: string;
    userId: string;
    chatId: string;
    terminal: RunTerminal;
    command: string;
  }> {
    return this.bashRuns.getActiveBashRuns();
  }

  /**
   * Same as {@link interruptCurrentRun}, plus what the runner's stop actually
   * achieved. DSH returns a {@link StopOutcome} (withdrawn / cancelled /
   * unconfirmed); process runners and bash return none.
   *
   * Callers use `stop.status === 'unconfirmed'` to avoid promising "stopped" or
   * "executing immediately" when a turn may still be running in the host.
   */
  async interruptCurrentRunDetailed(input: {
    userId: string;
    chatId: string;
    runId?: string;
    /**
     * Card callback's server-provided message id. Used only as a narrow fallback
     * when the behavior-value runId is missing or stale: the clicked card must
     * be the one active run's card. A dashboard or historical card never matches.
     */
    cardMessageId?: string;
    cwd?: string;
  }): Promise<InterruptOutcome> {
    // 先收集全部命中项再逐个停。activeRuns 以 cwd 为键、多个 workspace 可以
    // 并行跑；旧实现停在「第一条命中」就 return —— 两个 workspace 并行时
    // `/stop` 只停一个却回「已停止」，另一个无声继续。
    // 限定 cwd（queue.immediate）或带 runId（停止卡按钮）时仍只有一条命中。
    const ownedActiveRuns: Array<[string, ActiveRun]> = [];
    for (const [cwd, active] of this.activeRuns) {
      if (input.cwd !== undefined && cwd !== input.cwd) continue;
      if (active.userId !== input.userId || active.chatId !== input.chatId) continue;
      ownedActiveRuns.push([cwd, active]);
    }
    // Card stop prefers the authoritative runId. If the click is scoped to a
    // run card but that value is stale/absent, accept only the active run whose
    // server-provided card messageId is exactly the clicked card. This repairs
    // callbacks that lose behavior-value without ever stopping a historical or
    // dashboard card against a newer run.
    let activeTargets: Array<[string, ActiveRun]>;
    if (input.runId) {
      activeTargets = ownedActiveRuns.filter(([, active]) => active.runId === input.runId);
      if (activeTargets.length === 0) {
        activeTargets = this.activeRunsForCard(ownedActiveRuns, input.cardMessageId);
      }
    } else if (input.cardMessageId) {
      activeTargets = this.activeRunsForCard(ownedActiveRuns, input.cardMessageId);
    } else {
      activeTargets = ownedActiveRuns;
    }
    let stoppedCount = 0;
    let agentKind: AgentKind | undefined;
    let stop: StopOutcome | undefined;
    for (const [cwd, active] of activeTargets) {
      const stopResult = await this.interruptActiveRun(cwd, active);
      stoppedCount++;
      agentKind ??= active.agentKind;
      // 聚合口径：只要有一次 remote stop 没能确认，就按「可能仍在跑」上报，
      // 不让后面的已确认结果盖掉它（调用方据此决定是否承诺"已停止"）。
      if (
        stopResult &&
        (stop === undefined ||
          (stop.status !== 'unconfirmed' && stopResult.status === 'unconfirmed'))
      ) {
        stop = stopResult;
      }
    }
    // Then check active bash runs (! commands). 实现在 bash-run.ts
    // （bridge 结构治理第 3 刀）：bash 用独立 runId 空间、独立登记表，匹配
    // 与停止整体收在 stopMatchingBashRuns 里——`/stop` 语义与「不误杀并行
    // `!` 任务」的守卫注释随迁。
    stoppedCount += await this.bashRuns.stopMatchingBashRuns(input, activeTargets.length);
    if (stoppedCount === 0) {
      getLogger().warn(
        `[lark-remote] interrupt miss userId=${input.userId} ` +
          `requestedRunId=${input.runId ?? '(none)'} ` +
          `cardMessageId=${input.cardMessageId ?? '(none)'} ` +
          `active=${ownedActiveRuns.map(([, active]) => active.runId).join(',') || '(none)'}`,
      );
      return { stopped: false };
    }
    return {
      stopped: true,
      stoppedCount,
      ...(agentKind ? { agentKind } : {}),
      ...(stop ? { stop } : {}),
    };
  }

  /**
   * Resolve a scoped card click by card identity. Empty input or multiple
   * matches fail closed; production message ids are unique, but refusing an
   * ambiguous stop is safer than killing several workspaces.
   */
  private activeRunsForCard(
    ownedActiveRuns: Array<[string, ActiveRun]>,
    cardMessageId: string | undefined,
  ): Array<[string, ActiveRun]> {
    if (!cardMessageId) return [];
    const matches = ownedActiveRuns.filter(
      ([, active]) => active.session.cardMessageId === cardMessageId,
    );
    if (matches.length === 0) return [];
    if (matches.length > 1) {
      getLogger().warn(
        `[lark-remote] interrupt ambiguous cardMessageId=${cardMessageId} ` +
          `active=${matches.map(([, active]) => active.runId).join(',')}`,
      );
      return [];
    }
    getLogger().warn(
      `[lark-remote] interrupt using active card fallback ` +
        `runId=${matches[0][1].runId} cardMessageId=${cardMessageId}`,
    );
    return matches;
  }

  /**
   * 停掉一条已注册的 active run：置终态、停 runner、摘槽位、标 stale、
   * 归零该 cwd 的队列执行计数。返回 runner 的停止结果（DSH 才有）。
   *
   * 只做「这一条 run」的事——跨多个 workspace 的遍历在调用方，避免再次
   * 出现「停第一条就 return」的漏停。
   */
  private async interruptActiveRun(
    cwd: string,
    active: ActiveRun,
  ): Promise<StopOutcome | undefined> {
    getLogger().info(
      `[lark-remote] interrupt hit runId=${active.runId} cwd=${cwd} userId=${active.userId}`,
    );
    // Stop the EXACT runner instance that is running (carried by activeRun),
    // not whatever getRunner(cwd) would return now. clearRunners() may have
    // emptied the cache mid-run, in which case getRunner creates a fresh empty
    // runner whose stop() is a no-op and the real subprocess is never killed,
    // blocking the queue chain forever.
    const runner = active.runner;
    // Bind the queue reset to THIS task's execution slot: the stop window
    // below may outlive the task's settle, letting the serial chain advance
    // to a successor that begins executing before we resume. An
    // unconditional reset would then zero the successor's count and mark
    // its slot interrupted, hiding it from queue cards.
    const stoppedSlot = this.queueManager.getExecutingSlot(cwd);
    const [finishResult, stopResult] = await Promise.allSettled([
      // 用户主动中断（/stop、stop 卡按钮、queue.immediate）显式打标
      // interruptedReason，与审批超时自动取消（approval_timeout）、审批
      // 卡取消（approval_cancelled）在终态数据上可区分（方案 A）。
      active.session.finish('interrupted', { interruptedReason: 'user_stop' }),
      runner.stop({ immediate: true }),
    ]);
    // allSettled 的两个结果都必须检查：finish 被飞书拒绝时卡片会永久停在
    // 「运行中」；runner.stop 失败时进程可能没死而槽位已被释放——两者都
    // 不能静默吞掉（此前第一个结果整体丢弃、stop 失败仍记 "stop done"）。
    if (finishResult.status === 'rejected') {
      getLogger().error(
        `[lark-remote] stop: terminal card finish failed runId=${active.runId}:`,
        finishResult.reason,
      );
    }
    let stop: StopOutcome | undefined;
    if (stopResult.status === 'rejected') {
      getLogger().error(
        `[lark-remote] stop: runner.stop failed runId=${active.runId} — 运行可能未终止:`,
        stopResult.reason,
      );
      // 上报「可能仍在跑」，调用方按 unconfirmed 口径聚合（不承诺已停止）。
      stop = { status: 'unconfirmed', detail: errorMessage(stopResult.reason) };
    } else {
      stop = stopResult.value ?? undefined;
    }
    // The chain may have advanced while the stop was in flight: a new run
    // (from a task that began during the stop window) may now occupy this
    // cwd. Only delete the entry we actually stopped.
    if (this.activeRuns.get(cwd) === active) {
      this.activeRuns.delete(cwd);
    }
    // Fix 4: Clean up this specific (cwd, agentKind) runner slot
    // (eviction must also unregister the runner from the exit dispatcher)
    // evict by the run's captured agentKind, not the live
    // defaultAgent (may have changed mid-run via /config).
    //
    // workspace-lifetime runner 不能在中断路径里立即 evict+dispose。
    // interruptCurrentRun 的 await 窗口内 queue 链会推进下一条消息，其
    // getRunner 可能刚拿走本实例（缓存命中先于本行执行）——立即 evict 会
    // 让那个 run 的长驻连接脱管：进程残留至 idle TTL 才回收，期间持有
    // agent 侧会话写锁（codex "thread already has an active writer"）。
    // 改为标 stale：下一次「即将开跑」的 getRunner 在槽位空闲时
    // 换新实例（见 getRunner 的 replaceStale），本次 run 的 finalize 收尾时
    // 也会消费该标记；两者都保证不会有活跃 run 使用被 dispose 的实例。
    // run-per-message runner 无长驻连接，保持立即 evict 不变。
    if (active.runner.lifetime === 'workspace') {
      this.staleRunnerSlots.add(`${cwd}\u0000${active.agentKind}`);
    } else {
      this.evictRunnerSlot(cwd, active.agentKind);
    }
    // Reset queue executing count: the task was interrupted externally, so
    // its promise-chain settle (.then/.catch) may lag behind the process
    // kill. Without this reset, subsequent messages would incorrectly show
    // as "排队中". resetExecutingCount also grants a skip-credit so the
    // stale settle does not double-decrement the count. Centralized here so
    // ALL interrupt paths (/stop, /t, card stop, queue.immediate) benefit.
    // When stoppedSlot is undefined (no active run matched), skip the reset —
    // there is no queue slot to reconcile. All production interrupt paths
    // (/stop, /t, card stop, queue.immediate) provide a defined stoppedSlot.
    if (stoppedSlot !== undefined) {
      this.queueManager.resetExecutingCount(cwd, stoppedSlot);
    }
    if (stop?.status !== 'unconfirmed') {
      getLogger().info(`[lark-remote] interrupt stop done runId=${active.runId}`);
    }
    return stop;
  }

  /**
   * Send a result message to the user (§7). Returns true on success, false on failure.
   *
   * `opts.onCardSent` 回传卡片的 messageId：终态卡收尾后还要靠它接收后台任务
   * 更新（流式卡从 `cardSession.cardMessageId` 取，兜底发送只能从这里拿）。
   */
  async sendResult(
    result: CommandResult,
    ctx: CommandContext,
    opts?: { onCardSent?: (messageId: string) => void },
  ): Promise<boolean> {
    try {
      if (result.card) {
        // 静态卡片体积保护：确保卡片不超过飞书大小限制
        const {
          card: safeCard,
          wasTruncated,
          reason,
          bytesBefore,
          bytesAfter,
        } = enforceCardBudget(result.card);

        if (wasTruncated) {
          getLogger().info(
            `[lark-remote] card size exceeded limit, applied budget enforcement: reason=${reason} bytesBefore=${bytesBefore} bytesAfter=${bytesAfter}`,
          );
        }

        getLogger().debug(`[lark-remote] sendResult kind=card chatId=${ctx.chatId}`);
        const messageId = await this.connector.sendWithRetry(
          ctx.chatId,
          { card: safeCard },
          { replyTo: ctx.messageId },
        );
        opts?.onCardSent?.(messageId);
        return true;
      } else if (result.markdown) {
        getLogger().debug(`[lark-remote] sendResult kind=markdown chatId=${ctx.chatId}`);
        await this.connector.sendWithRetry(
          ctx.chatId,
          { markdown: result.markdown },
          { replyTo: ctx.messageId },
        );
        return true;
      } else if (result.text) {
        getLogger().debug(`[lark-remote] sendResult kind=text chatId=${ctx.chatId}`);
        await this.connector.sendWithRetry(
          ctx.chatId,
          { text: result.text },
          { replyTo: ctx.messageId },
        );
        return true;
      }
      return false;
    } catch (err) {
      getLogger().error('[lark-remote] failed to send result:', err);
      // 不静默：向用户发送一条纯文本消息，告知具体错误（如飞书 11310 element exceeds
      // the limit）。如果用户看到空白无反馈，无法判断是命令无效还是卡片发送失败。
      try {
        const errMsg = (err as Error).message ?? String(err);
        await this.connector.sendWithRetry(
          ctx.chatId,
          { text: `⚠️ 卡片发送失败：${errMsg}` },
          { replyTo: ctx.messageId },
        );
      } catch (fallbackErr) {
        getLogger().error('[lark-remote] fallback text send also failed:', fallbackErr);
      }
      return false;
    }
  }

  /**
   * Deliver a final answer that cannot fit in the run card as a Markdown file
   * attachment. 卡片正文已被标记替代，文件是唯一的内容通道；此处绝不发纯文本
   * （纯文本与卡片重复，也丢 Markdown 结构）。
   *
   * 发送成功即清理临时文件；失败时发一张提示卡（不是纯文本），完整回答
   * 留在临时文件里（路径见错误日志），便于事后找回。
   */
  private async sendFinalAnswerFile(text: string, ctx: CommandContext): Promise<void> {
    let filePath: string | undefined;
    try {
      filePath = writeFinalAnswerFile(text);
      await this.connector.sendFile(ctx.chatId, filePath);
      bestEffortUnlink(filePath);
    } catch (err) {
      getLogger().error(
        `[lark-remote] failed to deliver complete final answer as file (kept at ${filePath ?? 'not written'}):`,
        err,
      );
      await this.sendResult({ card: finalAnswerFileFailureCard(errorMessage(err)) }, ctx);
    }
  }

  /**
   * Update an existing card in place (原地更新) instead of sending a new one.
   *
   * Used by /config cardAction handlers (config.set/input/save) so the
   * user sees the card refresh on the same message bubble rather than getting
   * a new card per click — same-message-bubble update pattern.
   *
   * Falls back to `sendResult` (which sends a new card as reply) when:
   *   - `messageId` is missing (caller didn't pass ctx.messageId)
   *   - `connector.updateCard` throws (card was deleted, network error, etc.)
   *
   * Returns true if the in-place update succeeded, false if it fell back.
   */
  async updateCardInPlace(card: object, ctx: CommandContext): Promise<boolean> {
    if (!ctx.messageId) {
      getLogger().warn(
        '[lark-remote] updateCardInPlace missing messageId, falling back to sendResult',
      );
      await this.sendResult({ card }, ctx);
      return false;
    }
    try {
      getLogger().debug(`[lark-remote] updateCardInPlace messageId=${ctx.messageId}`);
      await this.connector.updateCard(ctx.messageId, card);
      return true;
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      getLogger().warn(
        `[lark-remote] updateCardInPlace failed, falling back to sendResult: ${errMsg}`,
      );
      // 先尝试 fallback 发卡片；若卡片本身有问题（如 11310），
      // sendResult 内部 catch 会发纯文本通知用户。
      await this.sendResult({ card }, ctx);
      return false;
    }
  }

  /**
   * Best-effort in-place refresh of a KNOWN card (no fallback send).
   *
   * `updateCardInPlace` falls back to sending a new card when the PATCH fails,
   * which is right for the card the user just clicked (a silent failure would
   * leave the click with no feedback) but wrong when refreshing *sibling*
   * cards: an expired/withdrawn card would spawn a duplicate card on every
   * edit. Callers that fan out to several cards use this instead and drop the
   * card id from their set on `false`.
   */
  async patchCard(messageId: string, card: object): Promise<boolean> {
    try {
      await this.connector.updateCard(messageId, card);
      return true;
    } catch (err) {
      // 调用方会据此把卡片从集合里永久剔除——这是用户可见的退化，warn 起步。
      getLogger().warn(
        `[lark-remote] patchCard failed messageId=${messageId}: ${errorMessage(err)}`,
      );
      return false;
    }
  }

  /**
   * 终态快照的写入点：finalize 时把当前 state + 渲染选项留一份。
   *
   * 不放在 finish() 里：bridge 才知道 hasRunCompact 等渲染选项，且 eviction
   * 与 activeRuns 生命周期在同一个地方收口。
   */
  private rememberRunCardSnapshot(
    runId: string,
    state: RunState,
    options: RunCardRenderOptions,
    cwd: string,
    agentKind: AgentKind,
    messageId?: string,
  ): RunCardSnapshot {
    const snapshot: RunCardSnapshot = {
      state,
      options,
      cwd,
      agentKind,
      ...(messageId === undefined ? {} : { messageId }),
    };
    this.runCardSnapshots.set(runId, snapshot);
    while (this.runCardSnapshots.size > Bridge.RUN_CARD_SNAPSHOT_MAX) {
      const oldest = this.runCardSnapshots.keys().next().value as string;
      this.runCardSnapshots.delete(oldest);
      // 卡片已经不在窗口里：继续订阅只是往一个没人看的 messageId 打 PATCH。
      this.jobWatch.stopJobWatch(oldest);
    }
    return snapshot;
  }

  // =============================================================================
  // 后台任务停止与订阅
  // =============================================================================
  // 实现住在 job-watch.ts（bridge 结构治理第 2 刀）：job.kill、名单订阅、
  // markJobsUnknown 与 PATCH 串行链整体搬过去。这里只留 killBackgroundJob
  // 薄转发——router 的 job.kill 卡片动作按名字分发到 bridge 公开 API；
  // 快照淘汰（rememberRunCardSnapshot）与收尾订阅（finalizeRun）直接调
  // this.jobWatch 的同名方法。

  /** 停止终态卡上的一个后台任务（job.kill 卡片动作）。 */
  async killBackgroundJob(runId: string, jobId: string, ctx: CommandContext): Promise<boolean> {
    return this.jobWatch.killBackgroundJob(runId, jobId, ctx);
  }

  /** Send a file to the user via Feishu. */
  async sendFile(filePath: string, ctx: CommandContext): Promise<void> {
    try {
      getLogger().debug(`[lark-remote] sendFile path=${filePath} chatId=${ctx.chatId}`);
      await this.connector.sendFile(ctx.chatId, filePath);
    } catch (err) {
      getLogger().error('[lark-remote] failed to send file:', err);
      await this.sendResult({ text: `发送文件失败: ${(err as Error).message}` }, ctx);
    }
  }

  /**
   * 入站媒体落盘（connector 下载完成后调用）：只落盘并回报结果，
   * 时间语义与回执由 `InboundTurnAssembler` 统一负责。
   */
  async saveInboundMedia(payload: InboundMediaPayload): Promise<MediaOutcome> {
    return this.mediaHandler.save(payload);
  }

  /**
   * Resolve the working directory for a user.
   * First checks sessionStore (set by /cd), then falls back to first cwd.
   * Returns undefined if no cwd is available.
   */
  private resolveCwd(userId: string): string | undefined {
    const entry = this.sessionStore.get(userId);
    let cwd = entry?.cwd;
    if (!cwd && this.workspaceStore) {
      const workspaces = this.workspaceStore.list();
      if (workspaces.length > 0) {
        // NOTE: fallback uses insertion order, not sort preference — by design
        // (cwd fallback stays insertion-order for now)
        cwd = workspaces[0].path;
        getLogger().info(`[lark-remote] resolveCwd fallback cwd=${cwd} (first saved cwd)`);
      }
    }
    return cwd;
  }

  /**
   * Forward a non-command message to claude.
   *
   * Watchdog (§9.12): if no AgentEvent arrives within IDLE_TIMEOUT_MS, the
   * run is considered hung and `runner.stop()` is called to unblock the
   * work queue. Session is synced from `system.init`; every renderable event
   * updates the same run card, and terminal events finalize that card.
   */
  async forwardToClaude(
    message: string,
    ctx: CommandContext,
    opts?: { cwdOverride?: string; binding?: AgentBinding; autoRetry?: boolean },
  ): Promise<void> {
    // agentKind 一律来自绑定。无 binding 时保持现状（live defaultAgent）。
    const agentKind = opts?.binding?.agent ?? this.config.defaultAgent;
    // lane 与执行 cwd 同源。消息入队时（index.ts 闭包）捕获的 cwd
    // 作为 cwdOverride 显式传入；执行时若 sessionStore cwd 已被 /cd 等命令改写，
    // 以 lane 为准 —— 否则旧 lane 的排队消息会被 busy-drop 静默丢失。空串视为
    // 未提供（与入队前无 cwd 的兜底语义一致）。
    const laneCwd = opts?.cwdOverride;
    const cwd = laneCwd && laneCwd.length > 0 ? laneCwd : this.resolveCwd(ctx.userId);

    if (!cwd) {
      await this.sendResult({ text: '请先使用 /cd <path> 设置工作目录' }, ctx);
      return;
    }

    const entry = this.sessionStore.get(ctx.userId);
    getLogger().debug(
      `[lark-remote] forward entry userId=${ctx.userId} chatId=${ctx.chatId} cwd=${cwd} ` +
        `agent=${agentKind} sessionId=${opts?.binding?.sessionId ?? entry?.sessions.get(agentKind) ?? '(none)'} message=${message.slice(0, 100)}`,
    );

    // Check if current cwd already has a run in progress
    if (this.activeRuns.has(cwd)) {
      getLogger().warn(`[lark-remote] cwd busy, dropping message userId=${ctx.userId} cwd=${cwd}`);
      await this.sendResult({ text: '此工作目录正在处理中，请 /stop 后重试' }, ctx);
      return;
    }

    // Note: Multiple workspaces can have runs in parallel. If runner is busy,
    // runner.run() will throw and we'll catch it below.

    // sessionId 钉死语义——binding 有 sessionId 时用它（入队时刻快照），
    // 否则跟随 live store（无 binding 或入队时无 session 的正常路径）。
    const sessionId =
      opts?.binding?.sessionId ?? this.sessionStore.getSessionId(ctx.userId, agentKind);

    // 会话代际快照：/new、/cd、/resume 会 bump
    // epoch，该 run 后续 system.init 的 sessionId 写回即判 stale 跳过。
    // 快照点优先取 binding.sessionEpoch（入队/commit 时刻，与 sessionId 同刻）：
    // 排队消息在「commit 后、开跑前」被 reset 时，执行起点捕获会漏判（epoch 已是
    // bump 后的值）→ 旧 sessionId 被写回复活 reset。无 binding 时回退执行起点捕获，
    // 保持非排队路径（如 /compact）的既有语义。
    const sessionEpochAtStart =
      opts?.binding?.sessionEpoch ?? this.sessionStore.getSessionEpoch(ctx.userId, agentKind);

    // CodeBuddy 的区域是服务端事实（这个 token 在哪个端点被接受），本地没有
    // 可读状态。开跑前等一次双探针判定，避免启动探测还没完成时首条消息拿
    // 宿主 env 打错端点；401 后判定已作废，这里也会等进程内重判收尾。显式
    // 配置、已判定、探测超时都立即放行，不影响其他 agent。
    if (agentKind === 'codebuddy') {
      const cbConf = getAgentConfig(this.config, 'codebuddy');
      await ensureCodebuddyRegion(cbConf?.env, {
        binary: cbConf?.acp?.binary,
        hostProductConfigCacheDir: defaultCodebuddyProductConfigCacheDir(),
      });
    }

    // Resolve the runner BEFORE creating the run session so the exact instance
    // that will run is captured into activeRun. interruptCurrentRun stops THAT
    // instance directly -- never a fresh runner re-resolved from a cache that
    // clearRunners() may have emptied mid-run.
    const runner = this.getRunner(cwd, agentKind, { replaceStale: true });

    // Step 1: Create run session (runId, cardSession, activeRun tracking)
    const { runId, cardSession, activeRun } = this.createRunSession(ctx, cwd, runner, agentKind);

    // Step 2: Consume the agent stream (runner.run loop, event processing, state updates)
    // 兜底：run 消费阶段任何异常都必须仍走 finalizeRun 释放 activeRuns 槽位，
    // 否则该 cwd 永久 busy（后续消息被 busy-drop，只能手动 /stop）。
    try {
      await this.runAgentStreamToEnd(
        runner,
        cardSession,
        activeRun,
        sessionId,
        sessionEpochAtStart,
        ctx,
        cwd,
        runId,
        message,
        agentKind,
      );
    } finally {
      // Step 3: Finalize the run (error handling, fallback card, completion notification, cleanup)
      await this.finalizeRun(cardSession, activeRun, ctx, cwd);
    }

    // Step 4: 服务方内容审核截断（`finish_reason: content_filter`）后自动续跑一次。
    // 放在 finalize 之后：activeRuns 槽位已释放，续跑能正常开新卡片。
    await this.retryAfterContentFilter({
      cardSession,
      activeRun,
      ctx,
      cwd,
      agentKind,
      sessionId,
      sessionEpochAtStart,
      autoRetried: opts?.autoRetry === true,
    });
  }

  /**
   * 内容审核截断后的单次自动续跑。
   *
   * DSH 把上游 `finish_reason: content_filter` 归一成 PI_AI_ERROR：既不在默认
   * 重试码里（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT），也不会换模型，
   * 于是一次（多数是误报的）判定就把整个 turn 判死。60 步、
   * 10 分钟的 turn 在最后一步被截断，已写入的文件还在，用户只看到「运行出错」
   * 加一句英文报文。
   *
   * 桥侧不改 dsh 的重试策略，改用「同一 session 补一条继续提示」：审核是概率
   * 判定，重采样通常能过；模型从历史里接着做，不必重跑已完成的工作。
   * 只续一次——续跑仍被截断就停在错误卡，不进入无限重试。
   */
  private async retryAfterContentFilter(params: {
    cardSession: RunCardSession;
    activeRun: ActiveRun;
    ctx: CommandContext;
    cwd: string;
    agentKind: AgentKind;
    sessionId: string | undefined;
    sessionEpochAtStart: number;
    autoRetried: boolean;
  }): Promise<void> {
    const state = params.cardSession.currentState;
    if (state.terminal !== 'error' || !isContentFilterFailure(state.errorMsg)) return;
    if (params.autoRetried) {
      getLogger().info(
        `[lark-remote] content_filter auto-retry already used runId=${state.runId} cwd=${params.cwd}`,
      );
      return;
    }
    // 会话指针在 run 期间被 /new、/resume 等移动过：续跑会接到另一个会话上，
    // 「从断点继续」的语义不再成立，宁可不做（错误卡已经把话说清楚）。
    const epochNow = this.sessionStore.getSessionEpoch(params.ctx.userId, params.agentKind);
    if (epochNow !== params.sessionEpochAtStart) {
      getLogger().info(
        `[lark-remote] content_filter auto-retry skipped: session epoch moved runId=${state.runId}`,
      );
      return;
    }

    // 续跑必须接「本轮实际使用的 session」而非入队时刻快照（与 finalize 路径
    // 的三级优先同口径：卡片状态 → activeRun → 起点快照）。快照只在 run 未建立
    // 任何新会话时兜底。可证场景：新会话第一条消息（快照 undefined）被截断——
    // init 已建立 S1，epoch 未动，传快照会让续跑落到全新空会话，本轮上下文
    // 全部丢失；claude --resume fork 场景同理（init 上报的 id 才是权威）。
    const retrySessionId = state.sessionId ?? params.activeRun.sessionId ?? params.sessionId;

    getLogger().warn(
      `[lark-remote] content_filter detected, auto-retrying once runId=${state.runId} cwd=${params.cwd}`,
    );
    await this.sendResult(
      {
        text: '🔁 上一回合被服务方内容审核截断（content_filter，通常是误报），已自动重试一次。',
      },
      params.ctx,
    );
    try {
      await this.forwardToClaude(
        '（自动继续）上一回合因服务方内容审核被截断（content_filter，通常是误报）。' +
          '请从上次中断的位置继续，不要重复已经完成的步骤。',
        params.ctx,
        {
          cwdOverride: params.cwd,
          binding: {
            agent: params.agentKind,
            sessionId: retrySessionId,
            sessionEpoch: params.sessionEpochAtStart,
          },
          autoRetry: true,
        },
      );
    } catch (err) {
      // 续跑自身失败不应冒泡成未捕获异常：用户已经收到错误卡与重试通知。
      getLogger().error(`[lark-remote] content_filter auto-retry failed runId=${state.runId}`, err);
    }
  }

  /**
   * Step 1 of forwardToClaude: Create run session components.
   * Returns runId, cardSession, and activeRun object for tracking.
   */
  private createRunSession(
    ctx: CommandContext,
    cwd: string,
    runner: Runner,
    agentKind: AgentKind = this.config.defaultAgent,
  ): { runId: string; cardSession: RunCardSession; activeRun: ActiveRun } {
    const runId = randomUUID();
    getLogger().debug(`[lark-remote] creating runCard runId=${runId}`);
    // agentKind 来自入队绑定（forwardToClaude 解析），不再读 live config。
    // 缓存键 (cwd, agentKind) 和 eviction 都用这个值。
    const cardSession = new RunCardSession({
      connector: this.connector,
      chatId: ctx.chatId,
      replyTo: ctx.messageId,
      runId,
      renderOptions: {
        // Run card header shows the current agent name (e.g. "Claude · 思考中")
        agentKind,
        // Compact 按钮能力门控与 resume 卡 / auto-resume 卡一致（hasRunCompact
        // 鸭子探测）：claude（stream-json，无 turn_started）也能拿到按钮。
        compactSupported: this.hasRunCompact(cwd, agentKind),
        // 本轮 init 到达前，按钮是否仍有可压缩目标：开跑时 store 里已有会话
        // 才置 true。false 时按钮只在 state.sessionId 出现后渲染——否则
        // init 前被 /stop 的卡片会留下一个注定失败的按钮。
        sessionFallbackAvailable: !!this.sessionStore.getSessionId(ctx.userId, agentKind),
      },
    });
    const activeRun: ActiveRun = {
      runId,
      userId: ctx.userId,
      chatId: ctx.chatId,
      session: cardSession,
      cwd,
      runner,
      agentKind,
    };
    this.activeRuns.set(cwd, activeRun);
    getLogger().info(`[lark-remote] activeRuns.set cwd=${cwd} runId=${runId}`);
    return { runId, cardSession, activeRun };
  }

  /**
   * §9.12 空闲看门狗：单 interval + 截止时间判定，普通 run 与 compact
   * 共用同一套兜底。事件到达只 `touch()` 刷新时间戳（无 timer 操作）；静默超过
   * `idleTimeoutMs` 才 finish('idle_timeout') + runner.stop()，让该工作区的串行
   * 队列继续推进（否则一个挂死的 run 永久堵住后续消息）。
   */
  private startIdleWatchdog(opts: {
    runId: string;
    session: RunCardSession;
    runner: Runner;
    /** >0 = 正在等人工审批：「等审批」不是「挂死」，刷新窗口而不是终止。 */
    pendingApprovals?: () => number;
  }): IdleWatchdog {
    let lastEventTs = Date.now();
    let interval: NodeJS.Timeout | null = null;
    const stop = (): void => {
      if (interval) clearInterval(interval);
      interval = null;
    };
    if (this.idleTimeoutMs > 0) {
      // 周期取 idleTimeoutMs/2：停滞后最多在 1.5× idleTimeoutMs 内触发
      // （半个窗口延迟，看门狗语义可接受）
      const tickMs = Math.max(1, Math.floor(this.idleTimeoutMs / 2));
      interval = setInterval(() => {
        if (Date.now() - lastEventTs <= this.idleTimeoutMs) return;
        // 权限等待期间暂停空闲看门狗：claude/codex 等待人工决策时无 stdout
        // 事件。审批由 ApprovalCoordinator 的超时（默认 5 分钟 < 看门狗窗口）
        // 自愈：cancel 送达 + 中断 turn，不会无限挂起。
        if ((opts.pendingApprovals?.() ?? 0) > 0) {
          lastEventTs = Date.now();
          return;
        }
        stop();
        getLogger().warn(`[lark-remote] claude idle timeout, stopping process runId=${opts.runId}`);
        // 看门狗清理的两个结果都必须留痕：卡片 patch 失败时终态会停在
        // 「运行中」；runner.stop 失败时挂死的 run 没被杀、cwd 槽位未释放，
        // 串行队列从此永久堵死（用户视角「机器人不回消息」，日志却只有
        // 前面一条 warn）。对照 claude session.ts idle timer 的 .catch(log)。
        void Promise.allSettled([
          opts.session.finish('idle_timeout', {
            idleTimeoutMinutes: Math.max(1, Math.round(this.idleTimeoutMs / 60_000)),
          }),
          opts.runner.stop(),
        ]).then(([finishResult, stopResult]) => {
          if (finishResult.status === 'rejected') {
            getLogger().error(
              `[lark-remote] idle-timeout cleanup failed runId=${opts.runId} finish:`,
              finishResult.reason,
            );
          }
          if (stopResult.status === 'rejected') {
            getLogger().error(
              `[lark-remote] idle-timeout cleanup failed runId=${opts.runId} stop:`,
              stopResult.reason,
            );
          }
        });
      }, tickMs);
    }
    return {
      touch: () => {
        lastEventTs = Date.now();
      },
      stop,
    };
  }

  /**
   * result 事件的 pre-init 守卫（§9.22）。
   *
   * Claude CLI `--resume` 会在 system.init 之前先吐一条**上一轮**的陈旧 result。
   * 认了它就会过早置 sawResult / 抓错 usage / 让 run-state reducer 提前进入
   * finalizing（reducer 用 sessionId===undefined 守卫，同一条红线）。本轮真正的
   * result 在 system.init 之后才到。
   *
   * 例外：app-server runner（usageAuthority==='live'）的 init 是 runner 自己补发
   * 的 synthetic init。此分支保留为防御性兜底：live runner 若
   * 在无 init 时发出 result（旧构建等），session 写回照常执行，但 sawResult 不置
   * 真——卡片不会把半初始化的 run 当作已收尾。
   *
   * @param dropFromCard 该 result 是陈旧重放，不得进卡片（调用方 continue 跳过 push）
   */
  private observeResultEvent(
    event: Extract<AgentEvent, { type: 'result' }>,
    opts: {
      sawInit: boolean;
      liveResultEvents: boolean;
      usage: RunUsageCollector;
      writeback: WritebackContext;
      runId: string;
      agentKind: AgentKind;
      userId: string;
    },
  ): {
    sawResult: boolean;
    dropFromCard: boolean;
    preInitTerminal?: { subtype: 'error' | 'interrupted'; errorMessage?: string };
  } {
    const { sawInit, liveResultEvents, usage, writeback, runId, agentKind, userId } = opts;
    const preInitResult = !sawInit;
    const preInitTerminal =
      preInitResult && (event.subtype === 'error' || event.subtype === 'interrupted')
        ? {
            subtype: event.subtype,
            errorMessage: (event as { errorMessage?: string }).errorMessage,
          }
        : undefined;

    if (preInitResult && !liveResultEvents) {
      getLogger().info(`[lark-remote] pre-init result ignored (resume replay) runId=${runId}`);
      return { sawResult: false, dropFromCard: true, preInitTerminal };
    }

    // 401 是本轮上游明确给出的身份失效信号。只认当前轮的 live result：
    // resume 重放的历史 result 不是本轮身份事实，不该触发重置。
    if (!preInitResult && event.authFailure && agentKind === 'codebuddy') {
      this.invalidateCodebuddyIdentity(event, { userId, agentKind, runId });
    }

    // 模型被上游拒绝（400 model [...] service info not found）与 401 是两类
    // 不同的失效：登录态没坏，坏的是配置里的 model id。ACP 只回泛化的
    // Internal error，真实原因只在会话 jsonl 里，因此按需回读。
    if (!preInitResult && agentKind === 'codebuddy') {
      if (event.subtype === 'success') {
        recordCodebuddyModelSuccess(
          resolveCodebuddyModel(getAgentConfig(this.config, 'codebuddy')?.model),
        );
      } else if (event.subtype === 'error') {
        this.learnCodebuddyModelRejection(event, { userId, agentKind, runId, cwd: writeback.cwd });
      }
    }

    usage.observeResult(event);
    getLogger().info(
      preInitResult
        ? `[lark-remote] pre-init result from live runner (app-server setup failure) runId=${runId}`
        : `[lark-remote] result event received runId=${runId}`,
    );
    // 连接型 runner 的 setup 失败路径（thread/start 成功后 turn/start 失败）
    // 不会有 turn_started 事件，store 不会写回新线程 id；runner 已在 result 里
    // 兜底上报。仅当 runner 声明 live result 语义且会话指针未动时写回，避免
    // 下条消息再开一个孤儿线程。其余 agent 不在此列（各自有 init/turn_started 写回）。
    if (liveResultEvents) writeBackResultSession(writeback, event.session_id);
    return { sawResult: !preInitResult, dropFromCard: false, preInitTerminal };
  }

  /**
   * CodeBuddy 登录态/区域变化的运行时重置（`/config` 打开时目录刷新发现
   * 账号指纹变了，或当前区域被换掉）。
   *
   * 持久 sessionId 与 runner 槽位都绑在旧身份上：不重置的话，即便模型目录
   * 已经刷新成新账号的清单，下一条消息仍会复用旧 ACP 连接与旧 session，
   * 在失效端点上重放 401。目录与区域由调用方刚刷新过，这里只清运行时状态。
   */
  resetCodebuddyRuntime(userId: string): void {
    this.sessionStore.clearSessionId(userId, 'codebuddy');
    this.clearRunners();
    getLogger().warn('[lark-remote] codebuddy identity changed: session/runner reset');
  }

  /**
   * CodeBuddy 身份失效协议：模型目录快照、持久 sessionId、runner 槽位都是
   * 「当前登录身份 + 区域」的派生状态，必须一次性作废。
   *
   * 少了任意一份都会复现原故障：目录继续显示旧区域模型清单；/restart 的
   * restoreLastSession() 把旧 sessionId 写回并 auto-resume 到同一个 401
   * 会话；长驻 ACP 连接（runner 侧已 release）对应的 runner 实例仍被缓存。
   * 上游 401 是唯一可信信号——不读 CLI 私有凭据、不猜凭据指纹。
   */
  private invalidateCodebuddyIdentity(
    event: Extract<AgentEvent, { type: 'result' }>,
    opts: { userId: string; agentKind: AgentKind; runId: string },
  ): void {
    const { userId, agentKind, runId } = opts;
    invalidateCodebuddyCatalogCache();
    // 自动判定的区域也必须作废：否则 clearRunners 后重建 runner 仍注入旧
    // 区域，下一条消息会在同一个失效端点上重放 401。重启时重新双探针判定。
    invalidateCodebuddyRegion();
    // clearSessionId 会 bump epoch（连空→空也 bump），既阻止 auto-resume，
    // 也让本轮 finalizeRun 的写回守卫不再把旧 sessionId 写回。cwd 保留。
    this.sessionStore.clearSessionId(userId, agentKind);
    // 活跃 cwd 只标 stale，finalizeRun 在 turn 收尾后安全 evict；不误杀在跑的
    // 子进程（clearRunners 的既有语义）。
    this.clearRunners();
    // 进程内重判：用户重新 /login 后新凭据已落盘，重建连接即可用对区域，
    // 不需要重启 lark-remote。schedule 内部有冷却窗口与 in-flight 串行，
    // 上游持续 401 时不会反复 spawn 探针。binary 与 runner 同源。
    const cbConf = getAgentConfig(this.config, 'codebuddy');
    scheduleCodebuddyRegionRedetect(cbConf?.env, {
      binary: cbConf?.acp?.binary,
      hostProductConfigCacheDir: defaultCodebuddyProductConfigCacheDir(),
    });
    event.errorMessage = `${event.errorMessage ?? '上游认证失效'}${CODEBUDDY_AUTH_RECOVERY_HINT}`;
    getLogger().warn(
      `[lark-remote] codebuddy auth failure: catalog/region/session/runner invalidated, redetect scheduled runId=${runId}`,
    );
  }

  /**
   * 模型被上游拒绝时的自我校正。
   *
   * ACP 只把 400 压成 `Internal error`，账号可用清单只存在于会话 jsonl 的
   * assistant 错误行（`Currently supported models for your account:`）。学到
   * 清单后：配置里的 model 若不在清单内，按「上次成功 → 账号当前 → 偏好」
   * 挑一个，并作废旧 session 与 runner 槽位，下一条消息用校正后的模型新建
   * 会话——否则下一条会继续下发同一个被拒 id。
   *
   * 不自动重放本轮：卡片终态已经产出，静默重跑会让用户看到一次「消失的
   * 错误」，也容易与已执行过的工具产生歧义。
   */
  private learnCodebuddyModelRejection(
    event: Extract<AgentEvent, { type: 'result' }>,
    opts: { userId: string; agentKind: AgentKind; runId: string; cwd: string },
  ): void {
    const cbConf = getAgentConfig(this.config, 'codebuddy');
    // CodeBuddy 的会话目录固定 `~/.codebuddy/projects/<cwd 编码>/`（无配置项，
    // 与 CodebuddySessionReader 同口径）。
    const sessionFile = path.join(
      codebuddyProjectsDir(this.codebuddyHome),
      encodeCodebuddyProjectDirName(opts.cwd),
      `${path.basename(event.session_id)}.jsonl`,
    );
    const learned = readCodebuddyModelError(sessionFile);
    if (!learned) return;

    if (learned.supported.length === 0) {
      // 错误文本没带清单（非模型类错误）：不覆盖已知清单，只在能定位到
      // 具体模型时给一句可执行的提示。
      if (learned.model) {
        event.errorMessage =
          `${event.errorMessage ?? '上游拒绝该模型'}` +
          `\n\n【提示】模型 ${learned.model} 可能不属于当前账号，请在 /config 换一个模型。`;
      }
      return;
    }

    const state = recordCodebuddyModelRejection({
      model: learned.model,
      supported: learned.supported,
    });
    if (!state) return;

    const corrected = resolveCodebuddyModel(cbConf?.model);
    if (!corrected || corrected === cbConf?.model) {
      getLogger().info(
        `[lark-remote] codebuddy model list learned (${state.supported.length} ids), configured model still valid runId=${opts.runId}`,
      );
      return;
    }

    const rejected = learned.model ?? cbConf?.model;
    this.sessionStore.clearSessionId(opts.userId, opts.agentKind);
    this.clearRunners();
    event.errorMessage =
      `${event.errorMessage ?? '上游拒绝该模型'}` +
      `\n\n【已自动校正】模型 ${rejected ?? '(未配置)'} 不属于当前账号，已切换为 ${corrected}。` +
      '\n请重发本条消息。';
    getLogger().warn(
      `[lark-remote] codebuddy model rejected: ${rejected ?? '(unknown)'} -> ${corrected}, session/runner invalidated runId=${opts.runId}`,
    );
  }

  /**
   * 审批三事件的派发（requested / resolved / view_updated）。
   *
   * coordinator 一 run 一个，首次 requested 时惰性建好并登记，`finally` 里统一
   * onTurnEnded + 摘除。
   */
  private dispatchApprovalEvent(
    event: Extract<
      AgentEvent,
      {
        type: 'approval_requested' | 'approval_resolved' | 'approval_view_updated';
      }
    >,
    opts: {
      runId: string;
      runner: Runner;
      cardSession: RunCardSession;
      ctx: CommandContext;
      agentKind: AgentKind;
    },
  ): void {
    const { runId, runner, cardSession, ctx, agentKind } = opts;
    if (event.type === 'approval_requested') {
      // 审批请求到达：撤回 Typing 表情再重发，让飞书重新触发提醒，把用户
      // 注意力拉回待审批的卡片（run 在等待人工决策，Typing 应重新闪烁）。
      remindPendingApproval(this.connector, ctx.messageId, runId);
      let coordinator = this.approvalCoordinators.get(runId);
      if (!coordinator) {
        coordinator = createRunApprovalCoordinator({
          runner,
          cardSession,
          config: this.config,
          runId,
          agentKind,
        });
        this.approvalCoordinators.set(runId, coordinator);
        getLogger().info(
          `[lark-remote] approval coordinator created runId=${runId.slice(0, 8)} requestId=${event.requestId}`,
        );
      }
      coordinator.onRequested(event);
      return;
    }
    const coordinator = this.approvalCoordinators.get(runId);
    if (event.type === 'approval_resolved') {
      coordinator?.onResolved(event.requestId);
      return;
    }
    // 乱序流：审批先到、item/started 后到，补全审批卡内容。coordinator
    // 仅在 pending 时更新（已响应/过期不复活）。
    coordinator?.updateView(event.requestId, event.view);
  }

  /**
   * 进程退出（for-await 自然结束）后的终态矩阵——它是本轮的唯一终态触发源。
   *
   * 1) finalizing（result 已收到）→ 三态映射 + usage meta
   * 2) running（未收到 result）→ 错误路径；pre-init 终态优先当唯一线索
   * 3) 已终态 + sawResult → 首终态不动，仅补 usage meta
   * 4) 已终态且未收到 result（如 spawn 失败后 interrupted）→ 无 usage 可补，跳过
   */
  private async finishRunAfterStream(opts: {
    cardSession: RunCardSession;
    usage: RunUsageCollector;
    sawResult: boolean;
    /** 收到过任何 result（含被守卫丢弃的）——running 收尾时区分「没收到」与「没落到卡片」。 */
    sawAnyResult: boolean;
    pendingPreInitTerminal: { subtype: 'error' | 'interrupted'; errorMessage?: string } | undefined;
    agentKind: AgentKind;
    runId: string;
  }): Promise<void> {
    const {
      cardSession,
      usage,
      sawResult,
      sawAnyResult,
      pendingPreInitTerminal,
      agentKind,
      runId,
    } = opts;
    const finalState = cardSession.currentState;
    if (finalState.terminal === 'finalizing') {
      // 三态终态映射：interrupted（审批超时/取消、/stop）是独立
      // 终态，不再归因于 Agent 错误；error 保持「运行出错」；其余为 done。
      const subtype = finalState.resultSubtype;
      const isError = subtype === 'error' || !!finalState.errorMsg;
      // goal 仍 active = 宿主会自动起下一轮：这不是"完成"，而是"本轮结束"。
      // 用独立终态而不是 done，既不改 header 文案也不用谎报。
      const goalContinues =
        !isError && subtype !== 'interrupted' && finalState.goal?.phase === 'active';
      const terminal = isError
        ? 'error'
        : subtype === 'interrupted'
          ? 'interrupted'
          : goalContinues
            ? 'goal_continuing'
            : 'done';
      // 中断归因：用户主动取消审批（cancel）优先于"未归类"。用户 /stop 的
      // 路径先置了终态（interrupted + user_stop），不会走到这里。
      const approvalCancelled =
        terminal === 'interrupted' &&
        this.approvalCoordinators.get(runId)?.cancelledByUser === true;
      await cardSession.finish(terminal, {
        resultSubtype: subtype,
        errorMsg: finalState.errorMsg,
        ...(approvalCancelled ? { interruptedReason: 'approval_cancelled' as const } : {}),
        ...usage.meta(),
      });
      return;
    }
    if (finalState.terminal === 'running') {
      if (pendingPreInitTerminal) {
        const terminal = pendingPreInitTerminal.subtype === 'interrupted' ? 'interrupted' : 'error';
        getLogger().warn(
          `[lark-remote] stream ended without init; using pre-init ${terminal} result runId=${runId} error=${pendingPreInitTerminal.errorMessage ?? '(none)'}`,
        );
        await cardSession.finish(terminal, {
          ...usage.meta(),
          errorMsg:
            pendingPreInitTerminal.errorMessage ??
            agentDisplayName(agentKind) + (terminal === 'interrupted' ? ' 已中断' : ' 启动失败'),
        });
      } else {
        await cardSession.finish('error', {
          ...usage.meta(),
          // sawAnyResult=true 说明 result 收到了、只是没能落到卡片（reducer 的
          // sessionId 守卫或 pre-init 守卫挡下）。报文不能再说"未收到 result
          // 事件"，否则排障会去查输出流而不是查守卫。
          errorMsg:
            agentDisplayName(agentKind) +
            (sawAnyResult
              ? ' 输出流已结束，但本轮结果未能落到卡片上'
              : ' 输出流已结束，但未收到 result 事件'),
        });
      }
      return;
    }
    if (sawResult) {
      // 已终态（interrupted/idle_timeout）+ result 已收到：首终态优先，
      // 仅补充 usage meta（finalizing 期间被 /stop 或 idle 超时也展示 token 统计）
      await cardSession.finish(finalState.terminal, usage.meta());
    }
  }

  /**
   * Step 2 of forwardToClaude: Run the agent and consume its event stream.
   * Handles idle watchdog, event processing, session sync, and state transitions.
   */
  private async runAgentStreamToEnd(
    runner: Runner,
    cardSession: RunCardSession,
    activeRun: ActiveRun,
    sessionId: string | undefined,
    sessionEpochAtStart: number,
    ctx: CommandContext,
    cwd: string,
    runId: string,
    message: string,
    agentKind: AgentKind = this.config.defaultAgent,
  ): Promise<void> {
    // Runner 声明的 usage 权威来源：codex app-server / pi RPC = 'live'
    // （live 带 input/output）；opencode/kimi ACP live 只有 context，声明
    // 'jsonl'。result 事件的 live 语义（pre-init/写回）单独声明，不能和
    // 用量来源共用一个字段。
    const usageAuthority = (runner as AgentRunner).getUsageAuthority?.();
    const liveResultEvents = computeLiveResultEvents(runner, usageAuthority);

    // 运行期状态打包成显式状态对象传给各抽出方法（等价替换原闭包捕获的局部变量）。
    const run: AgentStreamRun = {
      runner,
      cardSession,
      activeRun,
      sessionId,
      sessionEpochAtStart,
      ctx,
      cwd,
      runId,
      message,
      agentKind,
      usage: new RunUsageCollector(),
      usageAuthority,
      liveResultEvents,
      state: {
        watchdog: null,
        sawResult: false,
        sawAnyResult: false,
        pendingPreInitTerminal: undefined,
      },
    };

    try {
      await this.executeStream(run);
    } catch (err) {
      await this.handleStreamFailure(err, run);
    } finally {
      this.cleanupStream(run);
    }
  }

  /**
   * runAgentStreamToEnd 的 try 主体（建卡 → 事件循环 → 收尾），抽成独立方法
   * 降低外层圈复杂度；state 为跨方法共享的可变状态。逻辑与文案逐字保留。
   */
  private async executeStream(run: AgentStreamRun): Promise<void> {
    const {
      runner,
      cardSession,
      activeRun,
      sessionId,
      sessionEpochAtStart,
      ctx,
      cwd,
      runId,
      message,
      agentKind,
      usage,
      usageAuthority,
      liveResultEvents,
      state,
    } = run;

    try {
      // queue.immediate 的 run-start hold：目标槽位可能在 handler 发最终
      // toast 之前就 begin（interrupt/PATCH 的 await 窗口）。activeRun 已
      // 登记（队列语义照旧），只把建卡这一步挡到 toast 之后——run 卡片才是
      // 点击后最后一条新消息，聊天列表预览跟随它的标题变化。
      await this.queueManager.awaitTaskRunStart(cwd);
      getLogger().debug(`[lark-remote] cardSession.start() begin runId=${runId}`);
      await cardSession.start();
      getLogger().info(`[lark-remote] cardSession.start() ok runId=${runId}`);
    } catch (err) {
      getLogger().warn('[lark-remote] card stream unavailable, will use static fallback:', err);
      // Card stream failed - continue with static fallback below, but ensure
      // we don't silently fail if the fallback also fails (covered in catch below).
    }

    // /stop（或队列「立即执行」的中断）可能落在建卡窗口内：卡片已定格为
    // 终态，但 runner 还没开始跑，runner.stop() 也没有进程可杀——spawn 型
    // 与连接型 runner 的 stop() 在 run() 之前都是空操作，且 run() 入口会
    // 重置停止标记。必须在这里收口，否则用户看到「已中断」，agent 仍会把
    // 这一轮跑完并改写工作区。finalizeRun 仍会照常收尾（settle / reaction）。
    if (isRunTerminal(cardSession.currentState.terminal)) {
      getLogger().info(
        `[lark-remote] card terminal before run start, skip runner runId=${runId} terminal=${cardSession.currentState.terminal}`,
      );
      return;
    }

    // 单 interval 看门狗。事件到来时只刷新时间戳（无 timer 操作）；
    // interval 周期检查静默时长，超时才 finish('idle_timeout') + stop()。
    // 武装点在建卡之后，与原实现一致（宽限期不含 cardSession.start() 耗时）。
    state.watchdog = this.startIdleWatchdog({
      runId,
      session: cardSession,
      runner,
      pendingApprovals: pendingApprovalCount.bind(null, this.approvalCoordinators, runId),
    });

    getLogger().info(
      `[lark-remote] runner.run() begin runId=${runId} message=${message.slice(0, 100)}`,
    );

    // Extract agent-specific options from config
    const agentOpts = this.getAgentRunOptions(agentKind);
    const runOpts = { cwd, sessionId, ...agentOpts };
    // Track whether system.init has been received for this run.
    // Claude CLI --resume emits a stale result (from the previous turn)
    // before sending system.init; bridge must not treat that as the run
    // ending (sawResult, usage capture, or cardSession.push would all
    // be wrong for the historical event).
    let sawInit = false;
    const writeback = {
      sessionStore: this.sessionStore,
      userId: ctx.userId,
      agentKind,
      cwd,
      sessionEpochAtStart,
      runId,
    };

    for await (const event of runner.run(message, runOpts)) {
      // 只有终态才阻止事件处理。finalizing 是非终态，应该继续处理
      // 这样在 result 事件后，后台任务输出仍能被正确处理
      const terminal = cardSession.currentState.terminal;
      if (isRunTerminal(terminal)) {
        continue;
      }
      // 归一化：init/turn_started 的 session 写回 + compact_boundary 用量观察。
      // 返回 true = 本轮 system.init 已到（调用方置 sawInit，供 pre-init 守卫用）。
      if (this.maybeSyncSession(event, { activeRun, writeback, usage, runId })) {
        sawInit = true;
      }
      // pre-init result 守卫（§9.22，observeResultEvent）：resume 重放的陈旧
      // result 不置 sawResult、不进卡片。
      if (event.type === 'result') {
        const outcome = this.observeResultEvent(event, {
          sawInit,
          liveResultEvents,
          usage,
          writeback,
          runId,
          agentKind,
          userId: ctx.userId,
        });
        if (outcome.preInitTerminal) state.pendingPreInitTerminal ??= outcome.preInitTerminal;
        if (outcome.sawResult) state.sawResult = true;
        state.sawAnyResult = true;
        // 陈旧 result 不进卡片：run-state reducer 本来也会因 sessionId 未定而
        // 跳过，在 bridge 层就拦掉可以省下一次无谓的 push + render。
        if (outcome.dropFromCard) {
          // 仍然重置 idle 计时——CLI 活着并且在产事件。
          this.handleEventForWatchdog(state.watchdog);
          continue;
        }
      }
      // Approval events (Codex app-server mode)。审批先到、item/started 后到的
      // 乱序流也在此补全（dispatchApprovalEvent 内 updateView）。
      if (
        event.type === 'approval_requested' ||
        event.type === 'approval_resolved' ||
        event.type === 'approval_view_updated'
      ) {
        this.dispatchApprovalEvent(event, { runId, runner, cardSession, ctx, agentKind });
      }
      // §9.12 红线：每个事件（含 result）无条件刷新
      // lastEventTs 重新武装看门狗。result 后 CLI 进程做 jsonl flush/清理（finalizing
      // 过渡）期间，宽限期恢复为完整的 idleTimeoutMs，避免已产出结果的 turn 被误标
      // idle_timeout。旧实现 `else { resetIdle(); }` 漏掉 result 分支。
      this.handleEventForWatchdog(state.watchdog);

      // 渲染：reducer（run-state）在 cardSession.push 内部。
      await cardSession.push(event);
    }
    getLogger().info(`[lark-remote] runner stream end runId=${runId} sawResult=${state.sawResult}`);

    // §9.12 红线：for-await 自然结束 = CLI 已退出，
    // 看门狗使命结束，立即摘除 interval（不再等 finally），堵掉「stream 已结束、
    // 收尾处理跨过死线被误标 idle_timeout」的同源小窗口（随本修复一并关闭）。
    state.watchdog?.stop();

    // stream 结束 = CLI 退出 = jsonl 已落盘。读 jsonl 拿准确的 contextLength + compactCount：
    // live stream-json 不发 compact_boundary，live contextLength 会被 result 的 input+output 兜底失真。
    // 但 result=error 时跳过: 进程可能立即退出未写新 usage (如 kimi 0.26+ 拒绝 -p+--auto
    // 立即 exit=1), 此时 jsonl 里是上一次成功 turn 的历史 usage, 会被误当作本次 usage 显示,
    // 误导用户以为本次出错的请求也消耗了 token。error 时只用 live 捕获的 usage (若有)。
    // 本轮使用的 session：run 期间 /new //resume //cd 会移动全局
    // 指针，结束时再读 store 会把别条会话的 token/context 显示到这张卡上。
    // 优先级：卡片状态（本轮 init 写入）→ activeRun（本轮 init/turn_started）
    // → 本轮开始时捕获的 sessionId。三者都没有就跳过 usage，绝不回读全局指针。
    const finalSessionId = cardSession.currentState.sessionId ?? activeRun.sessionId ?? sessionId;
    const finalUsage = usage.resultNotSuccess
      ? undefined
      : resolveFinalUsage(
          this.sessionReaderRegistry,
          this.config.defaultAgent,
          finalSessionId,
          cwd,
          agentKind,
        );
    usage.finalize(finalUsage, usageAuthority);
    getLogger().info(usage.logSummary(runId));

    // for-await 自然结束 = stream 关闭 = CLI 进程退出 → 终态矩阵
    await this.finishRunAfterStream({
      cardSession,
      usage,
      sawResult: state.sawResult,
      sawAnyResult: state.sawAnyResult,
      pendingPreInitTerminal: state.pendingPreInitTerminal,
      agentKind,
      runId,
    });
  }

  /** runAgentStreamToEnd 的 catch 主体（抽成独立方法，state.sawResult 沿用循环累计值）。 */
  private async handleStreamFailure(err: unknown, run: AgentStreamRun): Promise<void> {
    const { runner, cardSession, runId, usage, state } = run;
    getLogger().error(`[lark-remote] claude run error runId=${runId}:`, err);
    // 双保险：run() 的 finally 已负责杀子进程，但 catch 路径再补一次
    // runner.stop()（与 bash 路径对齐），覆盖任何 finally 之外的残留窗口。
    try {
      await runner.stop();
    } catch (stopErr) {
      getLogger().warn(`[lark-remote] runner stop failed:`, stopErr);
    }
    // 终态守卫：running 或 finalizing（非终态）-> 转 error；
    // 已终态（interrupted/idle_timeout/done/error）-> 保留首终态，仅补充 usage。
    const catchTerminal = cardSession.currentState.terminal;
    if (isRunActive(catchTerminal)) {
      await cardSession.finish('error', {
        ...usage.meta(),
        inputTokens: usage.liveInputTokens,
        outputTokens: usage.liveOutputTokens,
        errorMsg: errorMessage(err),
      });
    } else {
      getLogger().info(
        `[lark-remote] skip error finish: state already terminal (${catchTerminal}) runId=${runId}`,
      );
      if (state.sawResult) {
        await cardSession.finish(catchTerminal, usage.meta());
      }
    }
  }

  /** runAgentStreamToEnd 的 finally 主体（抽成独立方法）。 */
  private cleanupStream(run: AgentStreamRun): void {
    const { runId, state } = run;
    state.watchdog?.stop();
    const coordinator = this.approvalCoordinators.get(runId);
    if (coordinator) {
      coordinator.onTurnEnded();
      this.approvalCoordinators.delete(runId);
    }
  }

  /**
   * 事件循环的看门狗喂狗（runAgentStreamToEnd 抽出的纯向方法）。
   *
   * §9.12：事件到达只 `touch()` 刷新时间戳（无 timer 操作），interval 周期检查
   * 静默时长；喂狗点与红线口径见 runAgentStreamToEnd 循环内两处调用点注释
   * （每个事件含 result 都必须喂，被守卫丢弃的 result 也喂——CLI 活着就在产事件）。
   */
  private handleEventForWatchdog(watchdog: IdleWatchdog | null): void {
    watchdog?.touch();
  }

  /**
   * 事件循环的 session 同步（runAgentStreamToEnd 抽出的纯向方法）：
   * init / turn_started 两写回点 + compact_boundary 用量观察。
   *
   * @returns 事件是否为本轮 `system.init`（调用方据此置 sawInit，供 pre-init
   * result 守卫判定）。init 分支的全部副作用完成后才返回，与原内联顺序一致。
   */
  private maybeSyncSession(
    event: AgentEvent,
    opts: {
      activeRun: ActiveRun;
      writeback: WritebackContext;
      usage: RunUsageCollector;
      runId: string;
    },
  ): boolean {
    const { activeRun, writeback, usage, runId } = opts;
    if (event.type === 'system' && event.subtype === 'init') {
      // 本轮真实使用的 session（不可变身份）：指针在 run 中被 /new 等移动时，
      // 结束后的 usage 读取仍以它为准。
      activeRun.sessionId = event.session_id;
      writeBackInitSession(writeback, event);
      getLogger().info(
        `[lark-remote] system.init received runId=${runId} sessionId=${event.session_id} cwd=${event.cwd}`,
      );
      return true;
    }
    if (event.type === 'turn_started') {
      // app-server runner 在 turn setup 成功后补发 synthetic system.init
      // （§9.22 守卫前提），此处 turn_started 写回保留为双保险：两者都用
      // threadId 写回 sessionId（代际守卫一致），幂等。缺失会导致每次消息
      // 都新建线程（thread/start 而非 thread/resume），会话无法延续。
      // init 缺失时以 threadId 作为本轮身份兜底。
      activeRun.sessionId ??= event.threadId;
      writeBackTurnStarted(writeback, event);
    }
    // Track context length from compaction events
    if (event.type === 'system' && event.subtype === 'compact_boundary' && event.compactMetadata) {
      usage.observeCompaction(event.compactMetadata.postTokens);
    }
    return false;
  }

  /**
   * 终态 reaction 收尾：撤掉 Typing、打上下方终态表情。
   *
   * 逐条挂 Typing（`src/index.ts` 对每条入站消息都加），但 ctx.messageId 只是
   * 装配窗口里的最后一条——只对它收尾会让先到的那几条永远停在「正在输入」。
   * connector 的两个 reaction 方法自带 try/catch（缺失 reaction 是 no-op），
   * 所以这里 fire-and-forget 即可，不额外兜错。
   */
  private finishTurnReactions(ctx: CommandContext, emoji: string): void {
    const ids = ctx.turnMessageIds?.length
      ? [...new Set([...ctx.turnMessageIds, ctx.messageId])]
      : [ctx.messageId];
    // 两类 emoji 互不相干（撤 Typing / 打终态），并发发出没有顺序依赖。
    for (const id of ids) {
      void this.connector.removeReactionByEmoji(id, 'Typing');
      void this.connector.addReaction(id, emoji);
    }
  }

  /**
   * Step 3 of forwardToClaude: Finalize the run.
   * Handles fallback card sending, completion notification, and cleanup.
   */
  private async finalizeRun(
    cardSession: RunCardSession,
    activeRun: ActiveRun,
    ctx: CommandContext,
    cwd: string,
  ): Promise<void> {
    const runId = activeRun.runId;
    try {
      getLogger().debug(
        `[lark-remote] finally settle runId=${runId} state.terminal=${cardSession.currentState.terminal}`,
      );
      const settleResult = await cardSession.settle();
      // 卡片收尾后仍要能点「详情」：把终态 state 与当时的渲染选项留一份。
      // 与 fallback 卡共用同一份 options（能力门控一致，展开后按钮语义不变）。
      const finalRenderOptions: RunCardRenderOptions = {
        agentKind: activeRun.agentKind,
        // 与 createRunSession 的 renderOptions 一致：fallback 卡也要按
        // runner 能力门控 Compact 按钮（缺省 undefined = 显示按钮，
        // DSH 等无 runCompact 的 agent 会渲染出点了报错的死按钮）。
        compactSupported: this.hasRunCompact(cwd, activeRun.agentKind),
        // 终态卡按「此刻是否真的有可压缩会话」渲染按钮，与记账用的是同一
        // 判据（本轮 sessionId 或 store 回退），避免按钮可见但记录不存在。
        sessionFallbackAvailable: !!(
          cardSession.currentState.sessionId ??
          this.sessionStore.getSessionId(ctx.userId, activeRun.agentKind)
        ),
      };
      const finalRender = renderRunCardDetailed(cardSession.currentState, finalRenderOptions);
      const snapshot = this.rememberRunCardSnapshot(
        runId,
        cardSession.currentState,
        finalRenderOptions,
        cwd,
        activeRun.agentKind,
        cardSession.cardMessageId,
      );
      let runCardSent = false;
      if (settleResult === 'unsent') {
        const sent = await this.sendResult({ card: finalRender.card }, ctx, {
          // 兜底发送的卡也要能接收后台任务更新 —— 流式卡没建起来时这是唯一来源。
          onCardSent: (messageId) => {
            snapshot.messageId = messageId;
          },
        });
        runCardSent = sent;
      } else {
        // streaming succeeded: run card is the last message in the chat
        // runCardSent stays false - streaming card exists but no new card sent
      }

      // Send a notification card when a fallback card was sent (unsent case)
      // but NOT when streaming succeeded (card already shows completion).
      const sessionId = cardSession.currentState.sessionId;
      if (sessionId && runCardSent) {
        await this.sendCompletionNotificationCard(
          sessionId,
          cwd,
          ctx,
          activeRun.agentKind,
          cardSession.currentState.terminal,
        );
      }

      if (finalRender.finalAnswerStatus === 'overflow' && finalRender.finalAnswerText) {
        await this.sendFinalAnswerFile(finalRender.finalAnswerText, ctx);
      }

      // Add a terminal-state emoji reaction to the user's original message
      this.finishTurnReactions(ctx, terminalReactionEmoji(cardSession.currentState.terminal));

      // 后台任务跨 turn：卡片收尾只是"这一轮的投影结束了"，任务本身可能还在跑。
      // 订阅放在最后：卡片已落地，patch 才有落点。
      this.jobWatch.startBackgroundJobWatch(runId, snapshot, activeRun.runner);
    } finally {
      // cleanup must survive mid-finalize errors. The only unguarded
      // expression in finalizeRun is the renderRunCard(...) argument evaluated
      // at the sendResult call site; if it throws, the run must still release
      // its activeRuns slot — otherwise the cwd is permanently busy
      // (every later message busy-dropped until a manual /stop).
      //
      // 记账与槽位所有权必须分开：/stop、停止卡按钮、
      // queue.immediate 都会先在 interruptCurrentRunDetailed 里删掉
      // activeRuns[cwd] 并把卡片置 interrupted，等收尾走到这里时下面的守卫
      // 已为 false。记录若跟着守卫走，中断后的终态卡上 Compact 按钮必然查不到
      // runId，只能回「该任务已结束或不属于当前会话」。守卫只回答「cwd 槽位还
      // 归不归本 run」（决定能不能删槽位/evict runner），记账回答「这次 run
      // 结束了吗、用的哪个 sessionId」——后者与所有权无关，放在守卫外。
      this.compact.recordCompactableRunForTerminal(cardSession, activeRun, ctx);

      if (this.activeRuns.get(cwd) === activeRun) {
        this.activeRuns.delete(cwd);
        // Workspace-lifetime runners (codex app-server) keep their persistent
        // connection across runs: evicting here would kill the connection after
        // EVERY run, defeating lifetime='workspace' + idle TTL. They are still
        // evicted+disposed by clearRunners (/config) and interruptCurrentRun
        // (/stop). Spawn-per-message runners are evicted as before to prevent
        // stale process references accumulating.
        // 配置变更期间（clearRunners 标了 stale）的 workspace-lifetime
        // runner 也必须在 run 结束后 evict，否则下一轮复用旧配置实例。
        const slotKey = `${cwd}\u0000${activeRun.agentKind}`;
        if (activeRun.runner.lifetime !== 'workspace' || this.staleRunnerSlots.has(slotKey)) {
          this.evictRunnerSlot(cwd, activeRun.agentKind);
        }
        this.staleRunnerSlots.delete(slotKey);
        getLogger().info(`[lark-remote] activeRuns.delete cwd=${cwd} runId=${runId}`);
      }
    }
  }

  /**
   * Send a notification card when a run completes.
   * This card contains the session summary and a button to resume the session.
   * It's sent as a new message (not updating the run card) so users can easily
   * find and return to this session without scrolling up.
   */
  private async sendCompletionNotificationCard(
    sessionId: string,
    cwd: string,
    ctx: CommandContext,
    agentKind: AgentKind = this.config.defaultAgent,
    terminal: RunTerminal = 'done',
  ): Promise<void> {
    const presentation = completionNotificationPresentation(terminal);
    try {
      // cap the events read for the notification card — without
      // maxEvents claude returns every event after the last user message and
      // the card blows past Feishu's 28KB budget.
      const content = this.sessionReaderRegistry.get(agentKind).readSessionContent(sessionId, cwd, {
        maxEvents: COMPLETION_NOTIFICATION_MAX_EVENTS,
      });
      const { events, usage } = content;

      const card = buildSessionHistoryCard(
        {
          sessionId,
          cwd,
          events,
          usage,
        },
        {
          agentKind,
          headerText: `📂 \`${cwd}\`\n会话: **${sessionId}**`,
          title: presentation.title,
          ...(presentation.result ? { usageResult: presentation.result } : {}),
          actions: [resumeUseButton(sessionId, agentKind)],
          headerTemplate: presentation.template,
        },
      );

      // send through sendResult so enforceCardBudget guards the card
      // (previously sent via connector directly, bypassing the budget — long
      // sessions produced >28KB cards that Feishu silently rejected).
      const sent = await this.sendResult({ card }, ctx);
      if (sent) {
        getLogger().debug(
          `[lark-remote] completion notification sent sessionId=${sessionId} chatId=${ctx.chatId}`,
        );
      } else {
        getLogger().warn(
          `[lark-remote] failed to send completion notification card sessionId=${sessionId}`,
        );
      }
    } catch (err) {
      getLogger().warn(`[lark-remote] failed to send completion notification card:`, err);
    }
  }

  // =============================================================================
  // Approval action handlers
  // =============================================================================
  // 实现住在 approval-actions.ts：这 7 个入口只碰
  // approvalCoordinators 一张表，不碰其余 Bridge 状态。方法名保持 Bridge 的
  // 公开 API 不变——router 的 APPROVAL_ACTION_SPECS 按名字分发。

  /** 审批响应（卡片按钮）→ ApprovalCoordinator.submit。 */
  async handleApprovalRespond(opts: {
    runId: string;
    requestId: number | string;
    decision: string;
    nonce: string;
  }): Promise<void> {
    return this.approvalActions.handleApprovalRespond(opts);
  }

  /** 计划审批修改意见（ExitPlanMode 输入框）→ coordinator.planFeedback。 */
  async handleApprovalPlanFeedback(opts: {
    runId: string;
    requestId: number | string;
    text: string;
    nonce: string;
  }): Promise<void> {
    return this.approvalActions.handleApprovalPlanFeedback(opts);
  }

  /** 权限条目勾选（卡片按钮）→ coordinator.togglePerm。 */
  async handleApprovalToggle(opts: {
    runId: string;
    requestId: number | string;
    permId: string;
    selected?: boolean;
  }): Promise<void> {
    return this.approvalActions.handleApprovalToggle(opts);
  }

  /** AskUserQuestion 选项点击 → coordinator.toggleAnswer。 */
  async handleApprovalAnswer(opts: {
    runId: string;
    requestId: number | string;
    questionIndex: number;
    option: string;
    nonce: string;
  }): Promise<void> {
    return this.approvalActions.handleApprovalAnswer(opts);
  }

  /** AskUserQuestion 多选「提交答案」→ coordinator.submitAnswers。 */
  async handleApprovalAnswerSubmit(opts: {
    runId: string;
    requestId: number | string;
    questionIndex: number;
    nonce: string;
  }): Promise<void> {
    return this.approvalActions.handleApprovalAnswerSubmit(opts);
  }

  /** AskUserQuestion 自定义答案（Other）→ coordinator.answerCustom。 */
  async handleApprovalAnswerCustom(opts: {
    runId: string;
    requestId: number | string;
    questionIndex: number;
    text: string;
    nonce: string;
  }): Promise<void> {
    return this.approvalActions.handleApprovalAnswerCustom(opts);
  }

  /** AskUserQuestion 补充说明（user_note）→ coordinator.answerNote。 */
  async handleApprovalAnswerNote(opts: {
    runId: string;
    requestId: number | string;
    questionIndex: number;
    text: string;
    nonce: string;
  }): Promise<void> {
    return this.approvalActions.handleApprovalAnswerNote(opts);
  }

  // =============================================================================
  // Compact 动作入口
  // =============================================================================
  // 实现住在 compact.ts（bridge 结构治理第 1 刀）：可压缩 run 记账、终态卡 /
  // resume 卡两条入口、kimi 在途检测与压缩流式卡全部搬过去；这里只留薄转发，
  // router 的卡片动作分发（handleCardAction → bridge.handleCompactAction /
  // handleResumeCompact）与 finalizeRun 的终态记账调用路径不变。

  /** 终态卡 Compact 按钮：按 runId 反查那次 run 的会话并发起压缩。 */
  async handleCompactAction(value: { runId?: string }, ctx: CommandContext): Promise<void> {
    await this.compact.handleCompactAction(value, ctx);
  }

  /** resume 卡 Compact 按钮：直接压缩卡上指定的 session（无需 runId）。 */
  async handleResumeCompact(
    value: { sessionId?: string; agent?: string },
    ctx: CommandContext,
  ): Promise<void> {
    await this.compact.handleResumeCompact(value, ctx);
  }

  // =============================================================================
  // 宿主轮次 stop 入口（DSH）
  // =============================================================================
  // 实现住在 host-stop.ts：恢复卡「终止」按钮与 /stop 的 fallback 共用同一
  // 条 session/cancel 路径；本地 activeRuns/bash 的停止语义不变。

  /** 恢复卡「终止」按钮：取消卡上指定 session 的宿主 turn。 */
  async handleStopSession(
    value: { sessionId?: string; agent?: string; cwd?: string },
    ctx: CommandContext,
  ): Promise<void> {
    await this.hostStop.handleCardAction(value, ctx);
  }

  /**
   * `/stop` 在本地 activeRuns/bash 全部 miss 后的 fallback：只停当前用户、
   * 当前 cwd、默认 agent 的当前 session；非 DSH / 没有 session 时返回 undefined，
   * 调用方维持「当前没有运行中的进程」。
   */
  async stopCurrentHostTurn(userId: string): Promise<HostTurnStopResult | undefined> {
    return await this.hostStop.stopCurrent(userId);
  }

  // =============================================================================
  // `!` bash 命令
  // =============================================================================
  // 实现住在 bash-run.ts（bridge 结构治理第 3 刀）：executeBash 薄壳、事件流
  // 消费、独立登记表（activeBashRuns，不进 activeRuns）与 /stop 的 bash 侧
  // 匹配全部搬过去。这里只留薄转发——router 的 `!` 分发（executeBash）与
  // /active 投影（getActiveBashRuns）按 bridge 公开 API 调用。

  /** Execute a bash command and stream output to a card（`!` 命令入口）。 */
  async executeBash(command: string, ctx: CommandContext): Promise<void> {
    await this.bashRuns.executeBash(command, ctx);
  }
}
