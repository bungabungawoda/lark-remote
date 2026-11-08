import {
  loadConfig,
  getAgentConfig,
  PI_DEFAULTS,
  KIMI_DEFAULTS,
  CODEBUDDY_DEFAULTS,
  QODER_DEFAULTS,
  type AppConfig,
} from './config/index.js';
import type { AgentSessionContentEvent, AgentSessionUsage } from './session-contract.js';
import { resolveAgentChoices } from './runner/index.js';
import { ensureConfig } from './config/wizard.js';
import {
  parseCliArgs,
  resolveConfigDir,
  setConfigDir,
  printHelp,
  printVersion,
} from './config/dir.js';
import { FeishuConnector } from './connector/index.js';
import {
  ClaudeRunner,
  CodexAppServerRunner,
  OpencodeAcpRunner,
  PiRpcRunner,
  KimiAcpRunner,
  DshRunner,
  CodebuddyAcpRunner,
  QoderRunner,
} from './runner/index.js';
import { AgentRegistry } from './runner/registry.js';
import { probeAllAgents } from './runner/probe.js';
import { warmCodexCatalogCache } from './config/codex-config.js';
import { warmCodebuddyCatalogCache } from './config/codebuddy-catalog.js';
import { SessionReaderRegistry, SessionStore } from './session/index.js';
import {
  ClaudeSessionReader,
  CodexSessionReader,
  OpencodeSessionReader,
  PiSessionReader,
  KimiSessionReader,
  DshSessionReader,
  CodebuddySessionReader,
  QoderSessionReader,
} from './session/index.js';
import { CommandRouter } from './router/index.js';
import { DshDaemon } from './runner/dsh/daemon.js';
import { DshClient } from './runner/dsh/client.js';
import {
  DshInflightStore,
  dshInflightPath,
  reconcileInflightDshRuns,
} from './runner/dsh/inflight.js';
import { Bridge } from './bridge/index.js';
import { initLogger, getLogger } from './logger/index.js';
import { StartupContactStore, sendStartupHello } from './startup-contact.js';
import { OwnerBinder, formatBindGuidance } from './binder.js';
import { CloneSession } from './clone.js';
import { InstanceAlreadyRunningError, InstanceLock } from './instance-lock.js';
import { spawnReplacementBridge, waitForPreviousInstance } from './restart.js';
import { currentPlatform } from './platform/select.js';
import { startSleepBlocker } from './platform/sleep-blocker.js';
import {
  checkLatestVersion,
  compareVersions,
  runInstallLatest,
  formatUpdateHint,
} from './update/index.js';
import { classifyRejection } from './error-classification.js';
import { WorkspaceStore } from './workspace/index.js';
import { buildSessionHistoryCard, pickResumeCardEvents } from './card/card-helpers.js';
import { newSessionButton, resumeCompactButton, agentDisplayName } from './card/card-shared.js';
import path from 'node:path';
import { setupMessageHandlers } from './message-handlers.js';

/**
 * 分钟 → 毫秒（turn idle timeout 等 config 字段共用）。
 * 未配置（undefined/null）→ undefined = 不设该超时，与原三处内联三元逐字等价。
 */
function minutesToMs(minutes?: number): number | undefined {
  return minutes != null ? minutes * 60_000 : undefined;
}

/** Session display state from readSessionContent */
interface SessionDisplayState {
  events: AgentSessionContentEvent[];
  /** 完整 session usage（ccusage 式 jsonl 聚合），直接透传给 formatUsageStats。 */
  usage?: AgentSessionUsage;
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
  /** Agent type for display name (e.g. 'claude', 'pi') */
  agentKind?: string;
}

/** Send auto-resume card for a restored session */
async function sendAutoResumeCard(
  connector: FeishuConnector,
  contact: { chatId?: string; userId?: string },
  cwd: string,
  session: { sessionId: string; summary: string },
  state: SessionDisplayState,
  compactSupported = false,
  stillRunning = false,
): Promise<void> {
  if (!contact.userId) return;

  const recipient = contact.chatId ?? contact.userId;
  if (!recipient) return;

  // Limit history events to prevent card size exceeded error (11310).
  // 窗口按"最后 N 条"截，但强制保住最后一条用户消息与最后一条 assistant 正文，
  // 否则工具往返多时（如连续 bash 面板占满窗口）会把这两条挤出卡。
  const MAX_HISTORY_EVENTS = 5;
  const eventsToShow = pickResumeCardEvents(state.events, MAX_HISTORY_EVENTS);
  const hiddenCount = state.events.length - eventsToShow.length;

  // Action buttons: Compact (runCompact-capable runner) + new session.
  const agentKind = state.agentKind ?? 'claude';
  const actionButtons: object[] = [];
  if (compactSupported) {
    actionButtons.push(resumeCompactButton(session.sessionId, state.agentKind ?? 'codex'));
  }
  actionButtons.push(newSessionButton());

  const card = buildSessionHistoryCard(
    {
      sessionId: session.sessionId,
      cwd,
      displayTitle: state.displayTitle,
      aiTitle: state.aiTitle,
      recap: state.recap,
      events: eventsToShow,
      usage: state.usage,
    },
    {
      agentKind,
      headerText: `📂 \`${cwd}\`\n已恢复最近会话: **${session.sessionId}**`,
      title: `🔁 自动恢复会话 · ${agentDisplayName(agentKind)}`,
      hiddenCount,
      stillRunning,
      actions: actionButtons,
    },
  );

  await connector.sendWithRetry(recipient, { card });
}

