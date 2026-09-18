import { loadConfig, getAgentConfig, type AppConfig } from './config/index.js';
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
  CodexAppServerRunner,
  OpencodeAcpRunner,
  PiRpcRunner,
  KimiAcpRunner,
  DshRunner,
} from './runner/index.js';
import { AgentRegistry } from './runner/registry.js';
import { probeAllAgents } from './runner/probe.js';
import { warmCodexCatalogCache } from './config/codex-config.js';
import { SessionReaderRegistry, SessionStore } from './session/index.js';
import {
  ClaudeSessionReader,
  CodexSessionReader,
  OpencodeSessionReader,
  PiSessionReader,
  KimiSessionReader,
  DshSessionReader,
} from './session/index.js';
import {
  CommandRouter,
  isImmediateAction,
  DIRECT_RETURN_CMDS,
  type CardActionPayload,
} from './router/index.js';
import { dispatchOrderExecForQueue } from './router/order-exec-dispatch.js';
import { buildCardActionFullValue } from './router/card-action-payload.js';
import { Bridge } from './bridge/index.js';
import { initLogger, getLogger } from './logger/index.js';
import { StartupContactStore, sendStartupHello } from './startup-contact.js';
import { OwnerBinder, formatBindGuidance } from './binder.js';
import { CloneSession } from './clone.js';
import { InstanceAlreadyRunningError, InstanceLock } from './instance-lock.js';
import { spawnReplacementBridge, waitForPreviousInstance } from './restart.js';
import { currentPlatform } from './platform/select.js';
import { startSleepBlocker } from './platform/sleep-blocker.js';
import { checkLatestVersion, isNewer, runInstallLatest, formatUpdateHint } from './update/index.js';
import { classifyRejection } from './error-classification.js';
import { WorkspaceStore } from './workspace/index.js';
import { InboundTurnAssembler } from './inbound/turn-assembler.js';
import { stripPlaceholders } from './inbound/placeholder.js';
import type { MediaOutcome } from './inbound/turn.js';
import { buildSessionHistoryCard } from './router/card-helpers.js';
import { newSessionButton, resumeCompactButton, agentDisplayName } from './card/card-shared.js';
import path from 'node:path';
import fs from 'node:fs';
import { silentlyUnlink } from './common/fs.js';

/**
 * /stop 命令别名单源：普通消息的停止分支与 clone 活跃期拦截的排除条件
 * 共用同一判定，防止将来加别名时两处漂移。
 */
function isStopCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === '/stop' || t === '/t';
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
): Promise<void> {
  if (!contact.userId) return;

  const recipient = contact.chatId ?? contact.userId;
  if (!recipient) return;

  // Limit history events to prevent card size exceeded error (11310)
  const MAX_HISTORY_EVENTS = 5;
  const eventsToShow = state.events.slice(-MAX_HISTORY_EVENTS);
  const hiddenCount = state.events.length - MAX_HISTORY_EVENTS;

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

  // W2.10 单点化：runner factory 取最新 config 的唯一入口（P1-15 语义保持，
  // container 未接线时回退启动快照）。
  const latest = (): AppConfig =>
    (agentRegistry.getConfigContainer()?.current as AppConfig) ?? config;

  // P1-15: Claude factory reads from configContainer (not closure) so runtime
  // config changes (model, effort, stopGraceMs) take effect after
  // bridge.setConfig() + clearRunners(). Same pattern as codex/pi/kimi.
  agentRegistry.register('claude', (ws) => {
    const claudeConfig = latest().claude;
    return new ClaudeRunner({
      model: claudeConfig.model,
      effort: claudeConfig.effort,
      stopGraceMs: claudeConfig.stopGraceMs,
      settings: cliArgs.settings,
      pidDir: configDir,
      workspace: ws,
      permissionMode: claudeConfig.permissionMode,
      idleTtlMs:
        claudeConfig.idleTtlMinutes != null ? claudeConfig.idleTtlMinutes * 60_000 : undefined,
    });
  });

  // Register Codex runner (app-server only). The registry factory reads latest
  // config from container.current so runtime config changes (model, sandbox,
  // approvalPolicy, reasoningEffort, etc.) take effect after bridge.setConfig()
  // + clearRunners().
  const codexSessionReader = new CodexSessionReader({ codexHome: process.env.CODEX_HOME });
  agentRegistry.register('codex', (_ws: string) => {
    const codexConfig = getAgentConfig(latest(), 'codex');
    return new CodexAppServerRunner({
      kind: 'codex',
      model: codexConfig?.model,
      modelProvider: codexConfig?.modelProvider,
      reasoningEffort: codexConfig?.reasoningEffort,
      sessionReader: codexSessionReader,
      sandbox: codexConfig?.sandbox,
      approvalPolicy: codexConfig?.approvalPolicy,
      binary: codexConfig?.appServer?.binary,
      requestTimeoutMs: codexConfig?.appServer?.requestTimeoutMs,
      idleTtlMs: codexConfig?.appServer?.idleTtlMs,
      turnTimeoutMs:
        codexConfig?.appServer?.turnIdleTimeoutMinutes != null
          ? codexConfig.appServer.turnIdleTimeoutMinutes * 60_000
          : undefined,
    });
  });

  // Register OpencodeAcpRunner (pure ACP mode, `opencode acp` JSON-RPC over stdio)

  // Register session reader (same instance as used by runner)
  const sessionReaderRegistry = new SessionReaderRegistry();
  sessionReaderRegistry.register('claude', new ClaudeSessionReader());
  sessionReaderRegistry.register('codex', codexSessionReader);

  // Register OpencodeSessionReader (CLI version)
  // Using `opencode session list` and `opencode export` instead of HTTP API
  const opencodeSessionReader = new OpencodeSessionReader();

  agentRegistry.register('opencode', (_ws: string) => {
    const ocConfig = getAgentConfig(latest(), 'opencode');

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

    return new OpencodeAcpRunner({
      kind: 'opencode',
      model,
      sessionReader: opencodeSessionReader,
      mode: ocConfig?.mode ?? 'build',
    });
  });
  sessionReaderRegistry.register('opencode', opencodeSessionReader);

  // Register PiRpcRunner and PiSessionReader
  // 2026-07-12: 修复 config.save 后 pi provider 不生效的问题
  // 关键：factory 闭包必须能访问到最新的 config，而不是启动时的快照
  // 用可变容器存储 config 引用，registry 持有容器引用，factory 从容器读取最新值
  const configContainer = { current: config };
  agentRegistry.setConfigContainer(configContainer);
  const piSessionReader = new PiSessionReader();
  agentRegistry.register('pi', (ws: string) => {
    const piConf = getAgentConfig(latest(), 'pi');
    return new PiRpcRunner({
      provider: piConf?.provider ?? 'Volcano',
      model: piConf?.model ?? 'glm-5.2',
      thinking: piConf?.thinking ?? 'medium',
      tools: (piConf?.tools ?? 'read,bash,edit,write,grep,find,ls')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      workspace: ws,
      sessionReader: piSessionReader,
    });
  });
  sessionReaderRegistry.register('pi', piSessionReader);

  // Register KimiAcpRunner (pure ACP mode) and KimiSessionReader
  const kimiSessionReader = new KimiSessionReader();
  agentRegistry.register('kimi', (_ws: string) => {
    const kimiConf = getAgentConfig(latest(), 'kimi');

    const acpConf = kimiConf?.acp;
    return new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: kimiSessionReader,
      binary: acpConf?.binary ?? 'kimi',
      requestTimeoutMs: acpConf?.requestTimeoutMs,
      idleTtlMs: acpConf?.idleTtlMs,
      turnIdleTimeoutMs:
        acpConf?.turnIdleTimeoutMinutes != null
          ? acpConf.turnIdleTimeoutMinutes * 60_000
          : undefined,
      model: kimiConf?.model ?? 'kimi-code/k3',
      permissionMode: kimiConf?.permissionMode ?? 'manual',
    });
  });
  sessionReaderRegistry.register('kimi', kimiSessionReader);

  // Register DshRunner (HTTP-only DSH Web Host agent) and DshSessionReader.
  const dshSessionReader = new DshSessionReader({
    // hostProvider 每次调用读最新 config：/config 修改 host 后 runner 重建为
    // 新 host，reader（/resume、用量、完成卡）也跟随新 host（CC-02）。
    hostProvider: () => getAgentConfig(latest(), 'dsh')?.host,
  });
  agentRegistry.register('dsh', (_ws: string) => {
    const dshConf = getAgentConfig(latest(), 'dsh');
    return new DshRunner({
      kind: 'dsh',
      sessionReader: dshSessionReader,
      host: dshConf?.host,
      agentPreset: dshConf?.agentPreset,
      model: dshConf?.model,
      reasoningEffort: dshConf?.reasoningEffort,
    });
  });
  sessionReaderRegistry.register('dsh', dshSessionReader);

  // 2026-07-17: 注册所有 agent 的显示名，实现单点真相
  agentRegistry.registerDisplayName('claude', 'Claude');
  agentRegistry.registerDisplayName('codex', 'Codex');
  agentRegistry.registerDisplayName('opencode', 'Opencode');
  agentRegistry.registerDisplayName('pi', 'Pi');
  agentRegistry.registerDisplayName('kimi', 'Kimi');
  agentRegistry.registerDisplayName('dsh', 'DSH');

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

  // Warm the codex model catalog in the background so the first Codex /config
  // card open reads a warm cache instead of blocking the event loop for up to
  // 8s (execFileSync cold path). Fire-and-forget; failure lands in negative
  // cache and the sync card path falls back gracefully.
  warmCodexCatalogCache();

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
  cloneSession: CloneSession,
): void {
  // 入站统一装配器（2026-09-15）：图/文任意顺序 → 同一个 turn、同一个 prompt，
  // 附件路径统一注入 prompt；无文本纯附件只回执（决策 2）。
  const assembler = new InboundTurnAssembler({
    onCommit: (turn, prompt) => {
      // 入队时刻（T0）快照 workspace + agent/session 绑定，语义与旧路径一致
      // （排队期间 /cd、/config 不再导致语义漂移）。
      const messageId = turn.messageIds[turn.messageIds.length - 1] ?? '';
      const ctx = { userId: turn.userId, chatId: turn.chatId, messageId };
      let workspace = sessionStore.getCwd(turn.userId) ?? '';
      if (!workspace && workspaceStore) {
        const workspaces = workspaceStore.list();
        if (workspaces.length > 0) workspace = workspaces[0].path;
      }
      const binding = bridge.currentBinding(turn.userId);
      bridge.enqueue(
        workspace,
        async () => {
          // allowCommandPrefix: false —— prompt 已剥离占位符，绝不再做命令分发。
          await router.handle(prompt, ctx, {
            cwdOverride: workspace,
            binding,
            allowCommandPrefix: false,
          });
        },
        {
          taskMeta: {
            userId: turn.userId,
            chatId: turn.chatId,
            messageId,
            messagePreview: prompt.slice(0, 3000),
            binding,
          },
        },
      );
    },
    onReceipt: async (ctx, text) => {
      await bridge.sendResult({ text }, ctx);
    },
  });
  router.setInboundFlusher(() => assembler.flushAll('flush'));

  // 入站媒体（图片/文件/视频/语音/表情）：先认证后下载（P1 review 修复）。
  // connector 只上报"媒体到达"，这里先过 owner + enabled 闸门，通过后才
  // 下载——未认证/关闭配置时不会发生任何网络下载或内存/磁盘占用。
  // 下载是异步的：立刻把在途 promise 交给装配器（`kind: 'media'`），
  // 保证「先图后文」不会先提交一个只含文本的 turn。
  connector.setInboundMediaDetectedHandler((msg) => {
    if (!binder.isOwner(msg.userId)) {
      logger.warn(`[media] rejected inbound media from non-owner ${msg.userId}`);
      return;
    }
    // 读 router.config（活引用）：/config 保存后 setConfigValues 返回新对象，
    // 启动时捕获的 config 参数会过期（P2 review 修复）。
    if (!router.config.inboundMedia.enabled) {
      // 不静默（P3 review）：关闭时给 owner 明确反馈，避免发图后无任何反应。
      // 不下载、不落盘，只进 rejected（随 turn 回执一起发出）。
      assembler.ingest({
        kind: 'rejected',
        userId: msg.userId,
        chatId: msg.chatId,
        messageId: msg.messageId,
        replyToMessageId: msg.replyToMessageId,
        rawContentType: msg.rawContentType,
        rejectedKind: 'file',
        reason:
          '入站媒体保存已关闭（inboundMedia.enabled: false），未保存文件。' +
          '如需自动保存图片/文件，请开启后重试',
      });
      return;
    }
    const outcome = (async (): Promise<MediaOutcome> => {
      const payload = await connector.downloadInboundMedia(msg, {
        maxFileSizeMb: router.config.inboundMedia.maxFileSizeMb,
      });
      try {
        return await bridge.saveInboundMedia(payload);
      } catch (err) {
        // save() 的正常路径会清理临时文件；这里兜底 save 进入 mkdir
        // try 之前意外抛错的情况，避免 os.tmpdir 残留。
        for (const item of payload.media) {
          silentlyUnlink(item.tempPath);
        }
        throw err;
      }
    })();
    assembler.ingest({
      kind: 'media',
      userId: msg.userId,
      chatId: msg.chatId,
      messageId: msg.messageId,
      replyToMessageId: msg.replyToMessageId,
      rawContentType: msg.rawContentType,
      outcome,
    });
  });

  connector.setMessageHandler((msg) => {
    // 绑定/授权闸门：仅 owner 放行；非 owner 静默丢弃；未绑定时首条消息（任意内容）认领
    const decision = binder.classify(msg.userId, msg.content, msg.chatId);
    if (decision.kind === 'rejected') return;
    if (decision.kind === 'bind_success') {
      // First-run onboarding: set default cwd + send welcome + Help card.
      // setCwd is synchronous (outside the async closure) so that the user's
      // next message — which will hit the `owner` branch now that
      // startup-contact.json has been written — finds cwd already set.
      // process.cwd() is the only sensible default: the user started
      // lark-remote in the directory they want to work in.
      // setCwd only when no cwd is set yet (e.g. fresh start after bind).
      // Don't overwrite an existing cwd — the user may have already set one
      // via /cd or a previous bind. Use realpath for canonical form (matching
      // Claude JSONL cwd, e.g. /tmp → /private/tmp on macOS).
      let resolvedCwd: string;
      try {
        resolvedCwd = fs.realpathSync(process.cwd());
      } catch {
        resolvedCwd = process.cwd();
      }
      if (!sessionStore.getCwd(msg.userId)) {
        sessionStore.setCwd(msg.userId, resolvedCwd);
      }

      void (async () => {
        try {
          // Message 1: bind confirmation + status (combined to avoid
          // Feishu out-of-order delivery across three separate messages).
          await connector.sendWithRetry(msg.chatId, {
            text:
              `✅ 已绑定到本账号，此后仅你可使用本应用\n` +
              `📂 当前工作目录: \`${resolvedCwd}\`\n` +
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
    logger.info(`message from ${msg.userId} (${msg.rawContentType}): ${msg.content.slice(0, 100)}`);

    // Add Typing reaction to indicate "still alive"
    void connector.addReaction(msg.messageId, 'Typing');

    // 复制分身流程活跃期：一切消息先经 clone 状态机（stop 命令除外，保留其
    // 绕队列停止能力），不转发 coding agent、不进命令分发、不展开别名。
    if (cloneSession.isActive() && !isStopCommand(msg.content)) {
      void cloneSession
        .handleMessage(msg.content, {
          userId: msg.userId,
          chatId: msg.chatId,
          messageId: msg.messageId,
        })
        .catch((err: unknown) => logger.error('[clone] message handling failed:', err));
      return;
    }

    // 别名展开：命令分发前对消息做一次 $name 展开（不递归）。
    // `!` / `/` 开头的消息不会进入展开路径（$PATH、$HOME 等 shell 变量不受影响），
    // 未知 $xxx 原样透传；展开结果若以 `/` 开头会自然落入命令路径。
    const content = router.expandAliasMessage(msg.content);

    if (isStopCommand(content)) {
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
    // 先清洗，后判语义（§5.6）：结构占位符永远不能触发命令分发。
    // `![image](img_v3_…)` 的首字符恰好是 `!` —— 2026-09-15 事故就是这么进 shell 的。
    const stripped = stripPlaceholders(content);
    if (stripped.unknownTags.length > 0) {
      logger.warn(
        `[inbound] unknown placeholder tags stripped: ${stripped.unknownTags.join(', ')} ` +
          `(msg_type=${msg.rawContentType})`,
      );
    }
    const commandEligible =
      msg.rawContentType === 'text' && stripped.kinds.length === 0 && stripped.clean !== '';

    // 命令消息旁路装配窗口：其它 /命令 立即执行，窗口内已装配的内容
    // 作为独立提交冲刷（/stop 已在上面处理，立即生效不等待）。
    if (commandEligible && (stripped.clean.startsWith('/') || stripped.clean.startsWith('!'))) {
      void assembler.flush(msg.userId, msg.chatId, 'flush');
      void router
        .handle(
          stripped.clean,
          {
            userId: msg.userId,
            chatId: msg.chatId,
            messageId: msg.messageId,
          },
          { allowCommandPrefix: true },
        )
        .catch((err: unknown) => logger.error('[control] command failed:', err));
      return;
    }

    // 普通消息：进装配器，等静默期窗口到期（下载落定）后合并成一个 turn。
    assembler.ingest({
      kind: 'text',
      userId: msg.userId,
      chatId: msg.chatId,
      messageId: msg.messageId,
      replyToMessageId: msg.replyToMessageId,
      rawContentType: msg.rawContentType,
      text: stripped.clean,
      placeholders: stripped.kinds,
      unknownTags: stripped.unknownTags,
    });
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
        // Card button clicks must have visible feedback (design constraint: card button
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

    // Build full value object — spread all fields from actionValue, then merge
    // component out-of-band fields (option/formValue/inputValue/options) where
    // present. See card-action-payload.ts for the component-type contract.
    const fullValue = buildCardActionFullValue(actionValue, action);

    // queue.input / config.save / approval.respond / approval.toggle /
    // approval.answer 系列返回 CardActionResponse toast 给点击用户即时反馈。
    // 必须直接返回值 -- enqueueImmediate / enqueueConfigAction 是
    // fire-and-forget，会吞掉返回值（2026-08-17 review：answer 家族曾漏在
    // 直返列表外，过期/重复 nonce/非法选项等错误 toast 被静默吞掉）。
    // 审批响应尤其不能落串行队列：run 任务占用队列头直到 turn 结束，审批响应
    // 排在后面会形成死锁（run 不结束不执行、run 结束 coordinator 已删响应空转）。
    // order.aliasInput / order.aliasRemove / order.textInput 也返回 toast+card，
    // 需直返避免被吞（order.textInput 曾漏在列表外，编辑卡停留在编辑界面）。
    // approval.planFeedback 同 answer 系列：附意见的 toast 需直返 + 不落串行队列。
    // W2.1：直返名单以 router 的 DIRECT_RETURN_CMDS 为单一来源（历史注释：
    // order.textInput 曾漏在列表外、answer 家族曾漏在直返列表外——两份拷贝漂移）。
    if (DIRECT_RETURN_CMDS.has(actionValue.cmd)) {
      return router.handleCardAction(fullValue, { userId, chatId, messageId });
    }

    // order.exec → equivalent queued message (Plan A): resolve the order text
    // at the enqueue boundary and route it through router.handle, exactly like
    // a hand-typed message. See order-exec-dispatch.ts for the contract and
    // why an internal key replaces the Feishu card messageId.
    // （order.aliasEdit 是控制动作，走 enqueueImmediate 弹卡即可，不需直返。）
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
            // Compact 是单向操作，排队卡不允许编辑（编辑预览无意义）。
            editable: actionValue.cmd !== 'codex.compact' && actionValue.cmd !== 'resume.compact',
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
  // --update: upgrade to latest version and exit (for cron/script automation)
  if (cliArgs.update) {
    // --update 在 acquireLock 之前执行；先解析 configDir 并初始化 logger，
    // 让版本检查的日志落到正确目录（默认 ~/.lark-remote 或 --config-dir 指定）。
    const updateConfigDir = resolveConfigDir(cliArgs.configDir);
    initLogger({ dir: path.join(updateConfigDir, 'logs') });
    try {
      const { current, latest } = await checkLatestVersion();
      if (!isNewer(current, latest)) {
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
  const { config, configDir, logger, instanceLock } = await initializeCliAndConfig();

  // Restart handoff: if spawned as a /restart replacement, wait for the old
  // lark-remote to die (and release the instance lock) before acquiring it.
  await waitForPreviousInstance();

  setupInstanceLockAndHandlers(instanceLock, logger, configDir);

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

  const { agentRegistry, sessionReaderRegistry } = initializeRunner(config, configDir, cliArgs);

  const connector = new FeishuConnector(config);
  const startupContactStore = new StartupContactStore(path.join(configDir, 'startup-contact.json'));
  const binder = new OwnerBinder(startupContactStore);
  if (!binder.isBound()) {
    // 未绑定：控制台（stderr）引导任意消息绑定。守护模式下被 watchdog 重定向到日志
    console.error(formatBindGuidance());
    logger.info('[binder] awaiting first binding (any first private message binds)');
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

  setupMessageHandlers(
    connector,
    router,
    bridge,
    sessionStore,
    workspaceStore,
    binder,
    logger,
    config,
    cloneSession,
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

    // 启动时静默检查版本（由 checkUpdateOnStartup 控制，默认关闭）
    if (config.checkUpdateOnStartup) {
      void (async () => {
        try {
          const cachePath = path.join(configDir, 'update-cache.json');
          const { current, latest } = await checkLatestVersion({ cachePath });
          const hint = formatUpdateHint(current, latest);
          if (hint) {
            const contact = startupContactStore.getContact();
            const recipient = contact?.chatId ?? contact?.userId;
            if (recipient) {
              await connector.sendWithRetry(recipient, { text: hint });
            }
          }
        } catch (err) {
          // Non-fatal: startup check failure must not crash the bridge
          logger.warn(`[startup] update check failed: ${(err as Error).message}`);
        }
      })();
    }
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
            // Compact 能力探测与 bridge 侧一致（runner 有 runCompact 才渲染）。
            bridge.hasRunCompact(restoredCwd, config.defaultAgent),
          );
        } catch (err) {
          getLogger().warn('[startup] sendAutoResumeCard failed:', err);
        }
      }
    }
  }

  logger.info('lark-remote is running, press Ctrl+C to exit');
}

main().catch((err) => {
  getLogger().error('fatal error:', err);
  process.exit(1);
});
