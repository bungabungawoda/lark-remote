import {
  loadConfig,
  getAgentConfig,
  DEFAULT_STOP_GRACE_MS,
  type AppConfig,
} from './config/index.js';
import {
  resolveAgentChoices,
  type AgentSessionContentEvent,
  type AgentSessionUsage,
} from './runner/index.js';
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
  CodexExecRunner,
  OpencodeExecRunner,
  PiRunner,
  KimiRunner,
} from './runner/index.js';
import { AgentRegistry } from './runner/registry.js';
import { probeAllAgents } from './runner/probe.js';
import { SessionReaderRegistry, SessionStore } from './session/index.js';
import {
  ClaudeSessionReader,
  CodexSessionReader,
  OpencodeSessionReader,
  PiSessionReader,
  KimiSessionReader,
} from './session/index.js';
import {
  CommandRouter,
  isImmediateAction,
  type CardActionPayload,
  formatUsageStats,
} from './router/index.js';
import { dispatchOrderExecForQueue } from './router/order-exec-dispatch.js';
import { Bridge } from './bridge/index.js';
import { initLogger, getLogger } from './logger/index.js';
import { StartupContactStore, sendStartupHello } from './startup-contact.js';
import { OwnerBinder, formatPinGuidance } from './binder.js';
import { InstanceAlreadyRunningError, InstanceLock } from './instance-lock.js';
import { spawnReplacementBridge, waitForPreviousInstance } from './restart.js';
import { classifyRejection } from './error-classification.js';
import { WorkspaceStore } from './workspace/index.js';
import { markdownDiv } from './card/collapsible.js';
import { sessionEventPanel } from './router/card-helpers.js';
import { newSessionButton, agentDisplayName } from './card/card-shared.js';
import path from 'node:path';

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
): Promise<void> {
  if (!contact.userId) return;

  const recipient = contact.chatId ?? contact.userId;
  if (!recipient) return;

  // Build header with displayTitle (aiTitle or last user message) and recap
  let header = `📂 \`${cwd}\`\n已恢复最近会话: **${session.sessionId}**`;
  const sections: string[] = [];
  if (state.displayTitle) {
    const label = state.aiTitle ? 'AI 标题' : '最近输入';
    sections.push(`🏷️ **${label}**\n${state.displayTitle}`);
  }
  if (state.recap) {
    const recapPreview = state.recap.length > 200 ? state.recap.slice(0, 197) + '...' : state.recap;
    sections.push(`📝 **Recap**\n${recapPreview}`);
  }
  if (sections.length > 0) {
    header += '\n\n' + sections.join('\n\n──\n\n');
  }

  const elements: object[] = [markdownDiv(header), { tag: 'hr' }];

  // Limit history events to prevent card size exceeded error (11310)
  const MAX_HISTORY_EVENTS = 5;
  const eventsToShow = state.events.slice(-MAX_HISTORY_EVENTS);
  const hiddenCount = state.events.length - MAX_HISTORY_EVENTS;

  // Add indicator if events were hidden
  if (hiddenCount > 0) {
    elements.push(markdownDiv(`📜 还有 ${hiddenCount} 个更早的事件未显示`));
  }

  // Fold session history into collapsible panels: the last 2 events stay expanded
  const agentKind = state.agentKind ?? 'claude';
  eventsToShow.forEach((ev, i) => {
    elements.push(sessionEventPanel(ev, i, eventsToShow.length, 2, agentKind));
  });

  // Add usage/stats at the end
  if (state.usage) {
    const usageStr = formatUsageStats(state.usage);
    elements.push(markdownDiv(usageStr));
  }

  // Add new session button - use column_set+column (div+elements not supported in 2.0)
  const newSessionBtn = newSessionButton();
  elements.push({
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [newSessionBtn],
      },
    ],
  });

  const card = {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: `🔁 自动恢复会话 · ${agentDisplayName(agentKind)}`,
      },
    },
    body: { elements },
  };

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
function setupInstanceLockAndHandlers(
  instanceLock: InstanceLock,
  logger: ReturnType<typeof getLogger>,
  configDir: string,
): void {
  try {
    instanceLock.acquire();
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

  // P1-15: Claude factory reads from configContainer (not closure) so runtime
  // config changes (model, effort, stopGraceMs) take effect after
  // bridge.setConfig() + clearRunners(). Same pattern as codex/pi/kimi.
  agentRegistry.register('claude', (ws) => {
    const container = agentRegistry.getConfigContainer();
    const latestConfig = (container?.current as AppConfig) ?? config;
    const claudeConfig = latestConfig.claude;
    return new ClaudeRunner({
      model: claudeConfig.model,
      effort: claudeConfig.effort,
      stopGraceMs: claudeConfig.stopGraceMs,
      settings: cliArgs.settings,
      pidDir: configDir,
      workspace: ws,
    });
  });

  // Register CodexExecRunner (codex exec --json, approval_policy=never).
  // Factory reads latest config from container.current so runtime config changes
  // (reasoningEffort, model, etc.) take effect after bridge.setConfig() + clearRunners().
  const codexSessionReader = new CodexSessionReader({ codexHome: process.env.CODEX_HOME });
  agentRegistry.register('codex', (ws: string) => {
    const container = agentRegistry.getConfigContainer();
    const latestConfig = (container?.current as AppConfig) ?? config;
    const codexConfig = getAgentConfig(latestConfig, 'codex');
    return new CodexExecRunner({
      model: codexConfig?.model,
      modelProvider: codexConfig?.modelProvider,
      reasoningEffort: codexConfig?.reasoningEffort,
      stopGraceMs:
        codexConfig?.stopGraceMs ?? latestConfig.claude?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      pidDir: configDir,
      workspace: ws,
      sessionReader: codexSessionReader,
    });
  });

  // Register OpencodeExecRunner (run mode)
  // Using `opencode run --format json --auto` instead of HTTP+SSE server mode

  // Register session reader (same instance as used by runner)
  const sessionReaderRegistry = new SessionReaderRegistry();
  sessionReaderRegistry.register('claude', new ClaudeSessionReader());
  sessionReaderRegistry.register('codex', codexSessionReader);

  // Register OpencodeSessionReader (CLI version)
  // Using `opencode session list` and `opencode export` instead of HTTP API
  const opencodeSessionReader = new OpencodeSessionReader();

  agentRegistry.register('opencode', (ws: string) => {
    // Get latest config from container (set below for pi)
    const container = agentRegistry.getConfigContainer();
    const latestConfig = container?.current as AppConfig;
    const ocConfig = getAgentConfig(latestConfig, 'opencode');

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

    return new OpencodeExecRunner({
      model,
      // P1-15: read stopGraceMs from latestConfig (not startup closure)
      stopGraceMs: latestConfig.claude?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      pidDir: configDir,
      workspace: ws,
      sessionReader: opencodeSessionReader,
    });
  });
  sessionReaderRegistry.register('opencode', opencodeSessionReader);

  // Register PiRunner and PiSessionReader
  // 2026-07-12: 修复 config.save 后 pi provider 不生效的问题
  // 关键：factory 闭包必须能访问到最新的 config，而不是启动时的快照
  // 用可变容器存储 config 引用，registry 持有容器引用，factory 从容器读取最新值
  const configContainer = { current: config };
  agentRegistry.setConfigContainer(configContainer);
  const piSessionReader = new PiSessionReader();
  agentRegistry.register('pi', (ws: string) => {
    // 每次 factory 调用时从 registry 获取最新 config
    const container = agentRegistry.getConfigContainer();
    const latestConfig = container?.current as AppConfig;
    const piConf = getAgentConfig(latestConfig, 'pi');
    return new PiRunner({
      provider: piConf?.provider ?? 'Volcano',
      model: piConf?.model ?? 'glm-5.2',
      thinking: piConf?.thinking ?? 'medium',
      tools: (piConf?.tools ?? 'read,bash,edit,write,grep,find,ls')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      pidDir: configDir,
      workspace: ws,
      sessionReader: piSessionReader,
    });
  });
  sessionReaderRegistry.register('pi', piSessionReader);

  // Register KimiRunner and KimiSessionReader
  const kimiSessionReader = new KimiSessionReader();
  agentRegistry.register('kimi', (ws: string) => {
    // 每次 factory 调用时从 registry 获取最新 config
    const container = agentRegistry.getConfigContainer();
    const latestConfig = container?.current as AppConfig;
    const kimiConf = getAgentConfig(latestConfig, 'kimi');
    return new KimiRunner({
      model: kimiConf?.model ?? 'kimi-code/k3',
      thinkingEffort: kimiConf?.thinkingEffort ?? 'max',

      // P1-15: read stopGraceMs from latestConfig (not startup closure)
      stopGraceMs: latestConfig.claude?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      pidDir: configDir,
      workspace: ws,
      sessionReader: kimiSessionReader,
    });
  });
  sessionReaderRegistry.register('kimi', kimiSessionReader);

  // 2026-07-17: 注册所有 agent 的显示名，实现单点真相
  agentRegistry.registerDisplayName('claude', 'Claude');
  agentRegistry.registerDisplayName('codex', 'Codex');
  agentRegistry.registerDisplayName('opencode', 'Opencode');
  agentRegistry.registerDisplayName('pi', 'Pi');
  agentRegistry.registerDisplayName('kimi', 'Kimi');

  // 设置全局 registry，供 agentDisplayName 等全局函数使用
  AgentRegistry.setGlobalInstance(agentRegistry);

  // Probe agent CLI availability (fire-and-forget, populates cache for /config card).
  // Don't block startup — log unavailable agents as warnings.
  probeAllAgents()
    .then((availability) => {
      const unavailable = [...availability.entries()].filter(([, ok]) => !ok).map(([kind]) => kind);
      if (unavailable.length > 0) {
        getLogger().warn(
          `[probe] agent CLI not found or not functional: ${unavailable.join(', ')}`,
        );
      } else {
        getLogger().info('[probe] all agent CLIs available');
      }
    })
    .catch(() => {
      // Probe failure is non-fatal; /config card will retry on open.
    });

  return { agentRegistry, sessionReaderRegistry };
}

/** Setup message and card action handlers. */
function setupMessageHandlers(
  connector: FeishuConnector,
  router: CommandRouter,
  bridge: Bridge,
  sessionStore: SessionStore,
  workspaceStore: WorkspaceStore,
  binder: OwnerBinder,
  logger: ReturnType<typeof getLogger>,
  config: AppConfig,
): void {
  connector.setMessageHandler((msg) => {
    // 绑定/授权闸门：仅 owner 放行；非 owner 静默丢弃；未绑定时要求 PIN 认领
    const decision = binder.classify(msg.userId, msg.content, msg.chatId);
    if (decision.kind === 'rejected') return;
    // 未绑定且 PIN 错误：完全静默丢弃（不回复、不提醒）
    if (decision.kind === 'pin_wrong') return;
    if (decision.kind === 'bind_success') {
      // First-run onboarding: set default cwd + send welcome + Help card.
      // setCwd is synchronous (outside the async closure) so that the user's
      // next message — which will hit the `owner` branch now that
      // startup-contact.json has been written — finds cwd already set.
      // process.cwd() is the only sensible default: the user started
      // lark-remote in the directory they want to work in.
      sessionStore.setCwd(msg.userId, process.cwd());

      void (async () => {
        try {
          // Message 1: bind confirmation + status (combined to avoid
          // Feishu out-of-order delivery across three separate messages).
          await connector.sendWithRetry(msg.chatId, {
            text:
              `✅ 已绑定到本账号，此后仅你可使用本应用\n` +
              `📂 当前工作目录: \`${process.cwd()}\`\n` +
              `🤖 默认 Agent: ${agentDisplayName(config.defaultAgent)}\n` +
              `💡 直接输入消息即可开始对话，或 /cd 切换目录`,
          });
          // Message 2: Help card.
          // Use router.cmdHelp() + manual send (without replyTo) so the Help
          // card appears as an independent message, not a reply to the PIN
          // message. router.handle('/help') would set replyTo=msg.messageId
          // (the PIN), causing the card to nest under the PIN in Feishu UI.
          const helpResult = router.cmdHelp();
          if (helpResult.card) {
            await connector.sendWithRetry(msg.chatId, { card: helpResult.card });
          }
        } catch (err) {
          logger.error('[binder] onboarding send failed:', err);
        }
      })();
      return;
    }

    // decision.kind === 'owner'：正常处理（不再每条覆盖 startup-contact）
    logger.info(`message from ${msg.userId}: ${msg.content.slice(0, 100)}`);

    // Add Typing reaction to indicate "still alive"
    void connector.addReaction(msg.messageId, 'Typing');

    const trimmedLower = msg.content.trim().toLowerCase();
    if (trimmedLower === '/stop' || trimmedLower === '/t') {
      void (async () => {
        const stopped = await bridge.interruptCurrentRun({
          userId: msg.userId,
          chatId: msg.chatId,
        });
        if (!stopped) {
          await bridge.sendResult(
            { text: '当前没有运行中的进程' },
            {
              userId: msg.userId,
              chatId: msg.chatId,
              messageId: msg.messageId,
            },
          );
        }
      })().catch((err: unknown) => logger.error('[control] /stop failed:', err));
      return;
    }
    if (msg.content.trim().startsWith('/')) {
      void router
        .handle(msg.content, {
          userId: msg.userId,
          chatId: msg.chatId,
          messageId: msg.messageId,
        })
        .catch((err: unknown) => logger.error('[control] slash command failed:', err));
      return;
    }
    // `!` bash commands bypass the serial queue: they don't start claude and
    // don't touch session state, so they must run in parallel with claude runs
    // in the same workspace (design.md §9.6: the queue exists to prevent
    // concurrent claude runs, not to serialize bash). router.handle dispatches
    // `!` to bridge.executeBash, which tracks the run independently.
    if (msg.content.trim().startsWith('!')) {
      void router
        .handle(msg.content, {
          userId: msg.userId,
          chatId: msg.chatId,
          messageId: msg.messageId,
        })
        .catch((err: unknown) => logger.error('[control] bang command failed:', err));
      return;
    }
    // Compute workspace with same fallback logic as executeBash:
    // 1. sessionStore cwd → 2. first saved workspace
    let workspace = sessionStore.getCwd(msg.userId) ?? '';
    if (!workspace && workspaceStore) {
      const workspaces = workspaceStore.list();
      if (workspaces.length > 0) {
        workspace = workspaces[0][1];
      }
    }

    // Step4/D4: 入队时刻（T0）快照 agent+session，随任务闭包带到 T1 执行时刻，
    // 避免排队期间 /new、/config 改写 live 状态导致语义漂移（方案 D4）。唯一
    // 捕获点 Bridge.currentBinding。
    const binding = bridge.currentBinding(msg.userId);

    bridge.enqueue(
      workspace,
      async () => {
        await router.handle(
          msg.content,
          {
            userId: msg.userId,
            chatId: msg.chatId,
            messageId: msg.messageId,
          },
          // P1-14: lane 与执行 cwd 同源 —— 入队时捕获的 workspace 显式传给
          // forwardToClaude，排队期间 /cd 不再导致旧 lane 消息被 busy-drop。
          // D4/Step4: binding 同源 —— 入队时快照的 agent+session 一并透传，
          // 排队期间 /new、/config 不再导致旧 lane 消息语义漂移。
          { cwdOverride: workspace, binding },
        );
      },
      {
        taskMeta: {
          userId: msg.userId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          messagePreview: msg.content.slice(0, 3000),
          // D3/Step4: binding 随 taskMeta 存进 QueuedTask，供替换闭包
          // （queue.edit/queue.immediate）复用，不重新快照。
          binding,
        },
      },
    );
  });

  connector.setCardActionHandler(async (action) => {
    // 仅已绑定的 owner 可触发卡片操作；其余静默丢弃（计数 + debug）
    if (!binder.isOwner(action.operator.openId)) {
      binder.recordRejectedCardAction(action.operator.openId);
      return;
    }

    const actionValue = action.action.value as CardActionPayload | undefined;
    if (!actionValue?.cmd) return;

    logger.info(`card action: ${actionValue.cmd}`);

    const userId = action.operator.openId;
    const chatId = action.chatId;
    const messageId = action.messageId;

    // Add Typing reaction to indicate "still alive"
    void connector.addReaction(messageId, 'Typing');

    if (actionValue.cmd === 'stop') {
      if (!actionValue.runId) {
        logger.warn('[control] ignored stop card action without runId');
        // Card button clicks must have visible feedback (AGENTS.md 红线：卡片按钮
        // 点击必须有可见反馈，见 design.md §6.2)。
        void bridge
          .sendResult({ text: '⚠️ 无效的停止请求，缺少必要信息' }, { userId, chatId, messageId })
          .catch((err: unknown) => logger.error('[control] card stop feedback failed:', err));
        return;
      }
      void (async () => {
        const stopped = await bridge.interruptCurrentRun({
          userId,
          chatId,
          runId: actionValue.runId,
        });
        if (!stopped) {
          // runId mismatch or run already exited — mirror /stop text miss path.
          await bridge.sendResult(
            { text: '该任务已结束，无需终止' },
            { userId, chatId, messageId },
          );
        }
      })().catch((err: unknown) => logger.error('[control] card stop failed:', err));
      return;
    }

    const isImmediate = isImmediateAction(actionValue.cmd);
    const workspace = sessionStore.getCwd(userId) ?? '';

    // Build full value object — spread all fields from actionValue,
    // then override option/formValue/inputValue from action for CardKit 2.0 compatibility.
    // 2026-07-04: inputValue 来自 CardKit 2.0 input 组件自带提交图标触发 callback
    const fullValue: CardActionPayload = {
      ...actionValue,
      option: action.action.option,
      formValue: action.action.formValue,
      // CardKit 2.0 input ✓ 提交图标：输入值走 raw.action.input_value（SDK normalizer
      // 丢弃 action.action.input_value，需 connector includeRawEvent: true）。
      inputValue:
        (action.raw as { action?: { input_value?: string } } | undefined)?.action?.input_value ??
        (action.action as { input_value?: string }).input_value,
    };

    // queue.input 和 config.save 返回 CardActionResponse toast 给点击用户即时反馈。
    // 必须直接返回值 -- enqueueImmediate / enqueueConfigAction 是 fire-and-forget，
    // 会吞掉返回值。queue.input 只做一次卡片更新 + toast，快速且不需要串行队列序列化。
    // config.save 内部已有 enqueueConfigAction 串行化保证，但返回值需要直接返回给飞书。
    if (actionValue.cmd === 'queue.input' || actionValue.cmd === 'config.save') {
      return router.handleCardAction(fullValue, { userId, chatId, messageId });
    }

    // order.exec → equivalent queued message (Plan A): resolve the order text
    // at the enqueue boundary and route it through router.handle, exactly like
    // a hand-typed message. See order-exec-dispatch.ts for the contract and
    // why an internal key replaces the Feishu card messageId.
    if (actionValue.cmd === 'order.exec') {
      void dispatchOrderExecForQueue({
        router,
        bridge,
        workspace,
        orderId: actionValue.orderId,
        ctx: { userId, chatId, messageId },
      }).catch((err: unknown) => logger.error('[control] order.exec dispatch failed:', err));
      return;
    }

    if (isImmediate) {
      bridge.enqueueImmediate(workspace, async () => {
        await router.handleCardAction(fullValue, { userId, chatId, messageId });
      });
    } else {
      bridge.enqueue(
        workspace,
        async () => {
          await router.handleCardAction(fullValue, { userId, chatId, messageId });
        },
        {
          taskMeta: {
            userId,
            chatId,
            messageId,
            messagePreview: `card action: ${actionValue.cmd}`,
          },
        },
      );
    }
  });
}

async function main() {
  const cliArgs = parseCliArgs();
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
  const { config, configDir, logger, instanceLock } = await initializeCliAndConfig();

  // Restart handoff: if spawned as a /restart replacement, wait for the old
  // bridge to die (and release the instance lock) before acquiring it.
  await waitForPreviousInstance();

  setupInstanceLockAndHandlers(instanceLock, logger, configDir);

  logger.info('config loaded');
  logger.info(`configDir = ${configDir}`);
  logger.info(`feishu.appId = ${config.feishu.appId}`);
  logger.info(`claude.model = ${config.claude.model}`);
  if (cliArgs.settings) {
    logger.info(`claude.settings = ${cliArgs.settings}`);
  }

  const { agentRegistry, sessionReaderRegistry } = initializeRunner(config, configDir, cliArgs);

  const connector = new FeishuConnector(config);
  const startupContactStore = new StartupContactStore(path.join(configDir, 'startup-contact.json'));
  const binder = new OwnerBinder(startupContactStore);
  if (binder.pendingPin) {
    // 未绑定：控制台（stderr）展示 PIN。守护模式下被 watchdog 重定向到 daemon 日志
    console.error(formatPinGuidance(binder.pendingPin));
    logger.info('[binder] awaiting first binding (PIN printed to stderr)');
  } else {
    logger.info(`[binder] bound to owner openId=${binder.boundOpenId()}`);
  }

  const sessionStore = new SessionStore(
    path.join(configDir, 'last-session.json'),
    config.defaultAgent,
  );
  const workspaceStore = new WorkspaceStore(path.join(configDir, 'workspace.json'));
  const bridge = new Bridge({
    connector,
    sessionStore,
    config,
    workspaceStore,
    agentRegistry,
    sessionReaderRegistry,
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
  });

  setupMessageHandlers(
    connector,
    router,
    bridge,
    sessionStore,
    workspaceStore,
    binder,
    logger,
    config,
  );

  try {
    await connector.connect();
  } catch {
    logger.error('failed to connect to Feishu, check appId/appSecret');
    process.exit(1);
  }

  if (binder.isBound()) {
    // 仅已绑定时发送启动通知；未绑定时不打扰（PIN 引导已在控制台输出）
    await sendStartupHello(connector, startupContactStore, { dev: cliArgs.dev });
  }

  // Auto-restore: resume the persisted sessionId if available
  const restoredContact = startupContactStore.getContact();
  if (restoredContact?.userId) {
    const restoredCwd = sessionStore.getCwd(restoredContact.userId);
    if (restoredCwd) {
      const sessionIdToResume = sessionStore.getSessionId(
        restoredContact.userId,
        config.defaultAgent,
      );

      if (sessionIdToResume) {
        logger.info(
          `[startup] auto-resuming persisted session ${sessionIdToResume} in ${restoredCwd}`,
        );
        const startupReader = sessionReaderRegistry.get(config.defaultAgent);
        sessionStore.setSessionIdAndCwd(
          restoredContact.userId,
          config.defaultAgent,
          sessionIdToResume,
          restoredCwd,
        );
        const content = startupReader.readSessionContent(sessionIdToResume, restoredCwd);
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
          );
        } catch (err) {
          getLogger().warn('[startup] sendAutoResumeCard failed:', err);
        }
      }
    }
  }

  logger.info('bridge is running, press Ctrl+C to exit');
}

main().catch((err) => {
  getLogger().error('fatal error:', err);
  process.exit(1);
});