/** Initialize CLI args, config, and logger. Returns { config, configDir, logger, instanceLock }. */
async function initializeCliAndConfig(): Promise<{
  config: ReturnType<typeof loadConfig>;
  configDir: string;
  logger: ReturnType<typeof getLogger>;
  instanceLock: InstanceLock;
}> {
  const cliArgs = parseCliArgs();
  const configDir = resolveConfigDir(cliArgs.configDir);
  setConfigDir(configDir);

  const configPath = path.join(configDir, 'config.yaml');
  await ensureConfig(configPath);
  let config = loadConfig(configPath);
  // Apply agentChoices: restore last used config for current agent
  config = resolveAgentChoices(config);

  const logDir = path.join(configDir, 'logs');
  initLogger({
    level: config.logging.level,
    dir: logDir,
  });
  const logger = getLogger();
  const instanceLock = new InstanceLock(path.join(configDir, 'lark-remote.pid'));
  return { config, configDir, logger, instanceLock };
}

/** Acquire instance lock and setup global exception handlers. */
async function setupInstanceLockAndHandlers(
  instanceLock: InstanceLock,
  logger: ReturnType<typeof getLogger>,
  configDir: string,
): Promise<void> {
  try {
    // acquire 是异步的（身份校验走 platform/identity，win32 侧是异步 CIM 查询）：
    // 必须 await，否则会在校验完成前就放行第二条实例。
    await instanceLock.acquire();
  } catch (err) {
    if (err instanceof InstanceAlreadyRunningError) {
      logger.error(
        `[startup] another lark-remote is already running for configDir=${configDir} pid=${err.pid}`,
      );
      console.error(`[lark-remote] already running (pid ${err.pid})`);
      process.exit(1);
    }
    throw err;
  }
  instanceLock.registerExitHandlers();

  process.on('uncaughtException', (err) => {
    logger.error('[fatal] uncaught exception:', err);
    instanceLock.release();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    if (classifyRejection(reason) === 'recoverable') {
      logger.error('[fatal] unhandled rejection (recoverable, will continue):', reason);
      // Don't exit — the error is logged but the process continues.
      // Covers transient network issues (502/503/504/ETIMEDOUT/ECONNRESET) and
      // feishu business errors on streaming patches (e.g. 230027 external-chat
      // permission), which escape via SDK throttle detach — see error-classification.ts.
    } else {
      logger.error('[fatal] unhandled rejection:', reason);
      instanceLock.release();
      process.exit(1);
    }
  });
}

/**
 * 各 agent 的 session reader 集合。runner factory 与 SessionReaderRegistry
 * 必须共享同一实例（bridge 读 usage / router 列 session 走同一份缓存）。
 */
interface AgentSessionReaders {
  claude: ClaudeSessionReader;
  codex: CodexSessionReader;
  opencode: OpencodeSessionReader;
  pi: PiSessionReader;
  kimi: KimiSessionReader;
  dsh: DshSessionReader;
  codebuddy: CodebuddySessionReader;
  qoder: QoderSessionReader;
}

/**
 * 创建全部 session reader。runner 侧不 import session 层（否则 runner ↔ session
 * 互相依赖），统一由组合根注入。
 */
