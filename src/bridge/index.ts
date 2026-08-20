import { randomUUID } from 'node:crypto';
import type { Runner, AgentRunner, AgentEvent, AgentSessionReader } from '../runner/index.js';
import { sleep } from '../common/sleep.js';
import type { AgentRegistry } from '../runner/registry.js';
import type { SessionReaderRegistry, SessionStore } from '../session/index.js';
import type { AppConfig } from '../config/index.js';
import { getLogger } from '../logger/index.js';
import { RunCardSession, type RunCardChannel } from '../card/run-card-session.js';
import { renderRunCard } from '../card/run-renderer.js';
import { renderBashCard } from '../card/bash-renderer.js';
import { BashCardSession, capBashOutput } from '../card/bash-card-session.js';
import type { RunTerminal } from '../card/run-state.js';
import { buildSessionHistoryCard } from '../router/card-helpers.js';
import { agentDisplayName, resumeUseButton } from '../card/card-shared.js';
import { enforceCardBudget } from '../card/card-budget.js';
import { normalizeResultUsage } from '../runner/common/usage.js';
import { BashProcessRunner, type BashRunner } from '../runner/index.js';
import type { AgentKind } from '../runner/types.js';
import {
  QueueManager,
  type QueuedTask,
  type EnqueueOptions,
  type AgentBinding,
} from './queue-manager.js';
import { ApprovalCoordinator, decisionToApprovalAction } from './approval-coordinator.js';
import type { ApprovalAction, ApprovalToggleAction } from './approval-coordinator.js';
import { InboundMediaHandler } from './inbound-media.js';
import type { InboundMediaPayload } from '../connector/index.js';

/**
 * Max events to read for the completion notification card (mirror router's
 * AUTO_RESUME_MAX_EVENTS = 5). Without a cap, readSessionContent returns every
 * event after the last user message and the card blows past Feishu's 28KB
 * budget (review §P1-21).
 */
const COMPLETION_NOTIFICATION_MAX_EVENTS = 5;

/** Approval request timeout (ms) — pending approval expires after this. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * runner 缓存的工作区数量上限（review P3-3）：超过后创建新工作区槽位时
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
 * through it; `reconnect` lets `/reconnect` be served through the bridge
 * without the router holding a separate connector reference. Declared here
 * so tests can satisfy it structurally without `as unknown as` casts.
 */
interface BridgeChannel extends RunCardChannel {
  sendWithRetry(
    chatId: string,
    input: { text: string } | { markdown: string } | { card: object },
    opts?: { replyTo?: string },
  ): Promise<string>;
  reconnect(): Promise<void>;
  sendFile(chatId: string, filePath: string): Promise<string>;
  addReaction(messageId: string, emoji: string): Promise<void>;
  removeReactionByEmoji(messageId: string, emoji: string): Promise<void>;
}

/** Caller context for a bridge operation. */
interface BridgeContext {
  userId: string;
  chatId: string;
  messageId: string;
}

/** A sendable result payload (mirror of the router's CommandResult shape). */
interface BridgeResult {
  text?: string;
  markdown?: string;
  card?: object;
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
   * Multi-agent registry. `getRunner(workspace)` looks up
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
   * at eviction time (review P2-3). Otherwise switching defaultAgent mid-run
   * (via `/config`, whose clearRunners skips the active cwd) makes finalizeRun
   * delete the wrong slot — the original agent's runner lingers in the cache
   * with a stale config snapshot.
   */
  agentKind: AgentKind;
}

