import { randomUUID } from 'node:crypto';
import type { Runner, AgentRunner, AgentEvent, AgentSessionReader } from '../runner/index.js';
import { sleep } from '../common/sleep.js';
import { isContentFilterFailure } from '../common/turn-failure.js';
import type { AgentRegistry } from '../runner/registry.js';
import type { SessionReaderRegistry, SessionStore } from '../session/index.js';
import type { AppConfig } from '../config/index.js';
import { resolveFinalUsage, errorMessage } from './final-usage.js';
import { getLogger } from '../logger/index.js';
import { RunCardSession, type RunCardChannel } from '../card/run-card-session.js';
import {
  renderRunCard,
  renderRunCardDetailed,
  type RunCardRenderOptions,
} from '../card/run-renderer.js';
import { splitFinalAnswer } from '../card/final-answer-overflow.js';
import { renderBashCard } from '../card/bash-renderer.js';
import { BashCardSession, capBashOutput } from '../card/bash-card-session.js';
import { isRunTerminal, type RunState, type RunTerminal } from '../card/run-state.js';
import { buildSessionHistoryCard } from '../router/card-helpers.js';
import { agentDisplayName, resumeUseButton } from '../card/card-shared.js';
import { enforceCardBudget } from '../card/card-budget.js';
import { RunUsageCollector } from './run-usage.js';
import { BashProcessRunner, type BashRunner } from '../runner/index.js';
import { AGENT_KINDS, supportsCompact, type AgentKind, type StopOutcome } from '../runner/types.js';
import {
  QueueManager,
  type QueuedTask,
  type EnqueueOptions,
  type AgentBinding,
  type ExecutingInfo,
} from './queue-manager.js';
import { ApprovalCoordinator, decisionToApprovalAction } from './approval-coordinator.js';
import type { ApprovalAction, ApprovalToggleAction } from './approval-coordinator.js';
import { createRunApprovalCoordinator, remindPendingApproval } from './run-approval.js';
import {
  writeBackInitSession,
  writeBackResultSession,
  writeBackTurnStarted,
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
 * Emoji reaction per run terminal state, so a glance at the user's original
 * message distinguishes how the run ended. Unknown/non-terminal states fall
 * back to 'Done' (default).
 */
const TERMINAL_REACTION_EMOJI: Partial<Record<RunTerminal, string>> = {
  error: 'ERROR',
  idle_timeout: 'Alarm',
  interrupted: 'SHHH',
};

function terminalReactionEmoji(terminal: RunTerminal): string {
  return TERMINAL_REACTION_EMOJI[terminal] ?? 'Done';
}

/**
 * Seam (§7): the channel capabilities the bridge needs. `sendWithRetry` is
 * the minimum a Feishu channel must offer for the bridge to push messages
 * through it. Declared here so tests can satisfy it structurally without
 * `as unknown as` casts.
 */
interface BridgeChannel extends RunCardChannel {
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
 * 单点化：`'runCompact' in runner` 鸭子探测
 * codex app-server + kimi/opencode ACP runner 满足。
 */
function runnerHasRunCompact(runner: Runner): boolean {
  return (
    'runCompact' in runner && typeof (runner as Record<string, unknown>).runCompact === 'function'
  );
}

/**
 * 已告警过的能力不一致 kind。能力表（`COMPACT_CAPABILITY`）是声明，runner 方法
 * 是实现；两者不一致是开发期缺陷，只在首次冲突时打 error，避免每次渲染刷屏。
 */
const compactMismatchWarned = new Set<AgentKind>();

/**
 * Compact 能力的双重门控：声明的能力表 && runner 实际实现。
 *
 * 只做鸭子探测会把「漏实现」降级成静默隐藏按钮（dsh 就这样漏了），所以声明表
 * 是必需项；只信声明表则可能渲染出点不动的死按钮，所以实现检查也保留。两者
 * 不一致时打 error 日志，让缺陷在运行日志里可见。
 */
function runnerSupportsCompact(runner: Runner, kind: AgentKind): boolean {
  const declared = supportsCompact(kind);
  const implemented = runnerHasRunCompact(runner);
  if (declared !== implemented && !compactMismatchWarned.has(kind)) {
    compactMismatchWarned.add(kind);
    getLogger().error(
      `[lark-remote] compact capability mismatch kind=${kind} declared=${declared} implemented=${implemented}`,
    );
  }
  return declared && implemented;
}

/**
 * 每个 cwd 保留的「可压缩 run」条数上限。Compact 按钮挂在终态 run 卡片上，
 * 卡片会被后续消息不断顶上去；无上限会让长跑进程随 run 数无界增长，而用户
 * 实际能点到的只有最近几张卡，20 条足以覆盖。
 */
const MAX_COMPACTABLE_RUNS_PER_CWD = 20;

/**
 * 终态 run 卡片 Compact 按钮的取参记录。按钮只带 runId（渲染期 sessionId 可能
 * 还没到，runId 一定在），点击时据此反查该次 run 实际使用的会话。
 */
interface CompactRunRecord {
  sessionId: string;
  agentKind: AgentKind;
  /**
   * 该次 run 实际执行的工作目录。按 runId 反查时会跨 cwd 命中，压缩必须回到
   * run 自己的 cwd（session 文件、runner 实例都按 cwd 解析），不能取用户
   * 「当前」cwd —— 点击时可能已经 /cd 到别处，或排队期间被 /cd 改写。
   */
  cwd: string;
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
}

interface ActiveRun {
  runId: string;
  userId: string;
  chatId: string;
  session: RunCardSession;
  cwd: string;
  /**
   * The exact runner instance that is running this run. interruptCurrentRun
   * stops THIS instance directly rather than re-resolving via getRunner(cwd),
   * so the runner is reachable even after clearRunners() empties the cache
   * mid-run (regression 2026-07-18: a fresh empty runner's stop() was a no-op,
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
interface IdleWatchdog {
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
   * Fix 4 (2026-07-18): Each agentKind has its own cache slot, so switching
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
  /**
   * 最近若干次已完成的、runner 有 runCompact 的 run（cwd → runId → 记录）。
   * run 结束后 activeRuns 已清空，而终态卡上的 Compact 按钮只带 runId，
   * 需要它反查 sessionId + agentKind。
   *
   * 为什么按 runId 存而不是「每 cwd 只留最新一条」：compact 卡片动作走串行
   * 队列（会被正在跑的 run 挡住），点击到执行之间可能夹着别的 run 收尾。
   * 单槽会被覆盖 —— 旧卡片的压缩必然报「该任务已结束或不属于当前会话」，
   * 与 session 是否还在、能否压缩无关（2026-10-08 线上缺陷）。
   */
  private compactableRuns = new Map<string, Map<string, CompactRunRecord>>();

  /**
   * 终态卡片的渲染快照（runId → state + options）：run 结束后 activeRuns 已
   * 清空，而卡片上的「⏹ 停止」后台任务按钮（job.kill）还活着，需要按 runId
   * 反查该 run 的 sessionId/cwd 才能停对任务。只保留最近若干条：单条快照受
   * MAX_BLOCKS 约束（几十 KB 以内），用户只会点刚收到的卡；超出窗口的旧卡
   * 会得到明确的「记录已回收」提示，不假装任务仍在。
   */
  private runCardSnapshots = new Map<
    string,
    { state: RunState; options: RunCardRenderOptions; cwd: string; agentKind: AgentKind }
  >();
  private static readonly RUN_CARD_SNAPSHOT_MAX = 8;

  /**
   * Active `!` bash runs, keyed by runId (NOT cwd). Bash runs bypass the serial
   * queue and may run in parallel with claude runs / other bash runs in the same
   * cwd, so they live outside `activeRuns`. Tracked so `/stop` can reach
   * the per-run BashRunner instance via interruptCurrentRun.
   */
  private activeBashRuns = new Map<
    string,
    {
      bashRunner: BashRunner;
      cardSession: BashCardSession;
      userId: string;
      chatId: string;
      cwd: string;
      command: string;
    }
  >();

  constructor(deps: BridgeDeps) {
    this.connector = deps.connector;
    this.sessionStore = deps.sessionStore;
    this.config = deps.config;
    this.workspaceStore = deps.workspaceStore;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.agentRegistry = deps.agentRegistry;
    this.sessionReaderRegistry = deps.sessionReaderRegistry;

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
  }

  /**
   * Get or create a runner for the given cwd, keyed by current defaultAgent.
   *
   * Fix 4 (2026-07-18): Cache key includes agentKind, so switching defaultAgent
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
       * 仅在开跑路径（forwardToClaude / streamCompact）传 true：hasRunCompact、
       * killBackgroundJob 这类「借 runner 看一眼」的调用不能触发实例替换。
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
    // Call lifecycle methods for agent runners created via factory
    if (runner && typeof runner.killOrphan === 'function') {
      runner.killOrphan();
    }
    if (runner && typeof runner.registerExitHandlers === 'function') {
      runner.registerExitHandlers();
    }

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
      const runner = active.runner as unknown as {
        updateApprovalMode?(settings: Record<string, unknown>): Promise<void>;
      };
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
    const agents = this.config.agents;
    switch (kind) {
      case 'codex': {
        const codexConfig = agents?.codex;
        if (!codexConfig) return undefined;
        return {
          approvalPolicy: codexConfig.approvalPolicy,
          sandbox: codexConfig.sandbox,
        };
      }
      case 'kimi': {
        const kimiConfig = agents?.kimi;
        if (!kimiConfig) return undefined;
        return { permissionMode: kimiConfig.permissionMode };
      }
      case 'opencode': {
        const opencodeConfig = agents?.opencode;
        if (!opencodeConfig) return undefined;
        return { mode: opencodeConfig.mode };
      }
      case 'dsh': {
        const dshConfig = agents?.dsh;
        if (!dshConfig) return undefined;
        return { permissionPreset: dshConfig.permissionPreset };
      }
      default:
        return undefined;
    }
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
    // the instance that owns the live subprocess (regression 2026-07-18 -- the
    // running runner became unreachable, stop() hit a fresh empty runner, the
    // real subprocess was never killed and the queue chain blocked forever).
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
      if (state.terminal === 'running' || state.terminal === 'finalizing') {
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
    const result: Array<{
      runId: string;
      cwd: string;
      userId: string;
      chatId: string;
      terminal: RunTerminal;
      command: string;
    }> = [];

    for (const [runId, bashRun] of this.activeBashRuns) {
      const state = bashRun.cardSession.currentState;
      // Only include non-terminal runs (bash has no finalizing state)
      if (state.terminal === 'running') {
        result.push({
          runId,
          cwd: bashRun.cwd,
          userId: bashRun.userId,
          chatId: bashRun.chatId,
          terminal: state.terminal,
          command: bashRun.command,
        });
      }
    }

    return result;
  }

  async interruptCurrentRun(input: {
    userId: string;
    chatId: string;
    runId?: string;
    /** Restrict the match to a single cwd (queue.immediate). When
     * omitted, all workspaces are candidates (used by /stop, /t, and card stop button which don't know which cwd to target). */
    cwd?: string;
  }): Promise<boolean> {
    return (await this.interruptCurrentRunDetailed(input)).stopped;
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
    cwd?: string;
  }): Promise<InterruptOutcome> {
    // 先收集全部命中项再逐个停。activeRuns 以 cwd 为键、多个 workspace 可以
    // 并行跑；旧实现停在「第一条命中」就 return —— 两个 workspace 并行时
    // `/stop` 只停一个却回「已停止」，另一个无声继续。
    // 限定 cwd（queue.immediate）或带 runId（停止卡按钮）时仍只有一条命中。
    const activeTargets: Array<[string, ActiveRun]> = [];
    for (const [cwd, active] of this.activeRuns) {
      if (input.cwd !== undefined && cwd !== input.cwd) continue;
      if (active.userId !== input.userId || active.chatId !== input.chatId) continue;
      if (input.runId && active.runId !== input.runId) continue;
      activeTargets.push([cwd, active]);
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
    // Then check active bash runs (! commands). These bypass the serial queue
    // and are tracked separately; stop the per-run BashRunner directly.
    // `/stop`（无 runId、无 cwd）语义是「停掉这个会话的一切」，所以并行跑的
    // `!` 命令也要停——旧实现命中 claude run 就 return，这些 bash 会被漏掉。
    // 带范围的中断（停止卡 runId、queue.immediate 的 cwd）保持旧语义：只有
    // 没有 claude run 命中时才回退到 bash，避免误杀用户并行跑的 `!` 任务。
    const includeBashRuns =
      (input.runId === undefined && input.cwd === undefined) || activeTargets.length === 0;
    const bashTargets = includeBashRuns
      ? [...this.activeBashRuns.entries()].filter(([runId, b]) => {
          if (input.cwd !== undefined && b.cwd !== input.cwd) return false;
          if (b.userId !== input.userId || b.chatId !== input.chatId) return false;
          if (input.runId && runId !== input.runId) return false;
          return true;
        })
      : [];
    for (const [runId, b] of bashTargets) {
      getLogger().info(
        `[lark-remote] interrupt hit bash runId=${runId} cwd=${b.cwd} userId=${input.userId}`,
      );
      await b.bashRunner.stop({ immediate: true });
      // Update card to show interrupted state. exitCode 不传（保持 null）：
      // bash-renderer 的「已手动终止」文案要求 exitCode === null；传 -1 会让
      // 该分支不可达，中断卡退化成「退出码: -1」的失败样式。
      await b.cardSession.finish('interrupted');
      this.activeBashRuns.delete(runId);
      getLogger().info(`[lark-remote] interrupt bash stop done runId=${runId}`);
      stoppedCount++;
    }
    if (stoppedCount === 0) {
      getLogger().debug(`[lark-remote] interrupt miss userId=${input.userId}`);
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
    // runner whose stop() is a no-op and the real subprocess is never killed
    // (regression 2026-07-18: queue chain blocked forever).
    const runner = active.runner;
    // Bind the queue reset to THIS task's execution slot: the stop window
    // below may outlive the task's settle, letting the serial chain advance
    // to a successor that begins executing before we resume. An
    // unconditional reset would then zero the successor's count and mark
    // its slot interrupted, hiding it from queue cards.
    const stoppedSlot = this.queueManager.getExecutingSlot(cwd);
    const [, stopResult] = await Promise.allSettled([
      // 用户主动中断（/stop、stop 卡按钮、queue.immediate）显式打标
      // interruptedReason，与审批超时自动取消（approval_timeout）、审批
      // 卡取消（approval_cancelled）在终态数据上可区分（方案 A）。
      active.session.finish('interrupted', { interruptedReason: 'user_stop' }),
      runner.stop({ immediate: true }),
    ]);
    const stop =
      stopResult.status === 'fulfilled' &&
      stopResult.value !== null &&
      typeof stopResult.value === 'object'
        ? (stopResult.value as StopOutcome)
        : undefined;
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
    // agent 侧会话写锁（codex "thread already has an active writer"，
    // 线上实测）。改为标 stale：下一次「即将开跑」的 getRunner 在槽位空闲时
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
    getLogger().info(`[lark-remote] interrupt stop done runId=${active.runId}`);
    return stop;
  }

  /** Send a result message to the user (§7). Returns true on success, false on failure. */
  async sendResult(result: CommandResult, ctx: CommandContext): Promise<boolean> {
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
        await this.connector.sendWithRetry(
          ctx.chatId,
          { card: safeCard },
          { replyTo: ctx.messageId },
        );
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
   * Deliver a final answer that cannot fit in the run card. Plain text avoids
   * markdown parser limits and preserves every character; sequence labels make
   * multi-message delivery unambiguous.
   */
  private async sendFinalAnswerOverflow(text: string, ctx: CommandContext): Promise<void> {
    const chunks = splitFinalAnswer(text);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const prefix =
          chunks.length > 1 ? `完整回答（${i + 1}/${chunks.length}）\n\n` : '完整回答\n\n';
        await this.connector.sendWithRetry(
          ctx.chatId,
          { text: prefix + chunks[i] },
          { replyTo: ctx.messageId },
        );
      }
    } catch (err) {
      getLogger().error('[lark-remote] failed to deliver complete final answer:', err);
      try {
        await this.connector.sendWithRetry(
          ctx.chatId,
          { text: `⚠️ 完整回答补发失败：${errorMessage(err)}` },
          { replyTo: ctx.messageId },
        );
      } catch (fallbackErr) {
        getLogger().error('[lark-remote] final-answer failure notice also failed:', fallbackErr);
      }
    }
  }

  /**
   * Update an existing card in place (原地更新) instead of sending a new one.
   *
   * Used by /config cardAction handlers (config.toggle/set/input/save) so the
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
      getLogger().debug(
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
  ): void {
    this.runCardSnapshots.set(runId, { state, options, cwd, agentKind });
    while (this.runCardSnapshots.size > Bridge.RUN_CARD_SNAPSHOT_MAX) {
      const oldest = this.runCardSnapshots.keys().next().value;
      if (oldest === undefined) break;
      this.runCardSnapshots.delete(oldest);
    }
  }

  /**
   * 停止终态卡上的一个后台任务。
   *
   * 后台任务的生命周期跨 run（这就是它需要单独入口的原因），所以解析路径是
   * 终态快照（runId → sessionId/cwd/agentKind）+ 该工作区的 runner 实例，
   * 而不是 activeRuns。成功后同步摘掉 state 里的任务并就地重渲染，否则按钮
   * 会留在卡片上而任务早已结束。
   */
  async killBackgroundJob(runId: string, jobId: string, ctx: CommandContext): Promise<boolean> {
    const snapshot = this.runCardSnapshots.get(runId);
    const sessionId = snapshot?.state.sessionId;
    if (!snapshot || !sessionId) return false;
    const runner = this.getRunner(snapshot.cwd, snapshot.agentKind) as Runner & {
      killJob?: (sessionId: string, jobId: string) => Promise<boolean>;
    };
    if (typeof runner.killJob !== 'function') return false;
    const killed = await runner.killJob(sessionId, jobId);
    if (!killed) return false;
    snapshot.state = {
      ...snapshot.state,
      backgroundJobs: (snapshot.state.backgroundJobs ?? []).filter((job) => job.id !== jobId),
    };
    await this.updateCardInPlace(renderRunCard(snapshot.state, snapshot.options), ctx);
    return true;
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
        `agent=${agentKind} sessionId=${opts?.binding?.sessionId ?? entry?.sessions?.get(agentKind) ?? '(none)'} message=${message.slice(0, 100)}`,
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

    // 会话代际快照（2026-08-09，2026-10-07 前移）：/new、/cd、/resume 会 bump
    // epoch，该 run 后续 system.init 的 sessionId 写回即判 stale 跳过。
    // 快照点优先取 binding.sessionEpoch（入队/commit 时刻，与 sessionId 同刻）：
    // 排队消息在「commit 后、开跑前」被 reset 时，执行起点捕获会漏判（epoch 已是
    // bump 后的值）→ 旧 sessionId 被写回复活 reset。无 binding 时回退执行起点捕获，
    // 保持非排队路径（如 /compact）的既有语义。
    const sessionEpochAtStart =
      opts?.binding?.sessionEpoch ?? this.sessionStore.getSessionEpoch(ctx.userId, agentKind);

    // Resolve the runner BEFORE creating the run session so the exact instance
    // that will run is captured into activeRun. interruptCurrentRun stops THAT
    // instance directly -- never a fresh runner re-resolved from a cache that
    // clearRunners() may have emptied mid-run (regression 2026-07-18).
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
   * 于是一次（多数是误报的）判定就把整个 turn 判死。2026-10-21 现场：60 步、
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
        void Promise.allSettled([
          opts.session.finish('idle_timeout', {
            idleTimeoutMinutes: Math.max(1, Math.round(this.idleTimeoutMs / 60_000)),
          }),
          opts.runner.stop(),
        ]);
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
    // Runner 声明的 usage 权威来源：codex app-server = 'live'
    // （turn/started 的 tokenUsage.last 是本 turn 增量）。其余 runner 未声明。
    const usageAuthority = (
      runner as Runner & { getUsageAuthority?: () => 'live' | 'jsonl' }
    ).getUsageAuthority?.();

    // §9.12 空闲看门狗：判定口径见 startIdleWatchdog；武装点在 cardSession.start() 之后。
    let watchdog: IdleWatchdog | null = null;
    let sawResult = false;
    // A runner can fail before emitting its synthetic system/init (e.g. DSH
    // session/create -> 401). The pre-init guard below drops that result to
    // protect Claude resume replay, but if the stream ends without ever seeing
    // init the result was the only terminal signal we had. Keep it so the card
    // shows the real error instead of the generic "no result" fallback.
    let pendingPreInitTerminal:
      { subtype: 'error' | 'interrupted'; errorMessage?: string } | undefined;
    const usage = new RunUsageCollector();

    try {
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

      if (cardSession.currentState.terminal !== 'running') {
        // Card session did not enter running state - still try to send static fallback
        getLogger().info(`[lark-remote] cardSession not running, using static fallback`);
      }

      // 单 interval 看门狗。事件到来时只刷新时间戳（无 timer 操作）；
      // interval 周期检查静默时长，超时才 finish('idle_timeout') + stop()。
      // 武装点在建卡之后，与原实现一致（宽限期不含 cardSession.start() 耗时）。
      watchdog = this.startIdleWatchdog({
        runId,
        session: cardSession,
        runner,
        pendingApprovals: () => this.approvalCoordinators.get(runId)?.pendingCount() ?? 0,
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
        if (event.type === 'system' && event.subtype === 'init') {
          sawInit = true;
          // 本轮真实使用的 session（不可变身份）：指针在 run 中被 /new 等移动时，
          // 结束后的 usage 读取仍以它为准。
          activeRun.sessionId = event.session_id;
          writeBackInitSession(writeback, event);
          getLogger().info(
            `[lark-remote] system.init received runId=${runId} sessionId=${event.session_id} cwd=${event.cwd}`,
          );
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
        if (
          event.type === 'system' &&
          event.subtype === 'compact_boundary' &&
          event.compactMetadata
        ) {
          usage.observeCompaction(event.compactMetadata.postTokens);
        }
        if (event.type === 'result') {
          // Pre-init result guard: Claude CLI --resume emits a stale result
          // (from the previous turn) before system.init. Ignoring it prevents
          // premature sawResult/usage capture and the run-state reducer (which
          // also guards on sessionId === undefined) from transitioning to
          // finalizing too early. The real result for this run arrives after
          // system.init.
          //
          // Exception: app-server runners (usageAuthority === 'live') 的 init
          // 是 runner 补发的 synthetic init（2026-08-13 修复）。此分支保留为
          // 防御性兜底：任何 live runner 若在无 init 时发出 result（如旧构建、
          // 其它 live runner），session 写回仍执行，但 sawResult 保持 false，
          // 卡片不会把半初始化的 run 当作已收尾。
          const preInitResult = !sawInit;
          if (preInitResult && usageAuthority !== 'live') {
            getLogger().info(
              `[lark-remote] pre-init result ignored (resume replay) runId=${runId}`,
            );
            if (event.subtype === 'error' || event.subtype === 'interrupted') {
              pendingPreInitTerminal ??= {
                subtype: event.subtype,
                errorMessage: (event as { errorMessage?: string }).errorMessage,
              };
            }
            // Still reset idle timer — the CLI is alive and producing events.
            watchdog?.touch();
            // Do NOT push to cardSession: the run-state reducer would also
            // skip it (sessionId === undefined), but skipping at the bridge
            // layer avoids the push + render overhead for a no-op event.
            continue;
          }
          if (preInitResult && (event.subtype === 'error' || event.subtype === 'interrupted')) {
            pendingPreInitTerminal ??= {
              subtype: event.subtype,
              errorMessage: (event as { errorMessage?: string }).errorMessage,
            };
          }
          if (!preInitResult) {
            sawResult = true;
          }
          usage.observeResult(event);
          getLogger().info(
            preInitResult
              ? `[lark-remote] pre-init result from live runner (app-server setup failure) runId=${runId}`
              : `[lark-remote] result event received runId=${runId}`,
          );

          // app-server 模式 setup 失败路径（thread/start 成功后 turn/start 失败）
          // 不会有 turn_started 事件，store 不会写回新线程 id；runner 已在 result
          // 里兜底上报。此处仅当 runner 声明 live usage（app-server）
          // 且会话指针未动时写回，避免下条消息再开一个孤儿线程。其余 agent 不在
          // 此列（它们各自有 system.init / turn_started 写回）。
          if (usageAuthority === 'live') writeBackResultSession(writeback, event.session_id);
        }
        // Approval events (Codex app-server mode)
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
        } else if (event.type === 'approval_resolved') {
          const coordinator = this.approvalCoordinators.get(runId);
          coordinator?.onResolved(event.requestId);
        } else if (event.type === 'approval_view_updated') {
          // 乱序流：审批先到、item/started 后到，补全审批卡内容。coordinator
          // 仅在 pending 时更新（已响应/过期不复活）。
          const coordinator = this.approvalCoordinators.get(runId);
          coordinator?.updateView(event.requestId, event.view);
        }
        // §9.12 红线：每个事件（含 result）无条件刷新
        // lastEventTs 重新武装看门狗。result 后 CLI 进程做 jsonl flush/清理（finalizing
        // 过渡）期间，宽限期恢复为完整的 idleTimeoutMs，避免已产出结果的 turn 被误标
        // idle_timeout。旧实现 `else { resetIdle(); }` 漏掉 result 分支。
        watchdog?.touch();

        await cardSession.push(event);
      }
      getLogger().info(`[lark-remote] runner stream end runId=${runId} sawResult=${sawResult}`);

      // §9.12 红线：for-await 自然结束 = CLI 已退出，
      // 看门狗使命结束，立即摘除 interval（不再等 finally），堵掉「stream 已结束、
      // 收尾处理跨过死线被误标 idle_timeout」的同源小窗口（随本修复一并关闭）。
      watchdog?.stop();

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

      // for-await 自然结束 = stream 关闭 = CLI 进程退出。
      // 进程退出（for-await end）= 唯一终态触发源。
      // 1) finalizing（result 已收到）-> 转 done/error + usage meta
      // 2) running（未收到 result）-> 错误路径
      // 3) 已终态 + sawResult -> 补充 usage meta（不改 terminal）
      const finalState = cardSession.currentState;
      if (finalState.terminal === 'finalizing') {
        // 三态终态映射（2026-08-14）：interrupted（审批超时/取消、/stop）是独立
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
        await cardSession.finish(terminal, {
          resultSubtype: subtype,
          errorMsg: finalState.errorMsg,
          ...usage.meta(),
        });
      } else if (finalState.terminal === 'running') {
        if (pendingPreInitTerminal) {
          const terminal =
            pendingPreInitTerminal.subtype === 'interrupted' ? 'interrupted' : 'error';
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
            errorMsg: agentDisplayName(agentKind) + ' 输出流已结束，但未收到 result 事件',
          });
        }
      } else if (sawResult) {
        // 已终态（interrupted/idle_timeout）+ result 已收到：首终态优先，
        // 仅补充 usage meta（finalizing 期间被 /stop 或 idle 超时也展示 token 统计）
        await cardSession.finish(finalState.terminal, usage.meta());
      }
      // else: 已终态且未收到 result（如 spawn 失败后 interrupted）-> 无 usage 可补，跳过
    } catch (err) {
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
      if (catchTerminal === 'running' || catchTerminal === 'finalizing') {
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
        if (sawResult) {
          await cardSession.finish(catchTerminal, usage.meta());
        }
      }
    } finally {
      watchdog?.stop();
      const coordinator = this.approvalCoordinators.get(runId);
      if (coordinator) {
        coordinator.onTurnEnded();
        this.approvalCoordinators.delete(runId);
      }
    }
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
      this.rememberRunCardSnapshot(
        runId,
        cardSession.currentState,
        finalRenderOptions,
        cwd,
        activeRun.agentKind,
      );
      let runCardSent = false;
      if (settleResult === 'unsent') {
        const sent = await this.sendResult({ card: finalRender.card }, ctx);
        runCardSent = sent;
      } else {
        // streaming succeeded: run card is the last message in the chat
        // runCardSent stays false - streaming card exists but no new card sent
      }

      // Send a notification card when a fallback card was sent (unsent case)
      // but NOT when streaming succeeded (card already shows completion).
      const sessionId = cardSession.currentState.sessionId;
      if (sessionId && runCardSent) {
        await this.sendCompletionNotificationCard(sessionId, cwd, ctx, activeRun.agentKind);
      }

      if (finalRender.finalAnswerStatus === 'overflow' && finalRender.finalAnswerText) {
        await this.sendFinalAnswerOverflow(finalRender.finalAnswerText, ctx);
      }

      // Add a terminal-state emoji reaction to the user's original message
      this.finishTurnReactions(ctx, terminalReactionEmoji(cardSession.currentState.terminal));
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
      this.recordCompactableRunForTerminal(cardSession, activeRun, ctx);

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
  ): Promise<void> {
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
          title: '✅ 会话已完成',
          usageResult: 'completed',
          actions: [resumeUseButton(sessionId, agentKind)],
          headerTemplate: 'green',
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

  /**
   * Resolve the ApprovalCoordinator for a run, or throw the standard
   * "已结束" error. Shared preamble of all approval card-action handlers.
   */
  private withCoordinator<T>(
    runId: string,
    fn: (coordinator: ApprovalCoordinator) => Promise<T>,
  ): Promise<T> {
    const coordinator = this.approvalCoordinators.get(runId);
    if (!coordinator) {
      // run 已结束（coordinator 已释放）时点击审批按钮必须给用户明确反馈，
      // 不能静默。router 会把该异常转成 error toast。
      getLogger().warn(`[lark-remote] no approval coordinator for runId=${runId.slice(0, 8)}`);
      throw new Error('任务已结束，审批无法响应');
    }
    return fn(coordinator);
  }

  /**
   * Handle an approval response from a card button click.
   * Routes to the ApprovalCoordinator for the given run.
   */
  async handleApprovalRespond(opts: {
    runId: string;
    requestId: number | string;
    decision: string;
    nonce: string;
  }): Promise<void> {
    const log = getLogger();
    log.info(
      `[lark-remote] handleApprovalRespond runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} decision=${opts.decision}`,
    );
    return this.withCoordinator(opts.runId, async (coordinator) => {
      // Build ApprovalAction from the decision string
      const action: ApprovalAction = decisionToApprovalAction(opts.decision);
      await coordinator.submit(action, { requestId: opts.requestId, nonce: opts.nonce });
    });
  }

  /**
   * 计划审批修改意见（ExitPlanMode 输入框）：记录到 coordinator 并回流卡片。
   * 「拒绝并附意见」/「批准并采纳修改」按钮复用该文本。
   */
  async handleApprovalPlanFeedback(opts: {
    runId: string;
    requestId: number | string;
    text: string;
    nonce: string;
  }): Promise<void> {
    return this.withCoordinator(opts.runId, async (coordinator) => {
      await coordinator.planFeedback(
        { text: opts.text },
        { requestId: opts.requestId, nonce: opts.nonce },
      );
    });
  }

  /**
   * Handle a permission toggle from a card button click.
   * Routes to the ApprovalCoordinator for the given run.
   */
  async handleApprovalToggle(opts: {
    runId: string;
    requestId: number | string;
    permId: string;
    selected?: boolean;
  }): Promise<void> {
    const log = getLogger();
    log.info(
      `[lark-remote] handleApprovalToggle runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} permId=${opts.permId}`,
    );

    return this.withCoordinator(opts.runId, async (coordinator) => {
      // selected 由卡片根据当前渲染状态传回（取反），不再硬编码只授不撤。
      const toggleAction: ApprovalToggleAction = {
        permId: opts.permId,
        selected: opts.selected ?? true,
      };
      await coordinator.togglePerm(toggleAction, { requestId: opts.requestId });
    });
  }

  /**
   * Claude AskUserQuestion 选项点击（单选即时提交 / 多选切换勾选）。
   * 路由到 ApprovalCoordinator.toggleAnswer。
   */
  async handleApprovalAnswer(opts: {
    runId: string;
    requestId: number | string;
    questionIndex: number;
    option: string;
    nonce: string;
  }): Promise<void> {
    return this.dispatchQuestionAction(opts, 'handleApprovalAnswer', (coordinator) =>
      coordinator.toggleAnswer(
        { questionIndex: opts.questionIndex, option: opts.option },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }

  /**
   * Claude AskUserQuestion 多选问题的「提交答案」按钮。
   * 路由到 ApprovalCoordinator.submitAnswers。
   */
  async handleApprovalAnswerSubmit(opts: {
    runId: string;
    requestId: number | string;
    questionIndex: number;
    nonce: string;
  }): Promise<void> {
    return this.dispatchQuestionAction(opts, 'handleApprovalAnswerSubmit', (coordinator) =>
      coordinator.submitAnswers(
        { questionIndex: opts.questionIndex },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }

  /**
   * Claude AskUserQuestion 自定义答案（Other）：自由文本直接
   * 作为该单选问题的答案提交。路由到 ApprovalCoordinator.answerCustom。
   */
  async handleApprovalAnswerCustom(opts: {
    runId: string;
    requestId: number | string;
    questionIndex: number;
    text: string;
    nonce: string;
  }): Promise<void> {
    return this.dispatchQuestionAction(opts, 'handleApprovalAnswerCustom', (coordinator) =>
      coordinator.answerCustom(
        { questionIndex: opts.questionIndex, text: opts.text },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }

  /**
   * Codex AskUserQuestion 补充说明（user_note，2026-08-18 live 验证模型理解
   * "user_note: <text>" 条目）：记录到 coordinator，随答案一起提交。
   * 路由到 ApprovalCoordinator.answerNote。
   */
  async handleApprovalAnswerNote(opts: {
    runId: string;
    requestId: number | string;
    questionIndex: number;
    text: string;
    nonce: string;
  }): Promise<void> {
    return this.dispatchQuestionAction(opts, 'handleApprovalAnswerNote', (coordinator) =>
      coordinator.answerNote(
        { questionIndex: opts.questionIndex, text: opts.text },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }

  private dispatchQuestionAction(
    opts: { runId: string; requestId: number | string; questionIndex: number },
    action: string,
    invoke: (coordinator: ApprovalCoordinator) => Promise<void>,
  ): Promise<void> {
    getLogger().info(
      `[lark-remote] ${action} runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} question=${opts.questionIndex}`,
    );
    return this.withCoordinator(opts.runId, invoke);
  }

  /**
   * 记下一次「可压缩 run」：终态卡上的 Compact 按钮点击时据此反查
   * sessionId + agentKind。runId 是按钮自带的唯一键，同 cwd 内唯一。
   * 超出上限按插入序淘汰最旧的一条（Map 保持插入序；重复写同一 runId
   * 先 delete 再 set 以刷新位置）。
   */
  private recordCompactableRun(
    cwd: string,
    runId: string,
    sessionId: string,
    agentKind: AgentKind,
  ): void {
    let byRunId = this.compactableRuns.get(cwd);
    if (!byRunId) {
      byRunId = new Map();
      this.compactableRuns.set(cwd, byRunId);
    }
    byRunId.delete(runId);
    byRunId.set(runId, { sessionId, agentKind, cwd });
    while (byRunId.size > MAX_COMPACTABLE_RUNS_PER_CWD) {
      const oldest = byRunId.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      byRunId.delete(oldest);
    }
  }

  /**
   * 终态 Compact 记账：把本次 run 实际使用的 sessionId 记进
   * {@link compactableRuns}，供终态卡上的 Compact 按钮按 runId 反查。
   *
   * 调用点固定在 `finalizeRun` 的 `finally` 里、**槽位所有权守卫之外**。
   * 所有权守卫只回答「cwd 槽位还归不归本 run」（决定能否删槽位 / evict
   * runner）；记账回答「本次 run 结束了吗、用的哪个 sessionId」。两者在不同
   * 维度上：外部中断（`/stop`、停止卡按钮、`queue.immediate`）会先摘槽位，
   * 记账若跟着守卫走就永远不会落，中断卡片的按钮必然反查不到（中断
   * 后点 Compact 一律回「该任务已结束或不属于当前会话」）。
   *
   * 覆盖所有终态入口（正常结束、error、interrupted、idle_timeout、
   * goal_continuing）——这些卡片都渲染 Compact 按钮（`goal` 仍 active 时
   * 除外）。记账失败不能影响清理，故内部兜错。
   */
  private recordCompactableRunForTerminal(
    cardSession: RunCardSession,
    activeRun: ActiveRun,
    ctx: CommandContext,
  ): void {
    try {
      if (!runnerSupportsCompact(activeRun.runner, activeRun.agentKind)) return;
      if (activeRun.runner.lifetime !== 'workspace') return;
      const terminal = cardSession.currentState.terminal;
      // 与事件消费守卫、Compact 按钮共用同一份终态集合（run-state.ts）。
      if (!isRunTerminal(terminal)) return;
      // 卡片状态优先（本轮 init/turn_started 写入）；缺失时回退 store——
      // 启动失败但已 /stop 的 run 没有自己的 init，压缩此前会话仍是有意义
      // 的动作。
      const compactSessionId =
        cardSession.currentState.sessionId ??
        this.sessionStore.getSessionId(ctx.userId, activeRun.agentKind);
      if (!compactSessionId) return;
      this.recordCompactableRun(
        activeRun.cwd,
        activeRun.runId,
        compactSessionId,
        activeRun.agentKind,
      );
    } catch (err) {
      getLogger().warn(
        `[lark-remote] compact record failed runId=${activeRun.runId}: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * 按 runId 反查可压缩 run 记录（跨 cwd 扫描）。
   *
   * 为什么不带 cwd 过滤：按钮属于「那一次 run」，与用户此刻在哪个工作目录、
   * 排队期间有没有 /cd 无关。`/stop` 的 interruptCurrentRun 同样是全局按 runId
   * 找（从不查当前 cwd），compact 与它保持一致。用当前 cwd 收窄会让「切了工作区
   * 再点旧卡片」和「排队期间 /cd」两种情况误报「该任务已结束或不属于当前会话」。
   */
  private findCompactableRun(runId: string): CompactRunRecord | undefined {
    for (const byRunId of this.compactableRuns.values()) {
      const record = byRunId.get(runId);
      if (record) return record;
    }
    return undefined;
  }

  /**
   * Handle compact card action — trigger a compaction request for any
   * runCompact-capable runner（codex/kimi/opencode/pi/claude）。按钮带的是
   * 那次 run 的 runId，据此反查该 run 实际使用的 sessionId + agentKind
   * + cwd（compactableRuns，按 runId 记录），再调 runner 的 runCompact()。
   */
  async handleCompactAction(value: { runId?: string }, ctx: CommandContext): Promise<void> {
    const log = getLogger();
    log.info(
      `[lark-remote] handleCompactAction userId=${ctx.userId} runId=${value.runId?.slice(0, 8)}...`,
    );

    const { runId } = value;
    if (!runId) {
      await this.sendResult({ text: '⚠️ 无效的 Compact 请求，缺少 runId' }, ctx);
      return;
    }

    // 校验：run 结束后 activeRuns 已清空，只能靠按钮自带的 runId 反查记录。
    // 按 runId 存（不按「最新的那一条」），点击到执行之间夹了新 run 收尾也不失效；
    // 查找也不按「当前 cwd」收窄（见 findCompactableRun）。
    const target = this.findCompactableRun(runId);
    if (!target) {
      await this.sendResult({ text: '⚠️ 该任务已结束或不属于当前会话' }, ctx);
      return;
    }
    // 压缩必须用那次 run 自己的 cwd（session 文件 + runner 实例都按 cwd 解析）。
    const cwd = target.cwd;

    // §5.3: kimi 压缩在途检测（wire 状态机）。第二次点击在本地毫秒级如实回答，
    // 不开卡、不发 session/prompt——否则 kimi 服务端拒绝并产生「秒回」假完成。
    if (await this.rejectIfCompactionInFlight(target.sessionId, cwd, target.agentKind, ctx)) {
      return;
    }

    // Check that the runner has runCompact method（声明表 && runner 实现）
    const runner = this.getRunner(cwd, target.agentKind, { replaceStale: true });
    if (!runnerSupportsCompact(runner, target.agentKind)) {
      await this.sendResult({ text: '⚠️ 当前运行模式不支持 Compact' }, ctx);
      return;
    }

    log.info(
      `[lark-remote] handleCompactAction executing runCompact for runId=${runId} cwd=${cwd}`,
    );
    await this.streamCompact({
      sessionId: target.sessionId,
      cwd,
      agentKind: target.agentKind,
      runner,
      ctx,
    });
  }

  /**
   * §5.3: kimi 压缩在途检测——reader 鸭子实现 `readCompactionState` 时，若
   * wire 状态机判定当前有未终结的压缩（最后一次 begin 无 terminal 记录），
   * 直接回文本「已有一次 Compact 正在进行」并返回 true（调用方不开卡、不发
   * session/prompt）。codex/claude 等 reader 无此方法 → 返回 false，行为不变。
   */
  private async rejectIfCompactionInFlight(
    sessionId: string,
    cwd: string,
    agentKind: AgentKind,
    ctx: CommandContext,
  ): Promise<boolean> {
    const reader = this.sessionReaderRegistry.get(agentKind);
    if (!reader || !('readCompactionState' in reader)) return false;
    try {
      const state = (
        reader as {
          readCompactionState(
            sessionId: string,
            cwd: string,
          ): { inFlight?: boolean; inFlightSince?: number };
        }
      ).readCompactionState(sessionId, cwd);
      if (state?.inFlight) {
        const since = state.inFlightSince;
        let timeLabel = '未知时刻';
        if (since !== undefined) {
          const d = new Date(since);
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          timeLabel = `${hh}:${mm}`;
        }
        await this.sendResult(
          { text: `⚠️ 已有一次 Compact 正在进行（开始于 ${timeLabel}），请等待完成` },
          ctx,
        );
        return true;
      }
    } catch (err) {
      getLogger().warn(
        `[lark-remote] readCompactionState failed sessionId=${sessionId}: ${errorMessage(err)}`,
      );
    }
    return false;
  }

  /**
   * Stream a compaction to a card: start a RunCardSession with
   * operationKind='compaction' (no recursive Compact button), consume
   * runner.runCompact() events, read authoritative jsonl usage, and finish
   * the card. Shared by handleCompactAction (run card button) and
   * handleResumeCompact (resume cards) so both flows stay in sync.
   *
   * Precondition: callers have already validated that `runner` implements
   * runCompact and that the session exists in `cwd`.
   */
  private async streamCompact(opts: {
    sessionId: string;
    cwd: string;
    agentKind: AgentKind;
    runner: Runner;
    ctx: CommandContext;
  }): Promise<void> {
    const log = getLogger();
    const { sessionId, cwd, agentKind, runner, ctx } = opts;
    log.info(`[lark-remote] streamCompact sessionId=${sessionId} cwd=${cwd}`);

    // 防御性能力检查：调用方已校验（runId / resume 两条路径），此处双保险并
    // 让 TS 收窄 runner 类型（'runCompact' in runner 之后的 cast 才合法）。
    if (
      !runnerSupportsCompact(runner, agentKind) ||
      !('runCompact' in runner) ||
      typeof (runner as Record<string, unknown>).runCompact !== 'function'
    ) {
      await this.sendResult({ text: '⚠️ 当前运行模式不支持 Compact' }, ctx);
      return;
    }

    // activeRuns 以 cwd 为键：注册前先确认槽位空闲，否则压缩会覆盖在跑的 run 的
    // 记录，令 /stop 只停到最后注册的那个。
    const busyWith = this.activeRuns.get(cwd);
    if (busyWith) {
      log.info(`[lark-remote] compact refused: cwd busy cwd=${cwd} runId=${busyWith.runId}`);
      await this.sendResult({ text: '⚠️ 该工作区正在运行任务，请等待结束或先 /stop' }, ctx);
      return;
    }

    await this.sendResult({ text: '🗜 Compact 已触发，正在压缩会话…' }, ctx);

    const compactRunId = randomUUID();
    const cardSession = new RunCardSession({
      connector: this.connector,
      chatId: ctx.chatId,
      replyTo: ctx.messageId,
      runId: compactRunId,
      renderOptions: {
        agentKind,
      },
    });
    // 压缩与普通 run 共用同一套生命周期——注册进 activeRuns（/stop 有对象可停、
    // /active 看得见）、挂 §9.12 空闲看门狗、终态后补 reaction。缺任何一环，卡住的
    // 压缩都只能等 runner 级超时，用户既停不掉也看不出它还在跑。
    const activeRun: ActiveRun = {
      runId: compactRunId,
      userId: ctx.userId,
      chatId: ctx.chatId,
      session: cardSession,
      cwd,
      runner,
      agentKind,
    };
    this.activeRuns.set(cwd, activeRun);
    getLogger().info(`[lark-remote] activeRuns.set cwd=${cwd} runId=${compactRunId} compact=true`);
    let watchdog: IdleWatchdog | null = null;

    try {
      await cardSession.start();
      watchdog = this.startIdleWatchdog({
        runId: compactRunId,
        session: cardSession,
        runner,
      });
      // operationKind=compaction：卡片不渲染 Compact 按钮（防递归 Compact）。
      await cardSession.push({
        type: 'turn_started',
        threadId: sessionId,
        turnId: '',
        operationKind: 'compaction',
      });
      let sawResult = false;
      let resultSubtype: 'success' | 'error' | 'interrupted' | undefined;
      let resultError: string | undefined;
      for await (const event of (
        runner as {
          runCompact: (
            message: string,
            opts: { cwd: string; sessionId: string },
          ) => AsyncGenerator<AgentEvent>;
        }
      ).runCompact('', { cwd, sessionId })) {
        // 已终态（/stop、空闲看门狗）后不再消费事件：与 runAgentStreamToEnd 同口径，
        // 否则迟到的 result 会把终态卡改写成「已完成」。
        const cardTerminal = cardSession.currentState.terminal;
        if (isRunTerminal(cardTerminal)) {
          continue;
        }
        if (event.type === 'result') {
          sawResult = true;
          resultSubtype = (event as { subtype?: 'success' | 'error' | 'interrupted' }).subtype;
          resultError = (event as { errorMessage?: string }).errorMessage;
        }
        watchdog?.touch();
        await cardSession.push(event);
      }
      // §5.3: 卡片终态必须等于引擎真实终态。旧实现只看 sawResult 布尔——error
      // subtype 的 result 也被 finish 'done'（放大器 bug，2026-08-31 事故）。
      const terminal: 'done' | 'error' | 'interrupted' =
        resultSubtype === 'success'
          ? 'done'
          : resultSubtype === 'interrupted'
            ? 'interrupted'
            : 'error';
      // 压缩结束后从会话 jsonl 读权威统计（压缩后上下文、压缩次数、本次压缩
      // token 消耗与会话累计）。thread/compacted 通知与 jsonl 落盘几乎同时
      // （实测差 ~9ms），compactCount 未读到则短重试，仍失败优雅降级（无统计）。
      let finalUsage = resolveFinalUsage(
        this.sessionReaderRegistry,
        this.config.defaultAgent,
        sessionId,
        cwd,
        agentKind,
      );
      for (let attempt = 0; !finalUsage?.compactCount && attempt < 2; attempt++) {
        await sleep(150);
        finalUsage = resolveFinalUsage(
          this.sessionReaderRegistry,
          this.config.defaultAgent,
          sessionId,
          cwd,
          agentKind,
        );
      }
      await cardSession.finish(terminal, {
        resultSubtype: resultSubtype ?? 'error',
        errorMsg: terminal === 'error' ? (resultError ?? '未收到压缩结果') : undefined,
        contextLength: finalUsage?.contextLength,
        contextLimit: finalUsage?.contextLimit,
        compactPreContextLength: finalUsage?.compactPreContextLength,
        compactCount: finalUsage?.compactCount,
        cacheReadTokens: finalUsage?.cacheReadTokens,
        cacheCreationTokens: finalUsage?.cacheCreationTokens,
        totalTokens: finalUsage?.totalTokens,
        inputTokens: finalUsage?.inputTokens,
        outputTokens: finalUsage?.outputTokens,
        cumulativeTotalTokens: finalUsage?.cumulativeTotalTokens,
        cumulativeInputTokens: finalUsage?.cumulativeInputTokens,
        cumulativeOutputTokens: finalUsage?.cumulativeOutputTokens,
        cumulativeCacheReadTokens: finalUsage?.cumulativeCacheReadTokens,
        cumulativeCacheCreationTokens: finalUsage?.cumulativeCacheCreationTokens,
      });
      log.info(
        `[lark-remote] streamCompact finished sessionId=${sessionId} sawResult=${sawResult} subtype=${resultSubtype ?? 'none'}`,
      );
    } catch (err) {
      log.error(`[lark-remote] streamCompact failed: ${errorMessage(err)}`);
      // 终态守卫（与 runAgentStreamToEnd 同口径）：running/finalizing 才转 error，
      // 已终态（interrupted/idle_timeout）保留首终态，不被迟到的异常改写。
      const catchTerminal = cardSession.currentState.terminal;
      if (!isRunTerminal(catchTerminal)) {
        await cardSession.finish('error', { errorMsg: errorMessage(err) });
      } else {
        log.info(
          `[lark-remote] skip compact error finish: state already terminal (${catchTerminal}) runId=${compactRunId}`,
        );
      }
    } finally {
      watchdog?.stop();
      // 只摘自己的槽位：/stop 可能已删掉本条并让排队的下一条占住同一 cwd。
      if (this.activeRuns.get(cwd) === activeRun) {
        this.activeRuns.delete(cwd);
        getLogger().info(`[lark-remote] activeRuns.delete cwd=${cwd} runId=${compactRunId}`);
      }
      // 终态 reaction：与普通 run 同一口径（done→Done / error→ERROR /
      // interrupted→SHHH / idle_timeout→Alarm）。
      this.finishTurnReactions(ctx, terminalReactionEmoji(cardSession.currentState.terminal));
    }
  }

  /**
   * Handle resume.compact card action — compact a session directly from a
   * resume card (auto-resume / `/resume <id>`), without a runId.
   *
   * Unlike handleCompactAction (which validates against the last finished run's
   * runId), the resume card carries the sessionId + agent it was rendered for.
   * Validation: the session must exist in the current cwd (same rule as
   * cmdResume / resume.use) and the runner must implement runCompact.
   */
  async handleResumeCompact(
    value: { sessionId?: string; agent?: string },
    ctx: CommandContext,
  ): Promise<void> {
    const log = getLogger();
    log.info(
      `[lark-remote] handleResumeCompact userId=${ctx.userId} sessionId=${value.sessionId?.slice(0, 16)} agent=${value.agent ?? 'default'}`,
    );

    const { sessionId } = value;
    if (!sessionId) {
      await this.sendResult({ text: '⚠️ 无效的 Compact 请求，缺少 sessionId' }, ctx);
      return;
    }

    const cwd = this.resolveCwd(ctx.userId);
    if (!cwd) {
      await this.sendResult({ text: '⚠️ 未设置工作目录' }, ctx);
      return;
    }

    // Resolve agent kind the same way resume.use does: card value wins,
    // otherwise fall back to defaultAgent. 名单来自单源 AGENT_KINDS —— 手抄一份
    // 必然再次漂移（这份曾经漏 dsh：带 dsh 的卡片会静默退回 defaultAgent，
    // 用错 reader 报「未找到 session」）。
    const agentKind: AgentKind =
      value.agent && (AGENT_KINDS as readonly string[]).includes(value.agent)
        ? (value.agent as AgentKind)
        : this.config.defaultAgent;

    // Session must exist in the current cwd (same rule as cmdResume /
    // resume.use): reject ghosts so a stale card cannot compact a session
    // from another cwd. Read failures get visible feedback (card click
    // 红线：不许静默失败)。
    let content: ReturnType<AgentSessionReader['readSessionContent']>;
    try {
      content = this.sessionReaderRegistry.get(agentKind).readSessionContent(sessionId, cwd);
    } catch (err) {
      await this.sendResult(
        { text: `⚠️ 读取 session ${sessionId} 失败: ${errorMessage(err)}` },
        ctx,
      );
      return;
    }
    if (
      content.events.length === 0 &&
      !content.usage &&
      !content.aiTitle &&
      !content.recap &&
      !content.displayTitle
    ) {
      await this.sendResult({ text: `⚠️ 未找到 session ${sessionId}（当前目录: ${cwd}）` }, ctx);
      return;
    }

    // §5.3: kimi 压缩在途检测（与 handleCompactAction 同一入口）。
    if (await this.rejectIfCompactionInFlight(sessionId, cwd, agentKind, ctx)) return;

    // Check that the runner has runCompact（声明表 && runner 实现；
    // codex/kimi/opencode/pi/claude/dsh 均已实现）。
    const runner = this.getRunner(cwd, agentKind);
    if (!runnerSupportsCompact(runner, agentKind)) {
      await this.sendResult({ text: '⚠️ 当前运行模式不支持 Compact' }, ctx);
      return;
    }

    log.info(
      `[lark-remote] handleResumeCompact executing runCompact sessionId=${sessionId} cwd=${cwd}`,
    );
    await this.streamCompact({ sessionId, cwd, agentKind, runner, ctx });
  }

  /**
   * Execute a bash command and stream output to a card.
   * `!` commands bypass the serial queue entirely (see body comment + §9.6):
   * bash runs in parallel with same-workspace agent runs, tracked in
   * `activeBashRuns` separately from `activeRuns`.
   */
  async executeBash(command: string, ctx: CommandContext): Promise<void> {
    const cwd = this.resolveCwd(ctx.userId);

    getLogger().info(
      `[lark-remote] executeBash start userId=${ctx.userId} sessionCwd=${this.sessionStore.get(ctx.userId)?.cwd} command="${command.slice(0, 30)}..."`,
    );

    if (!cwd) {
      getLogger().info(`[lark-remote] executeBash no cwd, sending error`);
      await this.sendResult(
        { text: '请先使用 /cd <path> 设置工作目录，或保存一个 workspace (/ws save <name>)' },
        ctx,
      );
      return;
    }

    getLogger().info(`[lark-remote] executeBash proceeding cwd=${cwd}`);

    // `!` commands bypass the serial queue entirely (design.md §9.6):
    // index.ts dispatches `!` to router.handle → executeBash directly, NOT via
    // bridge.enqueue. bash runs in parallel with same-workspace claude runs.
    // bash runs are tracked in `activeBashRuns` (keyed by runId), separate from
    // claude's `activeRuns` (keyed by cwd) — they must not collide or `/stop`
    // would kill the wrong task. Do NOT re-chain onto the serial queue
    // (QueueManager) here: that would block on the still-pending outer promise
    // and deadlock self-wait.
    await this.executeBashInternal(command, ctx, cwd);
  }

  /**
   * Internal execution of bash command (called directly from executeBash,
   * bypassing the serial queue — see executeBash).
   */
  private async executeBashInternal(
    command: string,
    ctx: CommandContext,
    cwd: string,
  ): Promise<void> {
    getLogger().debug(
      `[lark-remote] executeBashInternal userId=${ctx.userId} chatId=${ctx.chatId} cwd=${cwd} command="${command.slice(0, 50)}..."`,
    );

    // Note: We don't check activeRuns here because bash bypasses the serial
    // queue and runs in parallel with same-workspace agent runs (§9.6). The
    // activeRuns check in forwardToClaude is for a different purpose (detecting
    // concurrent agent runs that would corrupt session state). Bash commands
    // don't have that issue.

    const runId = randomUUID();
    const bashRunner: BashRunner = new BashProcessRunner();

    // Single streaming card across the whole run (initial → output patches →
    // terminal), instead of sending many independent cards. BashCardSession is
    // the bash analogue of RunCardSession.
    const cardSession = new BashCardSession({
      connector: this.connector,
      chatId: ctx.chatId,
      replyTo: ctx.messageId,
      runId,
      command,
      renderOptions: {},
    });

    // Track this bash run independently from claude's `activeRuns`. Bash runs
    // bypass the serial queue and may run in parallel with a claude run in the
    // same cwd, so they must NOT share activeRuns (which is keyed by cwd
    // and would let bash/claude overwrite each other). Keyed by runId so
    // multiple `!` commands can run concurrently. Tracked so /stop can reach
    // the bashRunner (which is otherwise a local) via interruptCurrentRun.
    this.activeBashRuns.set(runId, {
      bashRunner,
      cardSession,
      userId: ctx.userId,
      chatId: ctx.chatId,
      cwd,
      command,
    });

    let output = '';
    let stderr = '';
    let exitCode: number | null = null;

    try {
      getLogger().info(
        `[lark-remote] executeBashInternal about to start stream chatId=${ctx.chatId} messageId=${ctx.messageId}`,
      );
      try {
        await cardSession.start();
        getLogger().info(`[lark-remote] executeBash stream started runId=${runId}`);
      } catch (err) {
        getLogger().warn('[lark-remote] bash card stream unavailable:', err);
      }

      for await (const event of bashRunner.run(command, { cwd })) {
        if (event.type === 'stdout') {
          // 层④：bridge 本地 output 也必须 store-time 截断——仅 session state
          // 有界并不会让 `output +=` 自然有界（「store 有界则本地拼接自然有界」
          // 不成立），!yes 洪峰下本地字符串仍全量驻留。capBashOutput 增量调用
          // O(CAP+chunk)，不会带回 O(n²) 截断成本（output 恒 ≤ CAP，拼接后
          // ≤ CAP+chunk 再 slice 尾部）。
          output = capBashOutput(output + event.content);
          await cardSession.update({ output, stderr });
        } else if (event.type === 'stderr') {
          stderr = capBashOutput(stderr + event.content);
          await cardSession.update({ output, stderr });
        } else if (event.type === 'exit') {
          exitCode = event.exitCode ?? 0;
        }
      }

      await cardSession.finish(exitCode === 0 ? 'done' : 'error', { exitCode, output, stderr });
    } catch (err) {
      getLogger().error(`[lark-remote] bash run error runId=${runId}:`, err);
      // If for-await threw mid-stream the bash child may still be running.
      // Stop it before finalizing the card — otherwise the finally block
      // removes the activeBashRuns entry and /stop can no longer reach it,
      // leaving an orphan process.
      try {
        await bashRunner.stop();
      } catch (stopErr) {
        getLogger().warn(`[lark-remote] bash stop failed:`, stopErr);
      }
      await cardSession.finish('error', {
        exitCode: 1,
        output,
        stderr: stderr + `\n执行错误: ${errorMessage(err)}`,
      });
    } finally {
      const settleResult = await cardSession.settle();
      if (settleResult === 'unsent') {
        // Stream never established a card — send a static terminal card as fallback.
        // Use 2.0 schema to match the streaming card (avoid 2.0→1.x downgrade).
        try {
          await this.connector.sendWithRetry(
            ctx.chatId,
            { card: renderBashCard(cardSession.currentState, {}) },
            { replyTo: ctx.messageId },
          );
        } catch (fallbackErr) {
          getLogger().error(
            `[lark-remote] bash terminal fallback card failed runId=${runId} chatId=${ctx.chatId}:`,
            fallbackErr,
          );
        }
      }
      if (this.activeBashRuns.has(runId)) {
        this.activeBashRuns.delete(runId);
        getLogger().info(`[lark-remote] executeBash done runId=${runId} exitCode=${exitCode}`);
      }

      // Add a Done emoji reaction to the user's original message to signal completion
      this.finishTurnReactions(ctx, 'Done');
    }
  }
}