function createSessionReaders(
  config: ReturnType<typeof loadConfig>,
  latest: () => AppConfig,
): AgentSessionReaders {
  // claude 的会话读取器与其余 agent 一样由组合根注入：runner 侧不 import session
  // 层（否则 runner ↔ session 互相依赖），且 bridge 读 usage / router 列 session
  // 用的是同一个实例（缓存共用）。
  const claude = new ClaudeSessionReader();
  const codex = new CodexSessionReader({ codexHome: process.env.CODEX_HOME });
  // Register OpencodeSessionReader (CLI version)
  // Using `opencode session list` and `session export` instead of HTTP API.
  // Share the configured binary with the ACP runner so `opencode2` (v2) can
  // be used without the reader silently falling back to a v1 `opencode`.
  // The reader is registered once; changing acp.binary at runtime requires a
  // lark-remote restart.
  const opencode = new OpencodeSessionReader({
    binary: getAgentConfig(config, 'opencode')?.acp?.binary,
  });
  const pi = new PiSessionReader();
  const kimi = new KimiSessionReader();
  // Qoder 会话目录随配置（configDir 缺省自动探测 ~/.qoder-cn → ~/.qoder）。
  const qoder = new QoderSessionReader({
    configDir: getAgentConfig(config, 'qoder')?.configDir,
  });
  // CodeBuddy 会话目录固定 ~/.codebuddy（无多形态安装），reader 免配置。
  const codebuddy = new CodebuddySessionReader();
  const dsh = new DshSessionReader({
    // hostProvider 每次调用读最新 config：/config 修改 host 后 runner 重建为
    // 新 host，reader（/resume、用量、完成卡）也跟随新 host。
    hostProvider: () => getAgentConfig(latest(), 'dsh')?.host,
    dshHomeProvider: () => getAgentConfig(latest(), 'dsh')?.dshHome,
    tokenProvider: () => getAgentConfig(latest(), 'dsh')?.token,
    credentialsFileProvider: () => getAgentConfig(latest(), 'dsh')?.credentialsFile,
  });
  return { claude, codex, opencode, pi, kimi, dsh, codebuddy, qoder };
}

/**
 * 按 agent 家族注册 runner factory。
 *
 * factory 一律从 configContainer 读最新 config（bridge.setConfig() +
 * clearRunners() 后运行时改动生效）；`latest()` 未接线时回退启动快照。
 *
 * 每个 factory 的构造逻辑抽到模块级命名函数（显式传 RunnerFactoryDeps 状态），
 * register 块内只保留转发，闭包决策点不再计入本函数圈复杂度。
 */
interface RunnerFactoryDeps {
  configDir: string;
  cliArgs: { settings?: string };
  latest: () => AppConfig;
  dshDaemon: DshDaemon;
  readers: AgentSessionReaders;
}

// Claude factory reads from configContainer (not closure) so runtime
// config changes (model, effort, stopGraceMs) take effect after
// bridge.setConfig() + clearRunners(). Same pattern as codex/pi/kimi.
function claudeRunnerOptions(deps: RunnerFactoryDeps, cwdOpt: { cwd: string }) {
  const { cliArgs, configDir, latest, readers } = deps;
  const claudeConfig = latest().claude;
  return {
    model: claudeConfig.model,
    effort: claudeConfig.effort,
    stopGraceMs: claudeConfig.stopGraceMs,
    settings: cliArgs.settings,
    pidDir: configDir,
    cwd: cwdOpt.cwd,
    sessionReader: readers.claude,
    permissionMode: claudeConfig.permissionMode,
    idleTtlMs:
      claudeConfig.idleTtlMinutes != null ? claudeConfig.idleTtlMinutes * 60_000 : undefined,
  };
}

// Register Codex runner (app-server only). The registry factory reads latest
// config from container.current so runtime config changes (model, sandbox,
// approvalPolicy, reasoningEffort, etc.) take effect after bridge.setConfig()
// + clearRunners().
function codexRunnerOptions(deps: RunnerFactoryDeps) {
  const codexConfig = getAgentConfig(deps.latest(), 'codex');
  return {
    kind: 'codex' as const,
    model: codexConfig?.model,
    modelProvider: codexConfig?.modelProvider,
    reasoningEffort: codexConfig?.reasoningEffort,
    sessionReader: deps.readers.codex,
    sandbox: codexConfig?.sandbox,
    approvalPolicy: codexConfig?.approvalPolicy,
    binary: codexConfig?.appServer?.binary,
    requestTimeoutMs: codexConfig?.appServer?.requestTimeoutMs,
    idleTtlMs: codexConfig?.appServer?.idleTtlMs,
    turnTimeoutMs: minutesToMs(codexConfig?.appServer?.turnIdleTimeoutMinutes),
  };
}

// Register OpencodeAcpRunner (pure ACP mode, `opencode acp` JSON-RPC over stdio)
function opencodeRunnerOptions(deps: RunnerFactoryDeps) {
  const ocConfig = getAgentConfig(deps.latest(), 'opencode');

  // Build model string with validation: provider/model format
  let model: string | undefined;
  if (ocConfig?.modelID) {
    const provider = ocConfig.providerID ?? 'anthropic';
    // Validate: if modelID contains '/', it's already in provider/model format
    if (ocConfig.modelID.includes('/')) {
      model = ocConfig.modelID;
    } else {
      model = `${provider}/${ocConfig.modelID}`;
    }
  }

  return {
    kind: 'opencode' as const,
    model,
    sessionReader: deps.readers.opencode,
    mode: ocConfig?.mode ?? 'build',
    binary: ocConfig?.acp?.binary,
    requestTimeoutMs: ocConfig?.acp?.requestTimeoutMs,
    idleTtlMs: ocConfig?.acp?.idleTtlMs,
    turnIdleTimeoutMs: minutesToMs(ocConfig?.acp?.turnIdleTimeoutMinutes),
  };
}