/**
 * Bridge owns the per-workspace serial processing queue (§9.6) and the
 * single-card streaming forwarding loop (§9.12 watchdog + session sync).
 *
 * The router delegates non-command messages here via `forwardToClaude` and
 * sends command results via `sendResult`. Serial processing is enforced per
 * workspace by `enqueue`: each workspace has its own Promise chain, so at
 * most one agent process runs per workspace at a time, while different
 * workspaces run in parallel (see `activeRuns`, §9.6). This is a load-bearing
 * invariant — concurrent spawns within one workspace would corrupt session
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
   * Runner 槽位在「活跃运行期间配置变更」时被标 stale（CC-06/P1）：clearRunners() 对
   * 活跃 workspace 只标 stale、不立即 evict（避免误杀长驻连接），当前 run 结束后由
   * finalizeRun 安全 evict+dispose，下一轮 getRunner 创建新配置的 runner。
   * key 为 `${cwd}\u0000${agentKind}`。
   */
  private staleRunnerSlots = new Set<string>();
  /** Queue manager for per-workspace serial processing queue. */
  /** 普通消息队列管理器（public：测试注入 queue-card 状态用）。 */
  queueManager: QueueManager;
  /** Active runs per workspace (cwd). Multiple workspaces can run in parallel. */
  private activeRuns = new Map<string, ActiveRun>();
  /** Approval coordinators keyed by runId. */
  private approvalCoordinators = new Map<string, ApprovalCoordinator>();
  /**
   * 最近一次已完成的、runner 有 runCompact 的 run（按 cwd）。run 结束后
   * activeRuns 已清空，Compact 需要它来校验 runId 并提供 sessionId。
   */
  private lastCompactableCodexRun = new Map<
    string,
    { runId: string; sessionId: string; agentKind: AgentKind }
  >();

  /**
   * Active `!` bash runs, keyed by runId (NOT cwd). Bash runs bypass the serial
   * queue and may run in parallel with claude runs / other bash runs in the same
   * workspace, so they live outside `activeRuns`. Tracked so `/stop` can reach
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
      (workspace) => this.activeRuns.has(workspace),
      (chatId, card, opts) =>
        this.connector.sendWithRetry(chatId, { card }, { replyTo: opts?.replyTo }),
      (messageId, card) => this.connector.updateCard(messageId, card),
    );
    this.mediaHandler = new InboundMediaHandler({
      resolveCwd: (userId) => this.resolveCwd(userId),
      getConfig: () => this.config,
      send: async (ctx, text) => this.sendResult({ text }, ctx),
    });
  }

  /**
   * Get or create a runner for the given workspace, keyed by current defaultAgent.
   *
   * Fix 4 (2026-07-18): Cache key includes agentKind, so switching defaultAgent
   * creates a NEW runner under a different key without evicting the old one.
   * This eliminates the need for clearRunners() on agent switch.
   */
  private getRunner(workspace: string, kind: AgentKind = this.config.defaultAgent): Runner {
    // Fix 4: Check for runner under (workspace, kind) key
    const workspaceMap = this.runners.get(workspace);
    if (workspaceMap?.has(kind)) {
      return workspaceMap.get(kind)!;
    }

    // review P3-3：缓存超过上限且是新工作区时才回收死槽位——刚创建未 run
    // 的 runner 同样是 isRunning=false，小缓存下立即回收会破坏「创建即注册」
    // 的既有语义（exit-dispatcher 计数回归）。
    if (this.runners.size >= MAX_CACHED_RUNNER_WORKSPACES && !this.runners.has(workspace)) {
      for (const [cwd, slotMap] of [...this.runners.entries()]) {
        if (this.activeRuns.has(cwd)) continue;
        for (const [slotKind, r] of [...slotMap.entries()]) {
          if (!r.isRunning) {
            this.evictRunnerSlot(cwd, slotKind);
          }
        }
      }
    }

    // Create new runner for this (workspace, kind) slot
    const runner = this.agentRegistry.get(kind, workspace);
    // Call lifecycle methods for agent runners created via factory
    if (runner && typeof runner.killOrphan === 'function') {
      runner.killOrphan();
    }
    if (runner && typeof runner.registerExitHandlers === 'function') {
      runner.registerExitHandlers();
    }

    // Store in nested map: Map<workspace, Map<kind, Runner>>
    if (!workspaceMap) {
      this.runners.set(workspace, new Map([[kind, runner]]));
    } else {
      workspaceMap.set(kind, runner);
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
        getLogger().warn(`[bridge] sync approval mode failed cwd=${cwd}: ${err.message}`);
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
      default:
        return undefined;
    }
  }

  /** Get the current runner for a workspace. Used by router for agent-specific commands (P3.2). */
  getCurrentRunner(workspace: string): AgentRunner {
    return this.getRunner(workspace) as AgentRunner;
  }

  /**
   * Whether the runner for the given agent kind has runCompact capability.
   * Used by router for compact button gating (design doc §6.2-2: duck-typing
   * instead of hardcoding agentKind === 'codex').
   */
  hasRunCompact(workspace: string, kind: AgentKind = this.config.defaultAgent): boolean {
    const runner = this.getRunner(workspace, kind);
    return (
      'runCompact' in runner && typeof (runner as Record<string, unknown>).runCompact === 'function'
    );
  }

  /** 入队时刻快照：当前 defaultAgent + 该 agent 的 sessionId（无 session 则 undefined）。
   *  唯一捕获点：排队消息在 T0 把 agent+session 钉进 AgentBinding，随任务闭包带到 T1
   *  执行时刻，避免 /new、/config 在排队期间改写 live 状态导致语义漂移（方案 D4）。 */
  currentBinding(userId: string): AgentBinding {
    const agent = this.config.defaultAgent;
    return { agent, sessionId: this.sessionStore.getSessionId(userId, agent) };
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
        // CC-06/P1: 活跃 workspace 不能立即 evict（会误杀长驻连接），但必须标记 stale，
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
   * process-level exit dispatcher first (P1-1: without removal the singleton
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
  enqueue(workspace: string, task: () => Promise<void>, opts?: EnqueueOptions): void {
    this.queueManager.enqueue(workspace, task, opts);
  }

  /**
   * Execute a task immediately without going through the queue.
   * Used for / commands that should respond immediately.
   */
  enqueueImmediate(workspace: string, task: () => Promise<void>): void {
    this.queueManager.enqueueImmediate(workspace, task);
  }

  /** Get queue info for a workspace. */
  getQueueInfo(workspace: string): { position: number; tasksAhead: number; isRunning: boolean } {
    return this.queueManager.getQueueInfo(workspace);
  }

  /** Remove a task from the queue by messageId. Returns true if found and removed. */
  removeFromQueue(workspace: string, messageId: string): boolean {
    return this.queueManager.removeFromQueue(workspace, messageId);
  }

  /**
   * One-shot: replace the execution closure of an existing queued task in
   * place, preserving its queue position. Used by queue.immediate after the
   * user edits a queued message (see router handleQueueImmediate).
   */
  setTaskReplacement(workspace: string, messageId: string, task: () => Promise<void>): void {
    this.queueManager.setTaskReplacement(workspace, messageId, task);
  }

  /** Update queue card to "cancelled" status when user clicks 撤销. */
  async updateQueueCardToCancelled(workspace: string, messageId: string): Promise<void> {
    await this.queueManager.updateQueueCardToCancelled(workspace, messageId);
  }

  /** Mark a queued task's card as executing immediately (grey out buttons).
   *  Called by handleQueueImmediate so the user sees feedback right away
   *  instead of waiting for the queue callback. Idempotent: the queue
   *  callback's own updateQueueCardToExecuting call becomes a no-op because
   *  updateQueueCardToExecuting deletes the card-message mapping in finally. */
  async markQueueCardExecuting(workspace: string, messageId: string): Promise<void> {
    const task = this.getQueuedTask(workspace, messageId);
    await this.queueManager.updateQueueCardToExecuting(
      workspace,
      messageId,
      task?.messagePreview ?? '',
      false,
    );
  }

  /** Get task metadata from queue. */
  getQueuedTask(workspace: string, messageId: string): QueuedTask | undefined {
    return this.queueManager.getQueuedTask(workspace, messageId);
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

  /** Get all queued tasks for a workspace. Returns a copy to prevent aliasing bugs. */
  getQueuedTasks(workspace: string): QueuedTask[] {
    return this.queueManager.getQueuedTasks(workspace);
  }

  /**
   * Update the messagePreview for a queued task and build the updated queue
   * card. Returns the card object to send back as the cardAction callback
   * response (Feishu renders it in place), or null if the task is no longer
   * queued. Returning the card via the callback response avoids the
   * PATCH-vs-callback-response race that left the card stuck in edit state.
   */
  async updateMessagePreview(
    workspace: string,
    messageId: string,
    newMessage: string,
  ): Promise<object | null> {
    const updated = this.queueManager.updateQueuedTaskMessage(workspace, messageId, newMessage);
    if (!updated) return null;
    return this.queueManager.buildQueueCardForEdit(workspace, messageId, newMessage);
  }

  /** Whether a claude run is currently in progress in the given workspace. */
  isBusyFor(workspace: string): boolean {
    return this.activeRuns.has(workspace);
  }

  getActiveRunFor(workspace: string): ActiveRunSnapshot | undefined {
    const active = this.activeRuns.get(workspace);
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

  /** Whether any claude run is currently in progress (any workspace). */
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
    /** Restrict the match to a single workspace (queue.immediate). When
     * omitted, all workspaces are candidates (used by /stop, /t, and card stop button which don't know which workspace to target). */
    workspace?: string;
  }): Promise<boolean> {
    // Find the active claude run matching this user/chat
    for (const [cwd, active] of this.activeRuns) {
      if (input.workspace !== undefined && cwd !== input.workspace) continue;
      if (active.userId === input.userId && active.chatId === input.chatId) {
        if (input.runId && active.runId !== input.runId) continue;
        getLogger().info(
          `[bridge] interrupt hit runId=${active.runId} cwd=${cwd} userId=${input.userId}`,
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
        // its slot interrupted, hiding it from queue cards (A22).
        const stoppedSlot = this.queueManager.getExecutingSlot(cwd);
        await Promise.allSettled([
          // 用户主动中断（/stop、stop 卡按钮、queue.immediate）显式打标
          // interruptedReason，与审批超时自动取消（approval_timeout）、审批
          // 卡取消（approval_cancelled）在终态数据上可区分（方案 A）。
          active.session.finish('interrupted', { interruptedReason: 'user_stop' }),
          runner.stop({ immediate: true }),
        ]);
        // The chain may have advanced while the stop was in flight: a new run
        // (from a task that began during the stop window) may now occupy this
        // workspace. Only delete the entry we actually stopped.
        if (this.activeRuns.get(cwd) === active) {
          this.activeRuns.delete(cwd);
        }
        // Fix 4: Clean up this specific (cwd, agentKind) runner slot
        // (P1-1: eviction must also unregister the runner from the exit dispatcher)
        // P2-3: evict by the run's captured agentKind, not the live
        // defaultAgent (may have changed mid-run via /config).
        this.evictRunnerSlot(cwd, active.agentKind);
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
        getLogger().info(`[bridge] interrupt stop done runId=${active.runId}`);
        return true;
      }
    }
    // Then check active bash runs (! commands). These bypass the serial queue
    // and are tracked separately; stop the per-run BashRunner directly.
    for (const [runId, b] of this.activeBashRuns) {
      if (input.workspace !== undefined && b.cwd !== input.workspace) continue;
      if (b.userId === input.userId && b.chatId === input.chatId) {
        if (input.runId && runId !== input.runId) continue;
        getLogger().info(
          `[bridge] interrupt hit bash runId=${runId} cwd=${b.cwd} userId=${input.userId}`,
        );
        await b.bashRunner.stop({ immediate: true });
        // Update card to show interrupted state
        await b.cardSession.finish('interrupted', { exitCode: -1 });
        this.activeBashRuns.delete(runId);
        getLogger().info(`[bridge] interrupt bash stop done runId=${runId}`);
        return true;
      }
    }
    getLogger().debug(`[bridge] interrupt miss userId=${input.userId}`);
    return false;
  }

  /** Send a result message to the user (§7). Returns true on success, false on failure. */
  async sendResult(result: BridgeResult, ctx: BridgeContext): Promise<boolean> {
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
            `[bridge] card size exceeded limit, applied budget enforcement: reason=${reason} bytesBefore=${bytesBefore} bytesAfter=${bytesAfter}`,
          );
        }

        getLogger().debug(`[bridge] sendResult kind=card chatId=${ctx.chatId}`);
        await this.connector.sendWithRetry(
          ctx.chatId,
          { card: safeCard },
          { replyTo: ctx.messageId },
        );
        return true;
      } else if (result.markdown) {
        getLogger().debug(`[bridge] sendResult kind=markdown chatId=${ctx.chatId}`);
        await this.connector.sendWithRetry(
          ctx.chatId,
          { markdown: result.markdown },
          { replyTo: ctx.messageId },
        );
        return true;
      } else if (result.text) {
        getLogger().debug(`[bridge] sendResult kind=text chatId=${ctx.chatId}`);
        await this.connector.sendWithRetry(
          ctx.chatId,
          { text: result.text },
          { replyTo: ctx.messageId },
        );
        return true;
      }
      return false;
    } catch (err) {
      getLogger().error('[bridge] failed to send result:', err);
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
        getLogger().error('[bridge] fallback text send also failed:', fallbackErr);
      }
      return false;
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
  async updateCardInPlace(card: object, ctx: BridgeContext): Promise<boolean> {
    if (!ctx.messageId) {
      getLogger().warn('[bridge] updateCardInPlace missing messageId, falling back to sendResult');
      await this.sendResult({ card }, ctx);
      return false;
    }
    try {
      getLogger().debug(`[bridge] updateCardInPlace messageId=${ctx.messageId}`);
      await this.connector.updateCard(ctx.messageId, card);
      return true;
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      getLogger().warn(`[bridge] updateCardInPlace failed, falling back to sendResult: ${errMsg}`);
      // 先尝试 fallback 发卡片；若卡片本身有问题（如 11310），
      // sendResult 内部 catch 会发纯文本通知用户。
      await this.sendResult({ card }, ctx);
      return false;
    }
  }

  /** Send a file to the user via Feishu. */
  async sendFile(filePath: string, ctx: BridgeContext): Promise<void> {
    try {
      getLogger().debug(`[bridge] sendFile path=${filePath} chatId=${ctx.chatId}`);
      await this.connector.sendFile(ctx.chatId, filePath);
    } catch (err) {
      getLogger().error('[bridge] failed to send file:', err);
      await this.sendResult({ text: `发送文件失败: ${(err as Error).message}` }, ctx);
    }
  }

  /** 入站媒体落盘入口（connector 下载完成后调用）。 */
  async onInboundMedia(payload: InboundMediaPayload): Promise<void> {
    await this.mediaHandler.handle(payload);
  }

  /** 文本消息到达时立即冲刷待合批的媒体保存提示。 */
  flushMediaNotifications(userId: string, chatId: string): void {
    this.mediaHandler.flushAll(userId, chatId);
  }

  /** 冲刷全部待合批提示（/exit、/restart 干净退出前调用）。 */
  async flushAllMediaNotifications(): Promise<void> {
    await this.mediaHandler.flushAllPending();
  }

  /** Reconnect the underlying Feishu channel. */
  async reconnect(): Promise<void> {
    await this.connector.reconnect();
  }

  /**
   * Resolve the working directory for a user.
   * First checks sessionStore (set by /cd), then falls back to first workspace.
   * Returns undefined if no cwd is available.
   */
  private resolveCwd(userId: string): string | undefined {
    const entry = this.sessionStore.get(userId);
    let cwd = entry?.cwd;
    if (!cwd && this.workspaceStore) {
      const workspaces = this.workspaceStore.list();
      if (workspaces.length > 0) {
        // NOTE: fallback uses insertion order, not sort preference — by design
        // (workspace-sorting.md §9: cwd fallback stays insertion-order for now)
        cwd = workspaces[0].path;
        getLogger().info(`[bridge] resolveCwd fallback cwd=${cwd} (first saved workspace)`);
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
    ctx: BridgeContext,
    opts?: { cwdOverride?: string; binding?: AgentBinding },
  ): Promise<void> {
    // D5: agentKind 一律来自绑定。无 binding 时保持现状（live defaultAgent）。
    const agentKind = opts?.binding?.agent ?? this.config.defaultAgent;
    // P1-14: lane 与执行 cwd 同源。消息入队时（index.ts 闭包）捕获的 workspace
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
      `[bridge] forward entry userId=${ctx.userId} chatId=${ctx.chatId} cwd=${cwd} ` +
        `agent=${agentKind} sessionId=${opts?.binding?.sessionId ?? entry?.sessions?.get(agentKind) ?? '(none)'} message=${message.slice(0, 100)}`,
    );

    // Check if current workspace already has a run in progress
    if (this.activeRuns.has(cwd)) {
      getLogger().warn(`[bridge] workspace busy, dropping message userId=${ctx.userId} cwd=${cwd}`);
      await this.sendResult({ text: '此 workspace 正在处理中，请 /stop 后重试' }, ctx);
      return;
    }

    // Note: Multiple workspaces can have runs in parallel. If runner is busy,
    // runner.run() will throw and we'll catch it below.

    // D2/D5: sessionId 钉死语义——binding 有 sessionId 时用它（入队时刻快照），
    // 否则跟随 live store（无 binding 或入队时无 session 的正常路径）。
    const sessionId =
      opts?.binding?.sessionId ?? this.sessionStore.getSessionId(ctx.userId, agentKind);

    // 会话代际快照（2026-08-09）：run 在途时 /new、/cd、/resume 会 bump epoch，
    // 该 run 后续 system.init 的 sessionId 写回即判 stale 跳过。在执行起点
    // （而非入队点）捕获，保持 binding「钉死 resume」既有语义。
    const sessionEpochAtStart = this.sessionStore.getSessionEpoch(ctx.userId, agentKind);

    // Resolve the runner BEFORE creating the run session so the exact instance
    // that will run is captured into activeRun. interruptCurrentRun stops THAT
    // instance directly -- never a fresh runner re-resolved from a cache that
    // clearRunners() may have emptied mid-run (regression 2026-07-18).
    const runner = this.getRunner(cwd, agentKind);

    // Step 1: Create run session (runId, cardSession, activeRun tracking)
    const { runId, cardSession, activeRun } = this.createRunSession(ctx, cwd, runner, agentKind);

    // Step 2: Consume the agent stream (runner.run loop, event processing, state updates)
    await this.runAgentStreamToEnd(
      runner,
      cardSession,
      sessionId,
      sessionEpochAtStart,
      ctx,
      cwd,
      runId,
      message,
      agentKind,
    );

    // Step 3: Finalize the run (error handling, fallback card, completion notification, cleanup)
    await this.finalizeRun(cardSession, activeRun, ctx, cwd);
  }

  /**
   * Step 1 of forwardToClaude: Create run session components.
   * Returns runId, cardSession, and activeRun object for tracking.
   */
  private createRunSession(
    ctx: BridgeContext,
    cwd: string,
    runner: Runner,
    agentKind: AgentKind = this.config.defaultAgent,
  ): { runId: string; cardSession: RunCardSession; activeRun: ActiveRun } {
    const runId = randomUUID();
    getLogger().debug(`[bridge] creating runCard runId=${runId}`);
    // D5: agentKind 来自入队绑定（forwardToClaude 解析），不再读 live config。
    // 缓存键 (cwd, agentKind) 和 eviction 都用这个值（review P2-3）。
    const cardSession = new RunCardSession({
      connector: this.connector,
      chatId: ctx.chatId,
      replyTo: ctx.messageId,
      runId,
      renderOptions: {
        showThinking: this.config.output.showThinking,
        showToolUse: this.config.output.showToolUse,
        showToolResult: this.config.output.showToolResult,
        // Run card header shows the current agent name (e.g. "Claude · 思考中")
        agentKind,
        // Compact 按钮能力门控与 resume 卡 / auto-resume 卡一致（hasRunCompact
        // 鸭子探测）：claude（stream-json，无 turn_started）也能拿到按钮。
        compactSupported: this.hasRunCompact(cwd, agentKind),
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
    getLogger().info(`[bridge] activeRuns.set cwd=${cwd} runId=${runId}`);
    return { runId, cardSession, activeRun };
  }

  /**
   * Step 2 of forwardToClaude: Run the agent and consume its event stream.
   * Handles idle watchdog, event processing, session sync, and state transitions.
   */
  private async runAgentStreamToEnd(
    runner: Runner,
    cardSession: RunCardSession,
    sessionId: string | undefined,
    sessionEpochAtStart: number,
    ctx: BridgeContext,
    cwd: string,
    runId: string,
    message: string,
    agentKind: AgentKind = this.config.defaultAgent,
  ): Promise<void> {
    // Runner 声明的 usage 权威来源（review P3-7）：codex app-server = 'live'
    // （turn/started 的 tokenUsage.last 是本 turn 增量）。其余 runner 未声明。
    const usageAuthority = (
      runner as Runner & { getUsageAuthority?: () => 'live' | 'jsonl' }
    ).getUsageAuthority?.();

    // P2-1: idle watchdog 用单 interval + lastEventTs 截止时间判定，而非每事件
    // clearTimeout + setTimeout 重建 timer。高频事件流下 timer 重建次数与事件数
    // 成正比（N 事件 = N 次 setTimeout + N 个闭包/秒）；interval 方案只建一个
    // interval，事件到来时仅刷新时间戳（无 timer 操作）。语义不变：事件流停滞
    // 超过 idleTimeoutMs 仍触发 runner.stop()（§9.12）。
    let lastEventTs = Date.now();
    let idleInterval: NodeJS.Timeout | null = null;
    let sawResult = false;
    // 记录 result 是否为 error: error 时跳过 jsonl usage 读取 (见 stream end 处说明)
    let resultNotSuccess = false;
    // Final usage read from jsonl after the run completes. live stream-json does
    // not emit compact_boundary, so the live contextLength is unreliable.
    let finalContextLength: number | undefined;
    let finalContextLimit: number | undefined;
    let finalCompactCount: number | undefined;
    let finalCacheReadTokens: number | undefined;
    let finalCacheCreationTokens: number | undefined;
    let finalTotalTokens: number | undefined;
    // Real input/output tokens captured from the live result event (codex/
    // opencode carry them in ResultEvent.usage). Threaded to the card so the
    // done card shows real values instead of the 10% estimate.
    let liveInputTokens: number | undefined;
    let liveOutputTokens: number | undefined;
    // Real context window limit from the live result event (codex app-server
    // carries it in ResultEvent.usage.context_limit). jsonl wins when present;
    // live is the fallback (app-server error runs / jsonl 未落盘时).
    let liveContextLimit: number | undefined;
    // Final input/output for the done card: live value wins (codex/opencode
    // carry per-run usage in the result event); jsonl is the fallback for
    // agents whose live stream has no usage (kimi).
    let finalInputTokens: number | undefined;
    let finalOutputTokens: number | undefined;
    // Session-cumulative input/output (all runs) read from jsonl; threaded to
    // the done card's "累计" display. Always from jsonl (live has no cumulative).
    let finalCumulativeTotalTokens: number | undefined;
    let finalCumulativeInputTokens: number | undefined;
    let finalCumulativeOutputTokens: number | undefined;
    let finalCumulativeCacheReadTokens: number | undefined;
    let finalCumulativeCacheCreationTokens: number | undefined;

    try {
      try {
        getLogger().debug(`[bridge] cardSession.start() begin runId=${runId}`);
        await cardSession.start();
        getLogger().info(`[bridge] cardSession.start() ok runId=${runId}`);
      } catch (err) {
        getLogger().warn('[bridge] card stream unavailable, will use static fallback:', err);
        // Card stream failed - continue with static fallback below, but ensure
        // we don't silently fail if the fallback also fails (covered in catch below).
      }

      if (cardSession.currentState.terminal !== 'running') {
        // Card session did not enter running state - still try to send static fallback
        getLogger().info(`[bridge] cardSession not running, using static fallback`);
      }

      // P2-1: 单 interval 看门狗。事件到来时只刷新 lastEventTs（无 timer 操作）；
      // interval 周期检查 `now - lastEventTs > idleTimeoutMs`，超时才触发 stop。
      // 这样高频事件流下 timer 重建次数与事件数解耦（只建一个 interval），而
      // "15min 无事件即 stop" 的语义不变（§9.12）。周期取 idleTimeoutMs/2，使停滞
      // 后最多在 1.5× idleTimeoutMs 内触发（半个窗口延迟，watchdog 语义可接受）。
      const fireIdleTimeout = () => {
        // 权限等待期间暂停空闲看门狗：claude/codex 等待人工决策时无 stdout
        // 事件，「等审批」不是「挂死」。审批由 ApprovalCoordinator 的超时
        // （默认 5 分钟 < 看门狗窗口）自愈：cancel 送达 + 中断 turn，不会无限
        // 挂起。
        const pendingApproval = this.approvalCoordinators.get(runId)?.pendingCount() ?? 0;
        if (pendingApproval > 0) {
          lastEventTs = Date.now();
          return;
        }
        if (idleInterval) clearInterval(idleInterval);
        idleInterval = null;
        getLogger().warn(`[bridge] claude idle timeout, stopping process runId=${runId}`);
        void Promise.allSettled([
          cardSession.finish('idle_timeout', {
            idleTimeoutMinutes: Math.max(1, Math.round(this.idleTimeoutMs / 60_000)),
          }),
          runner.stop(),
        ]);
      };
      const resetIdle = () => {
        lastEventTs = Date.now();
      };
      if (this.idleTimeoutMs > 0) {
        const tickMs = Math.max(1, Math.floor(this.idleTimeoutMs / 2));
        idleInterval = setInterval(() => {
          if (Date.now() - lastEventTs > this.idleTimeoutMs) {
            fireIdleTimeout();
          }
        }, tickMs);
      }
      resetIdle();

      let contextLength: number | undefined;
      getLogger().info(
        `[bridge] runner.run() begin runId=${runId} message=${message.slice(0, 100)}`,
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

      for await (const event of runner.run(message, runOpts)) {
        // 只有终态才阻止事件处理。finalizing 是非终态，应该继续处理
        // 这样在 result 事件后，后台任务输出仍能被正确处理
        const terminal = cardSession.currentState.terminal;
        if (
          terminal === 'done' ||
          terminal === 'error' ||
          terminal === 'interrupted' ||
          terminal === 'idle_timeout'
        ) {
          continue;
        }
        if (event.type === 'system' && event.subtype === 'init') {
          sawInit = true;
          // 代际守卫：run 在途时 /new（或 new-session 卡片、/cd、/resume、
          // /config 切换）移动了 session 指针，此 init 的写回是 stale 的——
          // 跳过，否则 /new 的清空会被在途 run 静默撤销（2026-08-09 事故：
          // task-notification 注入触发 Claude 重发 init，已终止的 run 被复活）。
          const pointerMoved =
            this.sessionStore.getSessionEpoch(ctx.userId, agentKind) !== sessionEpochAtStart;
          if (pointerMoved) {
            getLogger().info(
              `[bridge] system.init write-back skipped: session pointer moved since run start runId=${runId} sessionId=${event.session_id}`,
            );
          } else {
            // L5: Use session's real directory from event.cwd (not runner's cwd parameter)
            // L3: guard empty string too -- `??` only catches null/undefined, but a
            // translator (or older build) may emit cwd="", which must NOT overwrite
            // the good runner cwd.
            const hasCwd = !!this.sessionStore.getCwd(ctx.userId);
            const realCwd = event.cwd && event.cwd.length > 0 ? event.cwd : cwd;
            if (hasCwd && event.cwd && event.cwd !== cwd) {
              // Session has its own cwd (e.g. EnterWorktree relocate). Keep the
              // workspace cwd unchanged; record the session's actual cwd in sessionCwds.
              getLogger().info(
                `[bridge] system.init: workspace cwd=${cwd}, session cwd=${event.cwd}`,
              );
              this.sessionStore.setSessionIdAndSessionCwd(
                ctx.userId,
                agentKind,
                event.session_id,
                realCwd,
              );
            } else {
              // First use (no workspace cwd yet) or event.cwd matches runner cwd:
              // set sessionId + cwd as before; on first use also bootstrap sessionCwds.
              const bootstrapSessionCwd =
                !hasCwd && event.cwd && event.cwd.length > 0 ? event.cwd : undefined;
              this.sessionStore.setSessionIdAndCwd(
                ctx.userId,
                agentKind,
                event.session_id,
                realCwd,
                bootstrapSessionCwd,
              );
            }
          }
          getLogger().info(
            `[bridge] system.init received runId=${runId} sessionId=${event.session_id} cwd=${event.cwd}`,
          );
        }
        if (event.type === 'turn_started') {
          // app-server runner 在 turn setup 成功后补发 synthetic system.init
          // （§9.22 守卫前提），此处 turn_started 写回保留为双保险：两者都用
          // threadId 写回 sessionId（代际守卫一致），幂等。缺失会导致每次消息
          // 都新建线程（thread/start 而非 thread/resume），会话无法延续。
          const pointerMoved =
            this.sessionStore.getSessionEpoch(ctx.userId, agentKind) !== sessionEpochAtStart;
          if (!pointerMoved) {
            this.sessionStore.setSessionIdAndCwd(ctx.userId, agentKind, event.threadId, cwd);
            getLogger().info(
              `[bridge] turn_started session write-back runId=${runId} sessionId=${event.threadId}`,
            );
          } else {
            getLogger().info(
              `[bridge] turn_started write-back skipped: session pointer moved since run start runId=${runId} sessionId=${event.threadId}`,
            );
          }
        }
        // Track context length from compaction events
        if (
          event.type === 'system' &&
          event.subtype === 'compact_boundary' &&
          event.compactMetadata
        ) {
          contextLength = event.compactMetadata.postTokens;
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
            getLogger().info(`[bridge] pre-init result ignored (resume replay) runId=${runId}`);
            // Still reset idle timer — the CLI is alive and producing events.
            resetIdle();
            // Do NOT push to cardSession: the run-state reducer would also
            // skip it (sessionId === undefined), but skipping at the bridge
            // layer avoids the push + render overhead for a no-op event.
            continue;
          }
          if (!preInitResult) {
            sawResult = true;
          }
          resultNotSuccess = event.subtype !== 'success';
          getLogger().info(
            preInitResult
              ? `[bridge] pre-init result from live runner (app-server setup failure) runId=${runId}`
              : `[bridge] result event received runId=${runId}`,
          );

          // app-server 模式 setup 失败路径（thread/start 成功后 turn/start 失败）
          // 不会有 turn_started 事件，store 不会写回新线程 id；runner 已在 result
          // 里兜底上报（review P3-10）。此处仅当 runner 声明 live usage（app-server）
          // 且会话指针未动时写回，避免下条消息再开一个孤儿线程。其余 agent 不在
          // 此列（它们各自有 system.init / turn_started 写回）。
          if (
            usageAuthority === 'live' &&
            event.session_id &&
            this.sessionStore.getSessionEpoch(ctx.userId, agentKind) === sessionEpochAtStart
          ) {
            this.sessionStore.setSessionIdAndCwd(ctx.userId, agentKind, event.session_id, cwd);
            getLogger().info(
              `[bridge] result session write-back runId=${runId} sessionId=${event.session_id}`,
            );
          }

          // result 后进入 finalizing 非终态（暂存 subtype/errorMsg），由 for-await
          // 自然结束后在 finally 转 done/error。提取 usage 信息。
          if (event.usage) {
            const u = normalizeResultUsage(event.usage);
            // input_tokens is non-cached (ccusage-aligned), so the context
            // length fallback must include cached tokens. Prefer the agent's
            // declared total; otherwise reconstruct from the parts.
            if (!contextLength) {
              contextLength = u.contextLength;
            }
            // Capture real input/output for the done card (avoiding the 10%
            // estimate in formatUsageStats). live 值优先：有 live input/output 时
            // 所有 flow 字段统一用 live scope（本 run），避免同一张卡片上
            // Input/Output 是本 run、Cache/Total 是 session 累计的混 scope 问题。
            liveInputTokens = u.inputTokens;
            liveOutputTokens = u.outputTokens;
            liveContextLimit = u.contextLimit;
            if (u.cacheReadTokens !== undefined) {
              finalCacheReadTokens = u.cacheReadTokens;
            }
            if (u.cacheCreationTokens !== undefined) {
              finalCacheCreationTokens = u.cacheCreationTokens;
            }
            if (u.totalTokens !== undefined) {
              finalTotalTokens = u.totalTokens;
            }
          }
        }
        // Approval events (Codex app-server mode)
        if (event.type === 'approval_requested') {
          // 审批请求到达：撤回 Typing 表情再重发，让飞书重新触发提醒，把用户
          // 注意力拉回待审批的卡片（run 在等待人工决策，Typing 应重新闪烁）。
          void (async () => {
            try {
              await this.connector.removeReactionByEmoji(ctx.messageId, 'Typing');
            } catch (err) {
              getLogger().warn(
                `[bridge] remove Typing reaction failed runId=${runId}: ${errorMessage(err)}`,
              );
            }
            try {
              await this.connector.addReaction(ctx.messageId, 'Typing');
            } catch (err) {
              getLogger().warn(
                `[bridge] re-add Typing reaction failed runId=${runId}: ${errorMessage(err)}`,
              );
            }
          })();
          let coordinator = this.approvalCoordinators.get(runId);
          if (!coordinator) {
            coordinator = new ApprovalCoordinator({
              // claude 审批超时走 config（claude.approvalTimeoutMs，默认 5 分钟，
              // 对齐 codex 红线勿改短）；codex 维持模块常量。
              approvalTimeoutMs:
                agentKind === 'claude'
                  ? (this.config.claude?.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS)
                  : APPROVAL_TIMEOUT_MS,
              responder: async (requestId, response) => {
                const r = runner as Runner & {
                  respondApproval?: (rid: number | string, res: unknown) => Promise<void>;
                };
                if (typeof r.respondApproval === 'function') {
                  await r.respondApproval(requestId, response);
                }
              },
              interruptTurn: () => runner.stop(),
              pushToCard: async (events) => {
                for (const ev of events) await cardSession.push(ev);
              },
            });
            this.approvalCoordinators.set(runId, coordinator);
            getLogger().info(
              `[bridge] approval coordinator created runId=${runId.slice(0, 8)} requestId=${event.requestId}`,
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
        // §9.12 红线（§P1-2 方案 A）：每个事件（含 result）无条件刷新
        // lastEventTs 重新武装看门狗。result 后 CLI 进程做 jsonl flush/清理（finalizing
        // 过渡）期间，宽限期恢复为完整的 idleTimeoutMs，避免已产出结果的 turn 被误标
        // idle_timeout。旧实现 `else { resetIdle(); }` 漏掉 result 分支。
        resetIdle();

        await cardSession.push(event);
      }
      getLogger().info(`[bridge] runner stream end runId=${runId} sawResult=${sawResult}`);

      // §9.12 红线（§P1-2 方案 A 第 2 点）：for-await 自然结束 = CLI 已退出，
      // 看门狗使命结束，立即摘除 interval（不再等 finally），堵掉「stream 已结束、
      // 收尾处理跨过死线被误标 idle_timeout」的同源小窗口（P2-4 随本修复一并关闭）。
      if (idleInterval) {
        clearInterval(idleInterval);
        idleInterval = null;
      }

      // stream 结束 = CLI 退出 = jsonl 已落盘。读 jsonl 拿准确的 contextLength + compactCount：
      // live stream-json 不发 compact_boundary，live contextLength 会被 result 的 input+output 兜底失真。
      // 但 result=error 时跳过: 进程可能立即退出未写新 usage (如 kimi 0.26+ 拒绝 -p+--auto
      // 立即 exit=1), 此时 jsonl 里是上一次成功 turn 的历史 usage, 会被误当作本次 usage 显示,
      // 误导用户以为本次出错的请求也消耗了 token。error 时只用 live 捕获的 usage (若有)。
      const finalSessionId = this.sessionStore.getSessionId(ctx.userId, agentKind);
      const finalUsage = resultNotSuccess
        ? undefined
        : this.resolveFinalUsage(finalSessionId, cwd, agentKind);
      finalContextLength = finalUsage?.contextLength ?? contextLength;
      finalContextLimit = finalUsage?.contextLimit ?? liveContextLimit;
      finalCompactCount = finalUsage?.compactCount;
      finalCumulativeTotalTokens = finalUsage?.cumulativeTotalTokens;
      finalCumulativeInputTokens = finalUsage?.cumulativeInputTokens;
      finalCumulativeOutputTokens = finalUsage?.cumulativeOutputTokens;
      finalCumulativeCacheReadTokens = finalUsage?.cumulativeCacheReadTokens;
      finalCumulativeCacheCreationTokens = finalUsage?.cumulativeCacheCreationTokens;
      // 统一 flow 字段 scope：live 优先，jsonl 兜底。
      // 当 live result 事件带了 input/output（即 liveInputTokens/liveOutputTokens
      // 非 undefined），所有 flow 字段统一用 live scope（本 run），不用 jsonl
      // 的 session 累计值覆盖，避免 cache%/Total 分子分母不同源。
      // 无 live usage 时（如 kimi），jsonl 值兜底。
      // contextLength/compactCount 保持 jsonl 优先（它们是水位/历史计数）。
      const codexJsonlFirst = usageAuthority === 'jsonl';
      if (!codexJsonlFirst && liveInputTokens !== undefined && liveOutputTokens !== undefined) {
        // 非 codex 且 live 有 input/output → 所有 flow 字段用 live scope
        finalInputTokens = liveInputTokens;
        finalOutputTokens = liveOutputTokens;
        // cacheReadTokens/cacheCreationTokens/totalTokens
        // 已在上面 result 事件处理中赋了 live 值；若 live 没有则为 undefined，
        // 由 formatUsageStats 的 max/兜底公式处理。
      } else {
        // codex（jsonl 优先）或无 live usage → jsonl 兜底所有 flow 字段。
        // jsonl 的非累计字段已是末轮（本 run）scope（claude reader 修复后对齐
        // codex `last_token_usage` 语义，见 scalarScan），不再是 session 累计；
        // session 累计只经 cumulative* 字段透传，卡片"本 run ≤ 累计"不变量成立。
        finalInputTokens = finalUsage?.inputTokens ?? liveInputTokens;
        finalOutputTokens = finalUsage?.outputTokens ?? liveOutputTokens;
        finalCacheReadTokens = finalUsage?.cacheReadTokens ?? finalCacheReadTokens;
        finalCacheCreationTokens = finalUsage?.cacheCreationTokens ?? finalCacheCreationTokens;
        finalTotalTokens = finalUsage?.totalTokens ?? finalTotalTokens;
      }
      getLogger().info(
        `[bridge] final usage runId=${runId} contextLength=${finalContextLength} contextLimit=${finalContextLimit ?? 'undefined'} compactCount=${finalCompactCount ?? 'undefined'} cacheRead=${finalCacheReadTokens ?? 'undefined'} cacheCreate=${finalCacheCreationTokens ?? 'undefined'}`,
      );

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
        const terminal = isError ? 'error' : subtype === 'interrupted' ? 'interrupted' : 'done';
        await cardSession.finish(terminal, {
          resultSubtype: subtype,
          errorMsg: finalState.errorMsg,
          contextLength: finalContextLength,
          contextLimit: finalContextLimit,
          compactCount: finalCompactCount,
          cacheReadTokens: finalCacheReadTokens,
          cacheCreationTokens: finalCacheCreationTokens,
          totalTokens: finalTotalTokens,
          inputTokens: finalInputTokens,
          outputTokens: finalOutputTokens,

          cumulativeTotalTokens: finalCumulativeTotalTokens,
          cumulativeInputTokens: finalCumulativeInputTokens,
          cumulativeOutputTokens: finalCumulativeOutputTokens,
          cumulativeCacheReadTokens: finalCumulativeCacheReadTokens,
          cumulativeCacheCreationTokens: finalCumulativeCacheCreationTokens,
        });
      } else if (finalState.terminal === 'running') {
        await cardSession.finish('error', {
          contextLength: finalContextLength,
          contextLimit: finalContextLimit,
          compactCount: finalCompactCount,
          cacheReadTokens: finalCacheReadTokens,
          cacheCreationTokens: finalCacheCreationTokens,
          totalTokens: finalTotalTokens,
          inputTokens: finalInputTokens,
          outputTokens: finalOutputTokens,

          cumulativeTotalTokens: finalCumulativeTotalTokens,
          cumulativeInputTokens: finalCumulativeInputTokens,
          cumulativeOutputTokens: finalCumulativeOutputTokens,
          cumulativeCacheReadTokens: finalCumulativeCacheReadTokens,
          cumulativeCacheCreationTokens: finalCumulativeCacheCreationTokens,
          errorMsg: agentDisplayName(agentKind) + ' 输出流已结束，但未收到 result 事件',
        });
      } else if (sawResult) {
        // 已终态（interrupted/idle_timeout）+ result 已收到：首终态优先，
        // 仅补充 usage meta（finalizing 期间被 /stop 或 idle 超时也展示 token 统计）
        await cardSession.finish(finalState.terminal, {
          contextLength: finalContextLength,
          contextLimit: finalContextLimit,
          compactCount: finalCompactCount,
          cacheReadTokens: finalCacheReadTokens,
          cacheCreationTokens: finalCacheCreationTokens,
          totalTokens: finalTotalTokens,
          inputTokens: finalInputTokens,
          outputTokens: finalOutputTokens,

          cumulativeTotalTokens: finalCumulativeTotalTokens,
          cumulativeInputTokens: finalCumulativeInputTokens,
          cumulativeOutputTokens: finalCumulativeOutputTokens,
          cumulativeCacheReadTokens: finalCumulativeCacheReadTokens,
          cumulativeCacheCreationTokens: finalCumulativeCacheCreationTokens,
        });
      }
      // else: 已终态且未收到 result（如 spawn 失败后 interrupted）-> 无 usage 可补，跳过
    } catch (err) {
      getLogger().error(`[bridge] claude run error runId=${runId}:`, err);
      // P1-11 双保险：run() 的 finally 已负责杀子进程，但 catch 路径再补一次
      // runner.stop()（与 bash 路径对齐），覆盖任何 finally 之外的残留窗口。
      try {
        await runner.stop();
      } catch (stopErr) {
        getLogger().warn(`[bridge] runner stop failed:`, stopErr);
      }
      // 终态守卫：running 或 finalizing（非终态）-> 转 error；
      // 已终态（interrupted/idle_timeout/done/error）-> 保留首终态，仅补充 usage。
      const catchTerminal = cardSession.currentState.terminal;
      if (catchTerminal === 'running' || catchTerminal === 'finalizing') {
        await cardSession.finish('error', {
          contextLength: finalContextLength,
          contextLimit: finalContextLimit,
          compactCount: finalCompactCount,
          cacheReadTokens: finalCacheReadTokens,
          cacheCreationTokens: finalCacheCreationTokens,
          totalTokens: finalTotalTokens,
          inputTokens: liveInputTokens,
          outputTokens: liveOutputTokens,
          cumulativeTotalTokens: finalCumulativeTotalTokens,
          cumulativeInputTokens: finalCumulativeInputTokens,
          cumulativeOutputTokens: finalCumulativeOutputTokens,
          errorMsg: errorMessage(err),
        });
      } else {
        getLogger().info(
          `[bridge] skip error finish: state already terminal (${catchTerminal}) runId=${runId}`,
        );
        if (sawResult) {
          await cardSession.finish(catchTerminal, {
            contextLength: finalContextLength,
            contextLimit: finalContextLimit,
            compactCount: finalCompactCount,
            cacheReadTokens: finalCacheReadTokens,
            cacheCreationTokens: finalCacheCreationTokens,
            totalTokens: finalTotalTokens,
            inputTokens: finalInputTokens,
            outputTokens: finalOutputTokens,

            cumulativeTotalTokens: finalCumulativeTotalTokens,
            cumulativeInputTokens: finalCumulativeInputTokens,
            cumulativeOutputTokens: finalCumulativeOutputTokens,
            cumulativeCacheReadTokens: finalCumulativeCacheReadTokens,
            cumulativeCacheCreationTokens: finalCumulativeCacheCreationTokens,
          });
        }
      }
    } finally {
      if (idleInterval) clearInterval(idleInterval);
      const coordinator = this.approvalCoordinators.get(runId);
      if (coordinator) {
        coordinator.onTurnEnded();
        this.approvalCoordinators.delete(runId);
      }
    }
  }

  /**
   * Step 3 of forwardToClaude: Finalize the run.
   * Handles fallback card sending, completion notification, and cleanup.
   */
  private async finalizeRun(
    cardSession: RunCardSession,
    activeRun: ActiveRun,
    ctx: BridgeContext,
    cwd: string,
  ): Promise<void> {
    const runId = activeRun.runId;
    try {
      getLogger().debug(
        `[bridge] finally settle runId=${runId} state.terminal=${cardSession.currentState.terminal}`,
      );
      const settleResult = await cardSession.settle();
      let runCardSent = false;
      if (settleResult === 'unsent') {
        const sent = await this.sendResult(
          {
            card: renderRunCard(cardSession.currentState, {
              showThinking: this.config.output.showThinking,
              showToolUse: this.config.output.showToolUse,
              showToolResult: this.config.output.showToolResult,
              agentKind: activeRun.agentKind,
            }),
          },
          ctx,
        );
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

      // Add a terminal-state emoji reaction to the user's original message
      void this.connector.addReaction(
        ctx.messageId,
        terminalReactionEmoji(cardSession.currentState.terminal),
      );
    } finally {
      // P1-13: cleanup must survive mid-finalize errors. The only unguarded
      // expression in finalizeRun is the renderRunCard(...) argument evaluated
      // at the sendResult call site; if it throws, the run must still release
      // its activeRuns slot — otherwise the workspace is permanently busy
      // (every later message busy-dropped until a manual /stop).
      if (this.activeRuns.get(cwd) === activeRun) {
        this.activeRuns.delete(cwd);
        // Workspace-lifetime runners (codex app-server) keep their persistent
        // connection across runs: evicting here would kill the connection after
        // EVERY run, defeating lifetime='workspace' + idle TTL. They are still
        // evicted+disposed by clearRunners (/config) and interruptCurrentRun
        // (/stop). Spawn-per-message runners are evicted as before to prevent
        // stale process references accumulating.
        // CC-06/P1: 配置变更期间（clearRunners 标了 stale）的 workspace-lifetime
        // runner 也必须在 run 结束后 evict，否则下一轮复用旧配置实例。
        const slotKey = `${cwd}\u0000${activeRun.agentKind}`;
        if (activeRun.runner.lifetime !== 'workspace' || this.staleRunnerSlots.has(slotKey)) {
          this.evictRunnerSlot(cwd, activeRun.agentKind);
        }
        this.staleRunnerSlots.delete(slotKey);
        // Compact 卡片需要 runId + sessionId；record 供终态卡上的 Compact 按钮
        // 校验与取参（activeRuns 已清空，无法再查到）。异常退出（error/
        // interrupted/idle_timeout）同样记录——上下文往往更大，压缩后再续。
        // §6.2-3：写入条件从「codex 终态」放宽为「runner 有 runCompact 的终态」
        // （codex app-server + kimi acp 均满足）。
        const runTerminal = cardSession.currentState.terminal;
        const runnerHasCompact =
          'runCompact' in activeRun.runner &&
          typeof (activeRun.runner as Record<string, unknown>).runCompact === 'function';
        if (
          runnerHasCompact &&
          activeRun.runner.lifetime === 'workspace' &&
          (runTerminal === 'done' ||
            runTerminal === 'error' ||
            runTerminal === 'interrupted' ||
            runTerminal === 'idle_timeout')
        ) {
          const compactSessionId =
            cardSession.currentState.sessionId ??
            this.sessionStore.getSessionId(ctx.userId, activeRun.agentKind);
          if (compactSessionId) {
            this.lastCompactableCodexRun.set(cwd, {
              runId: activeRun.runId,
              sessionId: compactSessionId,
              agentKind: activeRun.agentKind,
            });
          }
        }
        getLogger().info(`[bridge] activeRuns.delete cwd=${cwd} runId=${runId}`);
      }
    }
  }

  /**
   * Read final usage (contextLength + compactCount + cache tokens) from the session jsonl.
   * Called after a run finishes: live stream-json does not emit compact_boundary,
   * so the live contextLength (fallback to result.usage input+output) is
   * unreliable. The jsonl is authoritative for postTokens + compact event count.
   */
  private resolveFinalUsage(
    sessionId: string | undefined,
    cwd: string,
    agentKind: AgentKind = this.config.defaultAgent,
  ):
    | {
        contextLength?: number;
        contextLimit?: number;
        compactCount?: number;
        compactPreContextLength?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        totalTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
        cumulativeTotalTokens?: number;
        cumulativeInputTokens?: number;
        cumulativeOutputTokens?: number;
        cumulativeCacheReadTokens?: number;
        cumulativeCacheCreationTokens?: number;
      }
    | undefined {
    if (!sessionId) return undefined;
    try {
      const content = this.sessionReaderRegistry.get(agentKind).readSessionContent(sessionId, cwd);
      if (!content.usage) {
        // EnterWorktree relocate (2026-08-04): jsonl read silently returned no
        // usage (e.g. transcript moved mid-session). Surface it so token-stat
        // fallback to per-run live usage is visible in logs, not silent.
        getLogger().warn(
          `[bridge] resolveFinalUsage: no usage from jsonl sessionId=${sessionId} cwd=${cwd} agent=${agentKind}, card falls back to per-run live usage`,
        );
      }
      return content.usage
        ? {
            contextLength: content.usage.contextLength,
            contextLimit: content.usage.contextLimit,
            compactCount: content.usage.compactCount,
            compactPreContextLength: content.usage.compactPreContextLength,
            cacheReadTokens: content.usage.cacheReadTokens,
            cacheCreationTokens: content.usage.cacheCreationTokens,
            totalTokens: content.usage.totalTokens,
            inputTokens: content.usage.inputTokens,
            outputTokens: content.usage.outputTokens,
            cumulativeTotalTokens: content.usage.cumulativeTotalTokens,
            cumulativeInputTokens: content.usage.cumulativeInputTokens,
            cumulativeOutputTokens: content.usage.cumulativeOutputTokens,
            cumulativeCacheReadTokens: content.usage.cumulativeCacheReadTokens,
            cumulativeCacheCreationTokens: content.usage.cumulativeCacheCreationTokens,
          }
        : undefined;
    } catch (err) {
      getLogger().warn(
        `[bridge] resolveFinalUsage failed sessionId=${sessionId}: ${errorMessage(err)}`,
      );
      return undefined;
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
    ctx: BridgeContext,
    agentKind: AgentKind = this.config.defaultAgent,
  ): Promise<void> {
    try {
      // P1-21: cap the events read for the notification card — without
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

      // P1-21: send through sendResult so enforceCardBudget guards the card
      // (previously sent via connector directly, bypassing the budget — long
      // sessions produced >28KB cards that Feishu silently rejected).
      const sent = await this.sendResult({ card }, ctx);
      if (sent) {
        getLogger().debug(
          `[bridge] completion notification sent sessionId=${sessionId} chatId=${ctx.chatId}`,
        );
      } else {
        getLogger().warn(
          `[bridge] failed to send completion notification card sessionId=${sessionId}`,
        );
      }
    } catch (err) {
      getLogger().warn(`[bridge] failed to send completion notification card:`, err);
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
      // P2-7: run 已结束（coordinator 已释放）时点击审批按钮必须给用户明确反馈，
      // 不能静默。router 会把该异常转成 error toast。
      getLogger().warn(`[bridge] no approval coordinator for runId=${runId.slice(0, 8)}`);
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
      `[bridge] handleApprovalRespond runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} decision=${opts.decision}`,
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
      `[bridge] handleApprovalToggle runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} permId=${opts.permId}`,
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
    const log = getLogger();
    log.info(
      `[bridge] handleApprovalAnswer runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} question=${opts.questionIndex}`,
    );
    return this.withCoordinator(opts.runId, (coordinator) =>
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
    const log = getLogger();
    log.info(
      `[bridge] handleApprovalAnswerSubmit runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} question=${opts.questionIndex}`,
    );
    return this.withCoordinator(opts.runId, (coordinator) =>
      coordinator.submitAnswers(
        { questionIndex: opts.questionIndex },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }

  /**
   * Claude AskUserQuestion 自定义答案（Other，review P3-4）：自由文本直接
   * 作为该单选问题的答案提交。路由到 ApprovalCoordinator.answerCustom。
   */
  async handleApprovalAnswerCustom(opts: {
    runId: string;
    requestId: number | string;
    questionIndex: number;
    text: string;
    nonce: string;
  }): Promise<void> {
    const log = getLogger();
    log.info(
      `[bridge] handleApprovalAnswerCustom runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} question=${opts.questionIndex}`,
    );
    return this.withCoordinator(opts.runId, (coordinator) =>
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
    const log = getLogger();
    log.info(
      `[bridge] handleApprovalAnswerNote runId=${opts.runId.slice(0, 8)}... requestId=${opts.requestId} question=${opts.questionIndex}`,
    );
    return this.withCoordinator(opts.runId, (coordinator) =>
      coordinator.answerNote(
        { questionIndex: opts.questionIndex, text: opts.text },
        { requestId: opts.requestId, nonce: opts.nonce },
      ),
    );
  }

  /**
   * Handle codex.compact card action — trigger a compaction request for any
   * runCompact-capable runner（codex/kimi/opencode/pi/claude，按
   * lastCompactableCodexRun 记录的 agentKind 路由）。Validates the run exists
   * and is in a terminal state, then calls the runner's runCompact().
   */
  async handleCodexCompact(value: { runId?: string }, ctx: BridgeContext): Promise<void> {
    const log = getLogger();
    log.info(
      `[bridge] handleCodexCompact userId=${ctx.userId} runId=${value.runId?.slice(0, 8)}...`,
    );

    const { runId } = value;
    if (!runId) {
      await this.sendResult({ text: '⚠️ 无效的 Compact 请求，缺少 runId' }, ctx);
      return;
    }

    const cwd = this.resolveCwd(ctx.userId);
    if (!cwd) {
      await this.sendResult({ text: '⚠️ 未设置工作目录' }, ctx);
      return;
    }

    // 校验：run 结束后 activeRuns 已清空，用 lastCompactableCodexRun 对照 runId。
    const last = this.lastCompactableCodexRun.get(cwd);
    if (!last || last.runId !== runId) {
      await this.sendResult({ text: '⚠️ 该任务已结束或不属于当前会话' }, ctx);
      return;
    }
    if (!last.sessionId) {
      await this.sendResult({ text: '⚠️ 未找到可压缩的会话' }, ctx);
      return;
    }

    // Check that the runner has runCompact method
    const runner = this.getRunner(cwd, last.agentKind);
    if (
      !('runCompact' in runner) ||
      typeof (runner as Record<string, unknown>).runCompact !== 'function'
    ) {
      await this.sendResult({ text: '⚠️ 当前运行模式不支持 Compact' }, ctx);
      return;
    }

    log.info(`[bridge] handleCodexCompact executing runCompact for runId=${runId} cwd=${cwd}`);
    await this.streamCodexCompact({
      sessionId: last.sessionId,
      cwd,
      agentKind: last.agentKind,
      runner,
      ctx,
    });
  }

  /**
   * Stream a compaction to a card: start a RunCardSession with
   * operationKind='compaction' (no recursive Compact button), consume
   * runner.runCompact() events, read authoritative jsonl usage, and finish
   * the card. Shared by handleCodexCompact (run card button) and
   * handleResumeCompact (resume cards) so both flows stay in sync.
   *
   * Precondition: callers have already validated that `runner` implements
   * runCompact and that the session exists in `cwd`.
   */
  private async streamCodexCompact(opts: {
    sessionId: string;
    cwd: string;
    agentKind: AgentKind;
    runner: Runner;
    ctx: BridgeContext;
  }): Promise<void> {
    const log = getLogger();
    const { sessionId, cwd, agentKind, runner, ctx } = opts;
    log.info(`[bridge] streamCodexCompact sessionId=${sessionId} cwd=${cwd}`);

    // 防御性能力检查：调用方已校验（runId / resume 两条路径），此处双保险并
    // 让 TS 收窄 runner 类型（'runCompact' in runner 之后的 cast 才合法）。
    if (
      !('runCompact' in runner) ||
      typeof (runner as Record<string, unknown>).runCompact !== 'function'
    ) {
      await this.sendResult({ text: '⚠️ 当前运行模式不支持 Compact' }, ctx);
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
        showThinking: this.config.output.showThinking,
        showToolUse: this.config.output.showToolUse,
        showToolResult: this.config.output.showToolResult,
        agentKind,
      },
    });

    try {
      await cardSession.start();
      // operationKind=compaction：卡片不渲染 Compact 按钮（防递归 Compact）。
      await cardSession.push({
        type: 'turn_started',
        threadId: sessionId,
        turnId: '',
        operationKind: 'compaction',
      });
      let sawResult = false;
      for await (const event of (
        runner as {
          runCompact: (
            message: string,
            opts: { cwd: string; sessionId: string },
          ) => AsyncGenerator<AgentEvent>;
        }
      ).runCompact('', { cwd, sessionId })) {
        if (event.type === 'result') sawResult = true;
        await cardSession.push(event);
      }
      // 压缩结束后从会话 jsonl 读权威统计（压缩后上下文、压缩次数、本次压缩
      // token 消耗与会话累计）。thread/compacted 通知与 jsonl 落盘几乎同时
      // （实测差 ~9ms），compactCount 未读到则短重试，仍失败优雅降级（无统计）。
      let finalUsage = this.resolveFinalUsage(sessionId, cwd, agentKind);
      for (let attempt = 0; !finalUsage?.compactCount && attempt < 2; attempt++) {
        await sleep(150);
        finalUsage = this.resolveFinalUsage(sessionId, cwd, agentKind);
      }
      await cardSession.finish(sawResult ? 'done' : 'error', {
        resultSubtype: sawResult ? 'success' : 'error',
        errorMsg: sawResult ? undefined : '未收到压缩结果',
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
        `[bridge] streamCodexCompact finished sessionId=${sessionId} sawResult=${sawResult}`,
      );
    } catch (err) {
      log.error(`[bridge] streamCodexCompact failed: ${errorMessage(err)}`);
      await cardSession.finish('error', { errorMsg: errorMessage(err) });
    }
  }

  /**
   * Handle resume.compact card action — compact a session directly from a
   * resume card (auto-resume / `/resume <id>`), without a runId.
   *
   * Unlike handleCodexCompact (which validates against the last finished run's
   * runId), the resume card carries the sessionId + agent it was rendered for.
   * Validation: the session must exist in the current cwd (same rule as
   * cmdResume / resume.use) and the runner must implement runCompact.
   */
  async handleResumeCompact(
    value: { sessionId?: string; agent?: string },
    ctx: BridgeContext,
  ): Promise<void> {
    const log = getLogger();
    log.info(
      `[bridge] handleResumeCompact userId=${ctx.userId} sessionId=${value.sessionId?.slice(0, 16)} agent=${value.agent ?? 'default'}`,
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
    // otherwise fall back to defaultAgent.
    const validAgents: AgentKind[] = ['claude', 'codex', 'opencode', 'pi', 'kimi'];
    const agentKind: AgentKind =
      value.agent && (validAgents as string[]).includes(value.agent)
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

    // Check that the runner has runCompact（codex/kimi/opencode/pi/claude 鸭子探测）。
    const runner = this.getRunner(cwd, agentKind);
    if (
      !('runCompact' in runner) ||
      typeof (runner as Record<string, unknown>).runCompact !== 'function'
    ) {
      await this.sendResult({ text: '⚠️ 当前运行模式不支持 Compact' }, ctx);
      return;
    }

    log.info(`[bridge] handleResumeCompact executing runCompact sessionId=${sessionId} cwd=${cwd}`);
    await this.streamCodexCompact({ sessionId, cwd, agentKind, runner, ctx });
  }

  /**
   * Execute a bash command and stream output to a card.
   * `!` commands bypass the serial queue entirely (see body comment + §9.6):
   * bash runs in parallel with same-workspace agent runs, tracked in
   * `activeBashRuns` separately from `activeRuns`.
   */
  async executeBash(command: string, ctx: BridgeContext): Promise<void> {
    const cwd = this.resolveCwd(ctx.userId);

    getLogger().info(
      `[bridge] executeBash start userId=${ctx.userId} sessionCwd=${this.sessionStore.get(ctx.userId)?.cwd} command="${command.slice(0, 30)}..."`,
    );

    if (!cwd) {
      getLogger().info(`[bridge] executeBash no cwd, sending error`);
      await this.sendResult(
        { text: '请先使用 /cd <path> 设置工作目录，或保存一个 workspace (/ws save <name>)' },
        ctx,
      );
      return;
    }

    getLogger().info(`[bridge] executeBash proceeding cwd=${cwd}`);

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
    ctx: BridgeContext,
    cwd: string,
  ): Promise<void> {
    getLogger().debug(
      `[bridge] executeBashInternal userId=${ctx.userId} chatId=${ctx.chatId} cwd=${cwd} command="${command.slice(0, 50)}..."`,
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
    // same workspace, so they must NOT share activeRuns (which is keyed by cwd
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
        `[bridge] executeBashInternal about to start stream chatId=${ctx.chatId} messageId=${ctx.messageId}`,
      );
      try {
        await cardSession.start();
        getLogger().info(`[bridge] executeBash stream started runId=${runId}`);
      } catch (err) {
        getLogger().warn('[bridge] bash card stream unavailable:', err);
      }

      for await (const event of bashRunner.run(command, { cwd })) {
        if (event.type === 'stdout') {
          // P1-4 层④：bridge 本地 output 也必须 store-time 截断——仅 session state
          // 有界并不会让 `output +=` 自然有界（review 第④条表述不成立），!yes 洪峰
          // 下本地字符串仍全量驻留。capBashOutput 增量调用 O(CAP+chunk)，不会带回
          // O(n²) 截断成本（output 恒 ≤ CAP，拼接后 ≤ CAP+chunk 再 slice 尾部）。
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
      getLogger().error(`[bridge] bash run error runId=${runId}:`, err);
      // If for-await threw mid-stream the bash child may still be running.
      // Stop it before finalizing the card — otherwise the finally block
      // removes the activeBashRuns entry and /stop can no longer reach it,
      // leaving an orphan process.
      try {
        await bashRunner.stop();
      } catch (stopErr) {
        getLogger().warn(`[bridge] bash stop failed:`, stopErr);
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
        // Use 2.0 schema to match the streaming card (M2: avoid 2.0→1.x downgrade).
        try {
          await this.connector.sendWithRetry(
            ctx.chatId,
            { card: renderBashCard(cardSession.currentState, {}) },
            { replyTo: ctx.messageId },
          );
        } catch {
          /* ignore fallback errors */
        }
      }
      if (this.activeBashRuns.has(runId)) {
        this.activeBashRuns.delete(runId);
        getLogger().info(`[bridge] executeBash done runId=${runId} exitCode=${exitCode}`);
      }

      // Add a Done emoji reaction to the user's original message to signal completion
      void this.connector.addReaction(ctx.messageId, 'Done');
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