// Register PiRpcRunner.
// factory 闭包必须读最新 config 而不是启动时的快照，否则 /config 保存后
// provider 等字段对 pi 不生效：config 引用放在可变容器里（见上文
// setConfigContainer），factory 每次从容器取最新值。
// PiSessionReader 的创建与注册见 registerSessionReaders。
function piRunnerOptions(deps: RunnerFactoryDeps, cwdOpt: { cwd: string }) {
  const piConf = getAgentConfig(deps.latest(), 'pi');
  return {
    provider: piConf?.provider ?? PI_DEFAULTS.provider,
    model: piConf?.model ?? PI_DEFAULTS.model,
    thinking: piConf?.thinking ?? PI_DEFAULTS.thinking,
    tools: (piConf?.tools ?? PI_DEFAULTS.tools)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    cwd: cwdOpt.cwd,
    sessionReader: deps.readers.pi,
  };
}

// Register KimiAcpRunner (pure ACP mode)
function kimiRunnerOptions(deps: RunnerFactoryDeps) {
  const kimiConf = getAgentConfig(deps.latest(), 'kimi');

  const acpConf = kimiConf?.acp;
  return {
    kind: 'kimi' as const,
    sessionReader: deps.readers.kimi,
    binary: acpConf?.binary ?? 'kimi',
    requestTimeoutMs: acpConf?.requestTimeoutMs,
    idleTtlMs: acpConf?.idleTtlMs,
    turnIdleTimeoutMs: minutesToMs(acpConf?.turnIdleTimeoutMinutes),
    model: kimiConf?.model ?? KIMI_DEFAULTS.model,
    thinkingEffort: kimiConf?.thinkingEffort,
    permissionMode: kimiConf?.permissionMode ?? 'manual',
  };
}

// Register CodebuddyAcpRunner (pure ACP mode, `codebuddy --acp`)
function codebuddyRunnerOptions(deps: RunnerFactoryDeps) {
  const conf = getAgentConfig(deps.latest(), 'codebuddy');
  const acpConf = conf?.acp;
  return {
    kind: 'codebuddy' as const,
    sessionReader: deps.readers.codebuddy,
    binary: acpConf?.binary,
    // env 透传（如 CN 版 CODEBUDDY_INTERNET_ENVIRONMENT），undefined 不覆盖。
    env: conf?.env,
    requestTimeoutMs: acpConf?.requestTimeoutMs,
    idleTtlMs: acpConf?.idleTtlMs,
    turnIdleTimeoutMs: minutesToMs(acpConf?.turnIdleTimeoutMinutes),
    model: conf?.model,
    permissionMode: conf?.permissionMode ?? CODEBUDDY_DEFAULTS.permissionMode,
    thinkingLevel: conf?.thinkingLevel,
    sandbox: conf?.sandbox,
  };
}

// Register QoderRunner (generic CLI mode, long-lived stream-json session).
// factory 闭包读最新 config（同 pi/kimi 的 container 语义）。
function qoderRunnerOptions(deps: RunnerFactoryDeps, cwdOpt: { cwd: string }) {
  const conf = getAgentConfig(deps.latest(), 'qoder');
  return {
    model: conf?.model,
    reasoningEffort: conf?.reasoningEffort,
    settings: deps.cliArgs.settings,
    stopGraceMs: conf?.stopGraceMs,
    pidDir: deps.configDir,
    cwd: cwdOpt.cwd,
    sessionReader: deps.readers.qoder,
    binary: conf?.cli?.binary,
    permissionMode: conf?.permissionMode ?? QODER_DEFAULTS.permissionMode,
    contextWindow: conf?.contextWindow,
    idleTtlMs: conf?.idleTtlMinutes != null ? conf.idleTtlMinutes * 60_000 : undefined,
  };
}

// Warm the shared process in the background so the first message and
// `/resume` do not pay the full startup delay. Failures surface from
// DshRunner.run(), which awaits the same resolver.
function warmDshDaemon(dshDaemon: DshDaemon, failureLabel: string): void {
  void dshDaemon.ensure().catch((error: unknown) => {
    getLogger().warn(`[dsh] ${failureLabel}: ${(error as Error).message}`);
  });
}

// Register DshRunner (HTTP-only DSH Web Host agent).
function dshRunnerOptions(deps: RunnerFactoryDeps) {
  const dshConf = getAgentConfig(deps.latest(), 'dsh');
  return {
    kind: 'dsh' as const,
    sessionReader: deps.readers.dsh,
    daemon: deps.dshDaemon,
    host: dshConf?.host,
    dshHome: dshConf?.dshHome,
    token: dshConf?.token,
    credentialsFile: dshConf?.credentialsFile,
    agentPreset: dshConf?.agentPreset,
    permissionPreset: dshConf?.permissionPreset,
    provider: dshConf?.provider,
    model: dshConf?.model,
    reasoningEffort: dshConf?.reasoningEffort,
    // Durable markers for turns that outlive this process; reconciled on the
    // next startup (see reconcileInflightDshRuns).
    inflightPath: dshInflightPath(deps.configDir),
  };
}

function registerRunners(agentRegistry: AgentRegistry, deps: RunnerFactoryDeps): void {
  agentRegistry.register('claude', (ws) => {
    return new ClaudeRunner(claudeRunnerOptions(deps, { cwd: ws }));
  });

  agentRegistry.register('codex', (_ws: string) => {
    return new CodexAppServerRunner(codexRunnerOptions(deps));
  });

  agentRegistry.register('opencode', (_ws: string) => {
    return new OpencodeAcpRunner(opencodeRunnerOptions(deps));
  });

  agentRegistry.register('pi', (ws: string) => {
    return new PiRpcRunner(piRunnerOptions(deps, { cwd: ws }));
  });

  agentRegistry.register('kimi', (_ws: string) => {
    return new KimiAcpRunner(kimiRunnerOptions(deps));
  });

  agentRegistry.register('dsh', (_ws: string) => {
    warmDshDaemon(deps.dshDaemon, 'background start failed');
    return new DshRunner(dshRunnerOptions(deps));
  });

  agentRegistry.register('codebuddy', (_ws: string) => {
    return new CodebuddyAcpRunner(codebuddyRunnerOptions(deps));
  });

  agentRegistry.register('qoder', (ws: string) => {
    return new QoderRunner(qoderRunnerOptions(deps, { cwd: ws }));
  });
}

/** 按 agent 家族注册 session reader（与 runner factory 共享同一实例）。 */
function registerSessionReaders(
  registry: SessionReaderRegistry,
  readers: AgentSessionReaders,
): void {
  registry.register('claude', readers.claude);
  registry.register('codex', readers.codex);
  registry.register('opencode', readers.opencode);
  registry.register('pi', readers.pi);
  registry.register('kimi', readers.kimi);
  registry.register('dsh', readers.dsh);
  registry.register('codebuddy', readers.codebuddy);
  registry.register('qoder', readers.qoder);
}

/** 探测 agent CLI 可用性（fire-and-forget，填充 /config 卡片缓存）。 */
function probeAgentsInBackground(): void {
  probeAllAgents().then(logAgentProbeResults).catch(logAgentProbeFailure);
}

function logAgentProbeResults(availability: Awaited<ReturnType<typeof probeAllAgents>>): void {
  const unavailable = [...availability.entries()].filter(([, ok]) => !ok).map(([kind]) => kind);
  if (unavailable.length > 0) {
    getLogger().warn(`[probe] agent CLI not found or not functional: ${unavailable.join(', ')}`);
  } else {
    getLogger().info('[probe] all agent CLIs available');
  }
}

function logAgentProbeFailure(err: unknown): void {
  getLogger().warn(`[probe] background probe failed: ${(err as Error).message}`);
}

/** runner factory 取最新 config 的唯一入口（container 未接线时回退启动快照）。 */
function createConfigLatest(
  agentRegistry: AgentRegistry,
  config: ReturnType<typeof loadConfig>,
): () => AppConfig {
  return () => (agentRegistry.getConfigContainer()?.current as AppConfig) ?? config;
}

/** One global DSH per machine/DSH_HOME：provider 箭头在模块级函数内定义。 */
function createDshDaemon(latest: () => AppConfig): DshDaemon {
  return new DshDaemon({
    host: () => getAgentConfig(latest(), 'dsh')?.host,
    dshHome: () => getAgentConfig(latest(), 'dsh')?.dshHome,
    dshCommand: () => getAgentConfig(latest(), 'dsh')?.dshCommand,
    manageProcess: () => getAgentConfig(latest(), 'dsh')?.manageProcess ?? true,
    startTimeoutMs: () => getAgentConfig(latest(), 'dsh')?.startTimeoutMs,
  });
}

/** Initialize per-workspace runner factory + agent registry. */
function initializeRunner(
  config: ReturnType<typeof loadConfig>,
  configDir: string,
  cliArgs: { settings?: string },
): {
  agentRegistry: AgentRegistry;
  sessionReaderRegistry: SessionReaderRegistry;
} {
  const agentRegistry = new AgentRegistry();

  // 单点化：runner factory 取最新 config 的唯一入口（语义保持，
  // container 未接线时回退启动快照）。
  const latest = createConfigLatest(agentRegistry, config);

  // 用可变容器存储 config 引用，registry 持有容器引用，factory 从容器读取最新值。
  agentRegistry.setConfigContainer({ current: config });

  // One global DSH per machine/DSH_HOME. This resolver reuses a listening
  // process or starts `dsh web` detached; it never owns the child's lifetime.
  const dshDaemon = createDshDaemon(latest);

  const readers = createSessionReaders(config, latest);
  registerRunners(agentRegistry, { configDir, cliArgs, latest, dshDaemon, readers });

  const sessionReaderRegistry = new SessionReaderRegistry();
  registerSessionReaders(sessionReaderRegistry, readers);

  if (config.defaultAgent === 'dsh') {
    warmDshDaemon(dshDaemon, 'startup probe failed');
  }

  // Probe agent CLI availability (fire-and-forget, populates cache for /config card).
  // Don't block startup — log unavailable agents as warnings.
  probeAgentsInBackground();

  // Warm the codebuddy ACP catalog in the background（模型/思考档位下拉的
  // 数据源；失败落 negative cache，卡片回退文本输入 + 静态档位清单）。
  warmCodebuddyCatalogCache();

  // Warm the codex model catalog in the background so the first Codex /config
  // card open reads a warm cache instead of blocking the event loop for up to
  // 8s (execFileSync cold path). Fire-and-forget; failure lands in negative
  // cache and the sync card path falls back gracefully.
  warmCodexCatalogCache();

  return { agentRegistry, sessionReaderRegistry };
}

/**
 * CLI 早期退出分支：--help / --version / --update。
 *
 * 红线：三者都必须在 config 加载与单例锁之前完成——--help/--version 是纯信息
 * 查询，另一实例在跑、或还没有 config 时也必须能应答；--update 不是守护类命令，
 * 等锁只会误报 "already running"。返回 true 表示进程应停止。
 */
async function handleCliEarlyExit(cliArgs: ReturnType<typeof parseCliArgs>): Promise<boolean> {
  // --help/--version must bypass config loading and singleton lock — it's a pure
  // informational query that must work even when another instance is running
  // or no config exists yet.
  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }
  if (cliArgs.version) {
    printVersion();
    process.exit(0);
  }
  // --update: upgrade to latest version and exit (for cron/script automation)
  if (cliArgs.update) {
    // --update 在 acquireLock 之前执行；先解析 configDir 并初始化 logger，
    // 让版本检查的日志落到正确目录（默认 ~/.lark-remote 或 --config-dir 指定）。
    const updateConfigDir = resolveConfigDir(cliArgs.configDir);
    initLogger({ dir: path.join(updateConfigDir, 'logs') });
    try {
      const { current, latest } = await checkLatestVersion();
      if (compareVersions(current, latest) !== 1) {
        console.log(`Already up to date: ${current}`);
        process.exit(0);
      }
      console.log(`Updating ${current} → ${latest} ...`);
      const result = await runInstallLatest();
      if (!result.success) {
        console.error(`Update failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`✅ Updated to ${latest}. Restart lark-remote to use the new version.`);
      process.exit(0);
    } catch (err) {
      console.error(`Update failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  return false;
}

/** bootstrap 阶段产物：config/logger/单例锁就绪后的上下文，wire 阶段消费。 */
interface BootstrapContext {
  cliArgs: ReturnType<typeof parseCliArgs>;
  config: ReturnType<typeof loadConfig>;
  configDir: string;
  logger: ReturnType<typeof getLogger>;
}

/**
 * Bootstrap：configDir → config → logger → 单例锁 → 防休眠 → 启动配置日志。
 * 顺序红线：waitForPreviousInstance 必须先于 instanceLock.acquire()（/restart
 * 替补进程要等旧实例释放锁才能拿到单例锁）；PID 存活校验在 acquire 内完成。
 */
async function bootstrap(cliArgs: ReturnType<typeof parseCliArgs>): Promise<BootstrapContext> {
  const { config, configDir, logger, instanceLock } = await initializeCliAndConfig();

  // Restart handoff: if spawned as a /restart replacement, wait for the old
  // lark-remote to die (and release the instance lock) before acquiring it.
  await waitForPreviousInstance();

  await setupInstanceLockAndHandlers(instanceLock, logger, configDir);

  // 阻止系统休眠（macOS caffeinate / Windows SetThreadExecutionState）：lark-remote
  // 的场景是人不在电脑前远程使用，系统休眠即失联。恒开启、无配置开关；helper 进程
  // 绑定本进程生命周期（caffeinate -w / powershell 轮询父 pid），崩溃也能自清理；
  // 'exit' 钩子里的 stop() 仅覆盖优雅退出路径。
  const sleepBlocker = startSleepBlocker({ platform: currentPlatform, pid: process.pid });
  if (sleepBlocker) {
    process.on('exit', () => sleepBlocker.stop());
  }

  logger.info('config loaded');
  logger.info(`configDir = ${configDir}`);
  logger.info(`feishu.appId = ${config.feishu.appId}`);
  logger.info(`claude.model = ${config.claude.model}`);
  if (cliArgs.settings) {
    logger.info(`claude.settings = ${cliArgs.settings}`);
  }
  return { cliArgs, config, configDir, logger };
}

/** wire() 装配产物：启动联络（连接/问候/对账/自动恢复）所需的全部引用。 */
interface WiredApp {
  cliArgs: ReturnType<typeof parseCliArgs>;
  config: ReturnType<typeof loadConfig>;
  configDir: string;
  logger: ReturnType<typeof getLogger>;
  connector: FeishuConnector;
  startupContactStore: StartupContactStore;
  binder: OwnerBinder;
  sessionStore: SessionStore;
  bridge: Bridge;
  sessionReaderRegistry: SessionReaderRegistry;
}

/** Wiring：装配 connector / stores / bridge / router / 消息处理器（不连接）。 */
function wire(boot: BootstrapContext): WiredApp {
  const { cliArgs, config, configDir, logger } = boot;
  const { agentRegistry, sessionReaderRegistry } = initializeRunner(config, configDir, cliArgs);

  const connector = new FeishuConnector(config);
  const startupContactStore = new StartupContactStore(path.join(configDir, 'startup-contact.json'));
  const binder = new OwnerBinder(startupContactStore);
  if (!binder.isBound()) {
    // 未绑定：控制台（stderr）引导任意消息绑定。守护模式下被 watchdog 重定向到日志
    console.error(formatBindGuidance());
    logger.info('[binder] awaiting first binding (any first private message binds)');
  } else {
    logger.info(`[binder] bound to owner userId=${binder.boundUserId()}`);
  }

  const sessionStore = new SessionStore(path.join(configDir, 'last-session.json'));
  const workspaceStore = new WorkspaceStore(path.join(configDir, 'workspace.json'));
  const bridge = new Bridge({
    connector,
    sessionStore,
    config,
    workspaceStore,
    agentRegistry,
    sessionReaderRegistry,
  });
  const cloneSession = new CloneSession({
    connector,
    configPath: path.join(configDir, 'config.yaml'),
    configDir,
  });
  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath: path.join(configDir, 'config.yaml'),
    workspacePath: path.join(configDir, 'workspace.json'),
    ordersPath: path.join(configDir, 'orders.json'),
    restartSpawner: () => spawnReplacementBridge(path.join(configDir, 'logs')),
    sessionReaderRegistry,
    devMode: cliArgs.dev,
    updateCachePath: path.join(configDir, 'update-cache.json'),
    cloneSession,
  });

  setupMessageHandlers({
    connector,
    router,
    bridge,
    sessionStore,
    workspaceStore,
    binder,
    logger,
    config,
    cloneSession,
  });

  return {
    cliArgs,
    config,
    configDir,
    logger,
    connector,
    startupContactStore,
    binder,
    sessionStore,
    bridge,
    sessionReaderRegistry,
  };
}

/**
 * Auto-restore: resume the persisted sessionId if available.
 * 非关键启动优化：发送失败只告警（logger 已初始化），不允许经
 * main().catch → process.exit(1) 拖垮整个桥接。
 */
async function restoreLastSession(app: WiredApp): Promise<void> {
  const {
    config,
    logger,
    sessionStore,
    sessionReaderRegistry,
    bridge,
    connector,
    startupContactStore,
  } = app;
  const restoredContact = startupContactStore.getContact();
  if (!restoredContact?.userId) return;
  const restoredCwd = sessionStore.getCwd(restoredContact.userId);
  if (!restoredCwd) return;
  const sessionIdToResume = sessionStore.getSessionId(restoredContact.userId, config.defaultAgent);
  if (!sessionIdToResume) return;

  logger.info(`[startup] auto-resuming persisted session ${sessionIdToResume} in ${restoredCwd}`);
  const startupReader = sessionReaderRegistry.get(config.defaultAgent);
  sessionStore.setSessionIdAndCwd(
    restoredContact.userId,
    config.defaultAgent,
    sessionIdToResume,
    restoredCwd,
  );
  const content = startupReader.readSessionContent(sessionIdToResume, restoredCwd);
  // 该会话可能仍有在途 turn（上一个实例退出/崩溃后留在常驻 host 里）。
  // 不取消、不接管，但必须在卡上说明，否则用户会把它当"卡住了"。
  //
  // 只有 DSH reader 的 isSessionActive() 是服务端的 running 事实。其他
  // reader 的同名方法只表示"最近一段时间有写入"，拿它当 turn 在跑会在
  // 每次自动恢复时误报。
  const stillRunning =
    config.defaultAgent === 'dsh'
      ? (() => {
          try {
            return startupReader.isSessionActive(sessionIdToResume, restoredCwd);
          } catch (err) {
            getLogger().warn(`[startup] isSessionActive failed: ${(err as Error).message}`);
            return false;
          }
        })()
      : false;
  if (stillRunning) {
    getLogger().warn(
      `[startup] session ${sessionIdToResume} still has a running turn; auto-resume card is a snapshot`,
    );
  }
  // 完整透传 usage（含 inputTokens/outputTokens/totalTokens），
  // 让 formatUsageStats 走真实值路径，与终态卡片//resume 卡片口径一致。
  const usage = content.usage;
  // Build auto-resume card and send to the user. Auto-resume is a
  // non-critical startup nicety: a sendWithRetry failure here (e.g.
  // transient feishu API error) must not crash the bridge via
  // main().catch → process.exit(1). Logger is already initialized.
  try {
    await sendAutoResumeCard(
      connector,
      restoredContact,
      restoredCwd,
      { sessionId: sessionIdToResume, summary: '' },
      {
        events: content.events,
        usage,
        aiTitle: content.aiTitle,
        recap: content.recap,
        displayTitle: content.displayTitle,
        agentKind: config.defaultAgent,
      },
      // Compact 能力探测与 bridge 侧一致（runner 有 runCompact 才渲染）。
      bridge.hasRunCompact(restoredCwd, config.defaultAgent),
      stillRunning,
    );
  } catch (err) {
    getLogger().warn('[startup] sendAutoResumeCard failed:', err);
  }
}

/**
 * 启动时静默检查版本（由 checkUpdateOnStartup 控制，默认关闭）。
 * 抽成模块级 async 函数（原为 main 内的 fire-and-forget IIFE）；失败只告警，
 * 不允许经 main().catch → process.exit(1) 拖垮整个桥接。
 */
async function checkUpdateOnStartupNotify(app: WiredApp): Promise<void> {
  try {
    const cachePath = path.join(app.configDir, 'update-cache.json');
    const { current, latest } = await checkLatestVersion({ cachePath });
    const hint = formatUpdateHint(current, latest);
    if (hint) {
      const contact = app.startupContactStore.getContact();
      const recipient = contact?.chatId ?? contact?.userId;
      if (recipient) {
        await app.connector.sendWithRetry(recipient, { text: hint });
      }
    }
  } catch (err) {
    // Non-fatal: startup check failure must not crash the bridge
    app.logger.warn(`[startup] update check failed: ${(err as Error).message}`);
  }
}

/**
 * 上次进程可能死在 DSH turn 中途：清掉残留的待执行 prompt，并对仍在跑的
 * turn 提示 owner（不自动 cancel——它可能是 Web UI 的 turn）。清理不依赖是否
 * 已绑定；没有收件人时只是不发提示。
 */
function reconcileDshInflightOnStartup(app: WiredApp): void {
  const dshConf = getAgentConfig(app.config, 'dsh');
  if (!dshConf) return;
  const contact = app.startupContactStore.getContact();
  const recipient = contact?.chatId ?? contact?.userId;
  void reconcileInflightDshRuns({
    store: new DshInflightStore(dshInflightPath(app.configDir)),
    client: new DshClient(dshConf.host ?? 'http://127.0.0.1:3080', {
      dshHome: dshConf.dshHome,
      token: dshConf.token,
      credentialsFile: dshConf.credentialsFile,
      // Host may be down: bound the probe instead of waiting the default 60s.
      requestTimeoutMs: 3_000,
    }),
    ...(recipient
      ? {
          notify: async (text: string) => {
            await app.connector.sendWithRetry(recipient, { text });
          },
        }
      : {}),
  }).catch((err: unknown) => {
    app.logger.warn(`[startup] dsh inflight reconcile failed: ${(err as Error).message}`);
  });
}

async function main() {
  const cliArgs = parseCliArgs();
  if (await handleCliEarlyExit(cliArgs)) return;
  const boot = await bootstrap(cliArgs);
  const app = wire(boot);
  const { config, logger, connector, startupContactStore, binder } = app;

  try {
    await connector.connect();
  } catch (err) {
    logger.error('failed to connect to Feishu, check appId/appSecret:', err);
    process.exit(1);
  }

  if (binder.isBound()) {
    // 仅已绑定时发送启动通知；未绑定时不打扰（PIN 引导已在控制台输出）
    await sendStartupHello(connector, startupContactStore, { dev: app.cliArgs.dev });

    // 启动时静默检查版本（由 checkUpdateOnStartup 控制，默认关闭）
    if (config.checkUpdateOnStartup) {
      void checkUpdateOnStartupNotify(app);
    }
  }

  reconcileDshInflightOnStartup(app);

  await restoreLastSession(app);

  logger.info('lark-remote is running, press Ctrl+C to exit');
}

main().catch((err) => {
  getLogger().error('fatal error:', err);
  process.exit(1);
});
