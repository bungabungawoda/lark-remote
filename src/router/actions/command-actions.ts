// 文本命令（/help、/status、/ls、/resume …）与会话/列表卡片构建 helper。
import os from 'node:os';
import path from 'node:path';
import type { CommandContext, CommandResult } from '../../bridge/index.js';
import { getConfigDir } from '../../config/index.js';
import { stopCurrentTurn } from '../../bridge/stop-current.js';
import {
  agentDisplayName,
  cardButton,
  newSessionButton,
  resumeCompactButton,
} from '../../card/card-shared.js';
import { buildSessionHistoryCard, paginationBar } from '../../card/card-helpers.js';
import { activeRunUsage } from '../active-run-usage.js';
import { isRunTerminal } from '../../card/run-state.js';
import { displayName } from '../../platform/path.js';
import { AGENT_KINDS } from '../../agent-kinds.js';
import type { AgentKind } from '../../agent-kinds.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionReader,
} from '../../session-contract.js';
import type { SessionDisplayUsage } from '../../card/usage-format.js';
import { getLogger } from '../../logger/index.js';
import { buildLsCommand } from '../commands/ls.js';
import { buildWsCommand } from '../commands/ws.js';
import { buildOrderCommand } from '../commands/order.js';
import { buildResumeCommand, AUTO_RESUME_MAX_EVENTS } from '../commands/resume.js';
import { resolveDirectory } from '../path-validation.js';
import { pageInfo } from '../paging.js';
import type { CommandRouter } from '../index.js';
import { ACTIVE_PAGE_SIZE } from './shared.js';

export function cmdHelp(_host: CommandRouter): CommandResult {
  // 按钮组（可直接点击触发；按钮 label 只保留子命令，不含参数）
  // /ws 子命令 (save|use|remove) 移到右侧文本说明，按钮只显示 /ws
  // 按钮 label 按长度升序排列（短在上，长在下），视觉更整齐
  const buttonCommands = [
    { cmd: 'help', label: '/help /h', desc: '显示此帮助' },
    { cmd: 'ps', label: '/ps', desc: '查看是否有 agent 进程在跑' },
    { cmd: 'new', label: '/new', desc: '清空当前 session（保留 cwd）' },
    { cmd: 'stop', label: '/stop /t', desc: '终止当前 Agent 进程' },
    { cmd: 'ws', label: '/ws', desc: 'workspace 管理（save|use|remove）' },
    { cmd: 'config', label: '/config /c', desc: '查看和修改配置（卡片交互）' },
    { cmd: 'active', label: '/active', desc: '查看所有正在进行中的 session' },
    { cmd: 'exit', label: '/exit /e', desc: '退出 lark-remote' },
    { cmd: 'restart', label: '/restart', desc: '重启 lark-remote（新进程，config 不变）' },
    { cmd: 'update', label: '/update /u', desc: '检查并升级到最新版本' },
    {
      cmd: 'clone',
      label: '/clone',
      desc: '复制分身：克隆配置并扫码创建新应用',
    },
    { cmd: 'status', label: '/status /s', desc: '显示当前状态' },
  ].sort((a, b) => a.label.length - b.label.length || a.cmd.localeCompare(b.cmd));

  // 文本组（需带参数，不宜用按钮；以纯文本行展示）
  const textCommands = [
    { cmd: 'cd', label: '/cd <path>', desc: '切换工作目录' },
    {
      cmd: 'ls',
      label: '/ls [dir|file]',
      desc: '列出当前目录（可指定子目录）；指定文件时列出该文件',
    },
    {
      cmd: 'download',
      label: '/download /d <path>',
      desc: '直接下载（发送）指定文件到飞书，上限 30MB',
    },
    { cmd: 'resume', label: '/resume /r [agent] [list|id|N]', desc: '列出或切换 Agent session' },
    {
      cmd: 'order',
      label: '/order /o save|list|edit',
      desc: '收藏指令 /order save，编辑指令 /order edit <id|N> <新文本>，指令可起别名（卡片上 ＋别名）',
    },
  ];

  const bodyElements: object[] = [];

  // 按钮组 — CardKit 2.0: column_set + column + button with behaviors
  // 对齐修复（方案 A）：两列都用 width:'weighted' + 固定 weight。
  // 根因：每行独立 column_set + width:'auto' → 列宽随按钮/文本内容变化 →
  // 跨行不对齐（按钮列右边界参差）。改用 weighted 后，每行 column_set
  // 总宽相同（同级 body.elements），weight 比例一致，列宽跨行恒等。
  // 手机排版修复：weight 1:3 → 2:3。1:3 时按钮列只占 25%，
  // 手机窄屏（~330px 可用）下约 82px，容不下 `/config /c`（10 字符 ≈ 100px），
  // 按钮文字被截断成 "..."。改 2:3 后按钮列占 40% ≈ 132px，足够显示
  // 最长的 /config /c，文本列仍占 60% 足以放下描述。
  for (const c of buttonCommands) {
    bodyElements.push({
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 2,
          elements: [
            cardButton(c.label, { cmd: `help.${c.cmd}` }, { type: 'default', size: 'small' }),
          ],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 3,
          vertical_align: 'center',
          elements: [
            {
              tag: 'div',
              text: { tag: 'lark_md', content: c.desc },
            },
          ],
        },
      ],
    });
  }

  // 分隔：按钮组与文本组之间
  bodyElements.push({ tag: 'hr' });

  // 文本组 — lark_md 文本行
  for (const c of textCommands) {
    bodyElements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `\`${c.label}\` — ${c.desc}` },
    });
  }

  // 快捷命令
  bodyElements.push({ tag: 'hr' });
  bodyElements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '**快捷命令**\n`!<bash-command>` — 执行 bash 命令并流式输出到卡片',
    },
  });

  // 快捷别名（$name）
  bodyElements.push({ tag: 'hr' });
  bodyElements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        '**快捷别名**\n`$<name>` — 触发已保存指令的别名（在 /order 卡片给指令起别名后生效），' +
        '如 `$all` 等价于执行「跑全量测试」。只匹配消息开头的 `$name`，`!`/`/` 开头不展开',
    },
  });

  // Agent 说明
  bodyElements.push({ tag: 'hr' });
  bodyElements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        '**Agent**\n通过 `/config` → 默认 Agent 切换：' +
        AGENT_KINDS.map((kind) => agentDisplayName(kind)).join(' / '),
    },
  });

  // 系统休眠说明
  bodyElements.push({ tag: 'hr' });
  bodyElements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        '**系统休眠**\nlark-remote 运行期间会阻止系统自动休眠，以免远程连接不上，' +
        '不影响显示器睡眠',
    },
  });

  return {
    card: {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '📖 可用命令' } },
      body: { elements: bodyElements },
    },
  };
}

export function cmdStatus(host: CommandRouter, ctx: CommandContext): CommandResult {
  const entry = host.sessionStore.get(ctx.userId);
  const cwd = entry?.cwd ?? '(未设置)';
  const sessionId = entry?.sessions.get(host.config.defaultAgent) ?? '(无)';
  // 查 bridge.activeRuns 而不是默认 runner.isRunning —— 因为 per-workspace
  // runner 启动的 run 不会反映到默认 runner 状态。
  const running = cwd !== '(未设置)' && host.bridge.isBusyFor(cwd);

  const logger = getLogger();
  const pid = process.pid;
  const configDir = getConfigDir();
  const logFile = logger.getCurrentLogFile();

  // 构建 agent 状态信息
  const agentLines: string[] = [];
  if (cwd !== '(未设置)') {
    const runner = host.bridge.getCurrentRunner(cwd);
    const info = runner.getStatusInfo();
    // 只保留第一个 agent 和 model
    agentLines.push(`agent: \`${info.kind}\``);
    agentLines.push(`model: \`${info.model}\``);
    if (info.provider) {
      agentLines.push(`provider: \`${info.provider}\``);
    }
    if (info.reasoning) {
      agentLines.push(`reasoning: \`${info.reasoning}\``);
    }
    if (info.extras) {
      for (const [key, value] of Object.entries(info.extras)) {
        agentLines.push(`${key}: \`${value}\``);
      }
    }
  }
  // 如果上面没有成功获取 agent 信息（cwd 未设置或其他原因），从配置读取
  if (agentLines.length === 0) {
    const defaultAgent = host.config.defaultAgent;
    let model = 'N/A';
    if (defaultAgent === 'claude') {
      model = host.config.claude.model;
    } else if (host.config.agents?.[defaultAgent as keyof typeof host.config.agents]) {
      const agentConfig = host.config.agents[defaultAgent as keyof typeof host.config.agents];
      model = (agentConfig as { model?: string }).model ?? 'N/A';
    }
    agentLines.push(`agent: \`${defaultAgent}\``);
    agentLines.push(`model: \`${model}\``);
  }

  const sessionCwd = host.sessionStore.getSessionCwd(ctx.userId, host.config.defaultAgent);
  const sessionCwdLine =
    sessionCwd && sessionCwd !== cwd ? `- 会话目录: \`${sessionCwd}\`（会话实际目录）\n` : '';

  return {
    markdown: `**当前状态：**
- cwd: \`${cwd}\`
- session_id: \`${sessionId}\`
${sessionCwdLine}${agentLines.map((l) => `- ${l}`).join('\n')}
- 进程: ${running ? '运行中' : '空闲'}
- 进程号: ${pid}
- 配置目录: ${configDir}
- 日志文件: ${logFile}`,
  };
}

export function cmdPs(host: CommandRouter, ctx: CommandContext): CommandResult {
  const entry = host.sessionStore.get(ctx.userId);
  const cwd = entry?.cwd;
  if (!cwd) return { text: '请先 /cd 设置工作目录' };
  const agentName = agentDisplayName(host.config.defaultAgent);
  return {
    text: host.bridge.isBusyFor(cwd) ? `有 ${agentName} 进程在运行` : '当前无进程在跑',
  };
}

export async function cmdStop(
  host: CommandRouter,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  // 单一实现：文本 /stop 与卡片停止共用（含 DSH 宿主轮次 fallback）。
  return stopCurrentTurn(host.bridge, ctx);
}

export async function cmdExit(host: CommandRouter): Promise<CommandResult> {
  // Signal handle() to invoke exitHandler after the reply is sent.
  host.pendingExit = true;
  return { text: 'lark-remote 正在退出...' };
}

export function cmdRestart(host: CommandRouter): CommandResult {
  if (!host.restartSpawner) {
    return { text: '当前环境不支持 /restart' };
  }
  try {
    // 先 spawn detached 继任者（持锁期间完成，子进程经 env 等本进程退出后
    // 再走正常锁 acquire），成功后才借 pendingExit 走 /exit 同款干净退出
    // 链路——spawn 失败则旧进程保持存活，不会两头落空。
    const pid = host.restartSpawner();
    host.pendingExit = true;
    return { text: `♻️ lark-remote 重启中（新进程 pid ${pid}），启动通知稍后送达…` };
  } catch (err) {
    getLogger().error('[router] restart spawn failed:', err);
    return { text: `重启失败：${(err as Error).message}，旧进程仍在运行` };
  }
}

/**
 * /update: check for newer version and upgrade if available.
 * /update check: only check, don't upgrade.
 *
 * Flow: check version → if newer, install → report success (no auto-restart).
 */
export async function cmdUpdate(
  host: CommandRouter,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const checkOnly = args[0] === 'check';

  // 1. Version query（/update check 始终绕过缓存，/update 用 TTL 缓存）
  let current: string;
  let latest: string;
  try {
    const result = await host.updateFns.checkLatestVersion({
      cachePath: host.updateCachePath,
      bypassCache: checkOnly,
    });
    current = result.current;
    latest = result.latest;
  } catch (err) {
    return { text: `❌ 版本检查失败: ${(err as Error).message}` };
  }

  if (host.updateFns.compareVersions(current, latest) !== 1) {
    return { text: `✅ 已是最新版本 ${current}` };
  }

  if (checkOnly) {
    return { text: `📦 有新版本 ${latest} 可用（当前 ${current}），发送 /update 升级` };
  }

  // 2. Dev mode guard
  if (host.devMode) {
    return { text: '⚠️ 开发模式不支持自更新，请 git pull 后重新构建' };
  }

  // 3. Install (send intermediate status before the blocking operation)
  await host.bridge.sendResult({ text: `⬆️ 正在升级 ${current} → ${latest} ...` }, ctx);
  const installResult = await host.updateFns.runInstallLatest();

  if (!installResult.success) {
    return { text: `❌ 升级失败: ${installResult.error}` };
  }

  // 4. Report success (no auto-restart — user decides when to /restart)
  return { text: `✅ 升级成功 (${current} → ${latest})，发送 /restart 重启后生效` };
}

/**
 * /clone [name] — 复制分身：进入 clone 状态机（发二维码、等扫码、自动绑定）。
 * 全程由 CloneSession 自己经 connector 发消息（含二维码图片），故返回 null。
 */
export async function cmdClone(
  host: CommandRouter,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult | null> {
  if (!host.cloneSession) {
    return { text: '当前环境未启用创建分身功能' };
  }
  await host.cloneSession.start(args[0], ctx);
  return null;
}

export function cmdNew(host: CommandRouter, ctx: CommandContext): CommandResult {
  // 只清 sessionId 保留 cwd — 否则 /new 之后 /resume 会提示"请先 /cd
  // 设置工作目录"，但用户的 cwd 还在，用户 /new → /resume 后会被误导
  // 以为需要重新 /cd。
  const agentName = agentDisplayName(host.config.defaultAgent);
  host.sessionStore.clearSessionId(ctx.userId, host.config.defaultAgent, {
    clearSessionCwd: true,
  });
  return { text: `已清空 ${agentName} session，下次消息将启动新对话` };
}

export function cmdCd(host: CommandRouter, args: string[], ctx: CommandContext): CommandResult {
  // 路径可含空格：命令参数按空白切分后必须拼回整段（同 /download）。
  const target = args.join(' ').trim();
  if (!target) {
    const cwd = host.sessionStore.getCwd(ctx.userId) ?? '(未设置)';
    return { text: `当前目录: ${cwd}` };
  }

  // Resolve path (support ~, absolute, and relative paths)
  const currentCwd = host.sessionStore.getCwd(ctx.userId) ?? process.cwd();
  const expanded = target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;
  const resolved = path.resolve(currentCwd, expanded);

  const resolution = resolveDirectory(resolved);
  if (!resolution.ok) {
    if (resolution.reason === 'missing') return { text: `路径不存在: ${resolved}` };
    if (resolution.reason === 'not_directory') return { text: `不是目录: ${resolved}` };
    return { text: `路径无效: ${resolved}` };
  }

  // Switch cwd with auto-resume and user feedback (shared with /ws use and ls.switch)
  return host.switchCwdAndNotify(ctx.userId, resolution.canonical, ctx);
}

/**
 * `/ls` 实现（public：测试直接调用，替代 as unknown as）。
 *
 * @param args    [] 列出 cwd；[path] 列出指定目录（或文件）
 * @param offset  分页起点（条目数）
 * @param rootDir 浏览起点：卡片「返回」按钮回到这里。省略时默认 = 本次列出的
 *                目录（`/ls <dir>` 的起点即该目录），因此「返回」不会把用户
 *                丢回 工作目录。
 * @param q       关键词筛选：只匹配**当前层**条目名（不递归），大小写不敏感。
 *                省略/空 = 无筛选。
 */
export function cmdLs(
  host: CommandRouter,
  args: string[],
  ctx: CommandContext,
  offset = 0,
  rootDir?: string,
  q?: string,
): CommandResult {
  return buildLsCommand(args, ctx, {
    cwd: host.sessionStore.getCwd(ctx.userId),
    offset,
    rootDir,
    q,
  });
}

/**
 * `/download <path>`（别名 `/d`）：把本地文件直接发送到飞书。
 *
 * 路径解析与 `/ls` 一致：`~` 展开到 home；相对路径基于当前 cwd（无 cwd 时
 * 必须给绝对路径）。成功时文件本身即回复，返回 null（不额外发文本）。
 */
export async function cmdDownload(
  host: CommandRouter,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult | null> {
  const raw = args.join(' ').trim();
  if (raw === '') {
    return { text: '用法: /download <path>（别名 /d）' };
  }
  // 路径可能含空格：args 按空白切分后再拼回（未加引号也能还原原路径）
  let input = raw;
  if (input.startsWith('~')) {
    input = path.join(os.homedir(), input.slice(1));
  }
  if (!path.isAbsolute(input)) {
    const cwd = host.sessionStore.getCwd(ctx.userId);
    if (!cwd) return { text: '请先使用 /cd <path> 设置工作目录' };
    input = path.resolve(cwd, input);
  }
  return host.deliverFileToFeishu(path.resolve(input), ctx);
}

export function cmdWs(
  host: CommandRouter,
  args: string[],
  ctx: CommandContext,
  offset = 0,
  q?: string,
): CommandResult {
  return buildWsCommand(args, ctx, offset, q, {
    getCwd: (userId) => host.sessionStore.getCwd(userId),
    saveWorkspace: (name, cwd) => host.workspaceStore.save(name, cwd),
    getWorkspace: (name) => host.workspaceStore.get(name),
    hasWorkspace: (name) => host.workspaceStore.has(name),
    removeWorkspace: (name) => host.workspaceStore.remove(name),
    touchWorkspace: (name) => host.workspaceStore.touch(name),
    listWorkspaces: () => host.workspaceStore.list(),
    getSortMode: (userId) => host.wsSortPreference.get(userId) ?? 'recent',
    switchCwd: (userId, cwd, actionCtx) => host.switchCwdAndNotify(userId, cwd, actionCtx),
  });
}

export function cmdResume(
  host: CommandRouter,
  args: string[],
  ctx: CommandContext,
  offset = 0,
): CommandResult {
  return buildResumeCommand(args, ctx, offset, {
    defaultAgent: host.config.defaultAgent,
    getSessionEntry: (userId) => host.sessionStore.get(userId),
    setSessionId: (userId, agent, sessionId, cwd) =>
      host.sessionStore.setSessionId(userId, agent, sessionId, cwd),
    defaultReader: () => host.sessionReader,
    readerFor: (agent) => host.sessionReaderRegistry.get(agent),
    dshPresetMismatch: (reader, sessionId, cwd) => host.dshPresetMismatch(reader, sessionId, cwd),
    readDisplay: (sessionId, cwd, opts) => host.readSessionDisplayState(sessionId, cwd, opts),
    buildActions: (opts) => host.buildResumeActionButtons(opts),
    canCompact: (agent, cwd) => host.canCompactSession(agent, cwd),
  });
}

export function cmdActive(
  host: CommandRouter,
  _args: string[],
  _ctx: CommandContext,
  offset = 0,
): CommandResult {
  // List all active runs from lark-remote memory (not from file system scan)
  // (only shows runs started by THIS lark-remote process)

  const activeRuns = host.bridge.getActiveRuns();
  const activeBashRuns = host.bridge.getActiveBashRuns();

  if (activeRuns.length === 0 && activeBashRuns.length === 0) {
    return { text: '当前没有正在进行中的任务' };
  }

  // Build CardKit 2.0 card showing memory-based active runs
  return host.buildActiveCardFromMemory(activeRuns, activeBashRuns, offset);
}

export function cmdOrder(
  host: CommandRouter,
  args: string[],
  ctx: CommandContext,
  offset = 0,
): CommandResult {
  return buildOrderCommand(args, ctx, offset, {
    reload: () => host.orderStore.reload(),
    list: () => host.orderStore.get(),
    save: (text) => host.orderStore.save(text),
    updateText: (id, text) => host.orderStore.updateText(id, text),
    setAlias: (id, alias) => host.orderStore.setAlias(id, alias),
    resolveTarget: (target) => host.resolveOrderTarget(target),
  });
}

export function readSessionDisplayState(
  host: CommandRouter,
  sessionId: string,
  cwd: string,
  opts?: { agentKind?: string; maxEvents?: number },
): {
  events: AgentSessionContentEvent[];
  usage?: SessionDisplayUsage;
  isActive: boolean;
  /**
   * 会话在宿主侧仍有在途 turn（仅 DSH 的 isSessionActive 是服务端 running
   * 事实）。与 isActive（本进程 activeRun）分开：宿主 turn 没有本地 runId，
   * 不能渲染 stop，但压缩同样会被拒，必须据此隐藏 Compact。
   */
  hostRunning: boolean;
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
  /** runId of the in-process activeRun, when activeRunning is true.
   * Used to bind the stop button to the real UUID runId (not sessionId),
   * since bridge.interruptCurrentRun matches on active.runId. */
  activeRunRunId?: string;
} {
  // Use the appropriate session reader based on agentKind
  let reader = host.sessionReader;
  const agentKind = opts?.agentKind;
  if (agentKind && agentKind !== host.config.defaultAgent) {
    reader = host.sessionReaderRegistry.get(agentKind as AgentKind);
  }

  const { events, usage, aiTitle, recap, displayTitle } = reader.readSessionContent(
    sessionId,
    cwd,
    { maxEvents: opts?.maxEvents },
  );
  const activeRun = host.bridge.getActiveRunFor(cwd);
  // 只检查内存中的 activeRun 状态：存在且未收尾才算进行中。
  // 终态集合取 run-state 的单源判据（新增终态时不会漏掉这一处）。
  const activeRunning =
    activeRun !== undefined &&
    !isRunTerminal(activeRun.terminal) &&
    activeRun.sessionId === sessionId;
  const activeUsage = activeRunUsage(activeRun);
  // 只有 DSH reader 的 isSessionActive() 是服务端 running 事实；其他 reader
  // 的同名方法只是"最近有写入"的启发式，拿它当 turn 在跑会误报。
  const effectiveAgent = agentKind ?? host.config.defaultAgent;
  let hostRunning = false;
  if (effectiveAgent === 'dsh') {
    try {
      hostRunning = reader.isSessionActive(sessionId, cwd);
    } catch {
      hostRunning = false;
    }
  }
  return {
    events,
    usage: activeRunning ? (activeUsage ?? usage) : usage,
    // 只使用内存中 activeRun 的状态
    isActive: activeRunning,
    hostRunning,
    aiTitle,
    recap,
    displayTitle,
    // Return the real runId only when we have an authoritative in-process
    // activeRun for THIS session. Callers bind `runId: activeRunRunId`; the
    // stop button is only rendered when isActive is true, which guarantees
    // activeRunRunId is set, so bridge.interruptCurrentRun always matches
    // on the real UUID runId.
    activeRunRunId: activeRunning ? activeRun?.runId : undefined,
  };
}

/**
 * Shared logic for switching cwd with user feedback.
 * Used by cmdCd, cmdWs use, and handleLsSwitch to ensure consistent behavior:
 * 1. Set cwd (and clear sessionId per §9.1)
 * 2. Auto-resume newest session if available
 * 3. Return appropriate CommandResult (auto-resume card or plain text)
 */
export function switchCwdAndNotify(
  host: CommandRouter,
  userId: string,
  canonical: string,
  _ctx: CommandContext,
): CommandResult {
  host.sessionStore.setCwd(userId, canonical);
  // Auto-resume newest session if exists (读取失败不阻断切换，给可见提示)
  let newestSession: AgentSession | null;
  try {
    newestSession = host.sessionReader.getNewestSession(canonical);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `已切换到: ${canonical}\n（自动恢复失败: ${msg}）` };
  }
  if (newestSession) {
    host.sessionStore.setSessionIdAndCwd(
      userId,
      host.config.defaultAgent,
      newestSession.sessionId,
      canonical,
    );
    return host.buildAutoResumeCard(canonical, newestSession, _ctx);
  }
  return { text: `已切换到: ${canonical}` };
}

export function buildAutoResumeCard(
  host: CommandRouter,
  cwd: string,
  session: { sessionId: string; summary: string },
  _ctx: CommandContext,
): CommandResult {
  const agentKind = host.config.defaultAgent;
  return host.buildResumeLikeCard({
    cwd,
    sessionId: session.sessionId,
    agentKind,
    // 仅 auto-resume 入口带 Compact 按钮（runner 支持压缩时）；
    // config-switch 卡不带。
    compact: host.canCompactSession(agentKind, cwd)
      ? { sessionId: session.sessionId, agentKind }
      : undefined,
    titleBase: '自动恢复会话',
    idleIcon: '🔁',
    resumedLine: `已恢复最近会话: **${session.sessionId}**`,
  });
}

/**
 * Shared body of the two "resume-like" cards（cwd 切换后的 auto-resume 与
 * config.save 换 agent）：两者都是同一序列 readSessionDisplayState →
 * buildResumeActionButtons → buildSessionHistoryCard，差异仅 4 处——
 * Compact 按钮（仅 auto-resume，canCompactSession 门控）、标题文案、
 * headerText 的「已恢复…会话」行与可选尾部行、空会话占位——全部参数化，
 * 共享序列只留一份（Clean Code DRY）。
 */
export function buildResumeLikeCard(
  host: CommandRouter,
  opts: {
    cwd: string;
    sessionId: string;
    /** 卡片归属 agent：标题显示名、卡片 agentKind，也是 reader 的寻址键。 */
    agentKind: AgentKind;
    /** Compact 按钮载荷；仅 auto-resume 入口在 canCompactSession 成立时传入。 */
    compact?: { sessionId: string; agentKind: string };
    /** 标题主干，如 自动恢复会话 / 切换 Agent；进行中恒为 ⏳ …（完成中）。 */
    titleBase: string;
    /** 非进行中状态的标题图标（🔁 / 🔀）。 */
    idleIcon: string;
    /** headerText 第二行（含加粗 sessionId）。 */
    resumedLine: string;
    /** headerText 可选尾行——config-switch 的切换语义 notice 必须随卡可见。 */
    headerTail?: string;
    /** 空会话占位文案；仅 config-switch 卡覆盖。 */
    emptyPlaceholder?: string;
  },
): CommandResult {
  const agentName = agentDisplayName(opts.agentKind);
  const {
    events: content,
    usage,
    isActive,
    hostRunning,
    aiTitle,
    recap,
    displayTitle,
    activeRunRunId,
  } = host.readSessionDisplayState(opts.sessionId, opts.cwd, {
    // 默认 agent 时 readSessionDisplayState 内部仍走 host.sessionReader
    //（agentKind === defaultAgent 不触发 registry 查找），与旧的不传等价。
    agentKind: opts.agentKind,
    maxEvents: AUTO_RESUME_MAX_EVENTS,
  });

  const actions = host.buildResumeActionButtons({
    isActive,
    activeRunRunId,
    cwd: opts.cwd,
    // 宿主侧仍有 turn 在跑时压缩必然被拒（DSH commands/execute 仅空闲可执行），
    // 不能给一个注定失败的按钮。
    compact: hostRunning ? undefined : opts.compact,
    // 宿主 turn 无法用本地 runId 停止；按钮携带 sessionId，走 session/cancel。
    // isActive 时本地 stop 优先，不重复渲染。
    hostStop:
      !isActive && hostRunning
        ? { sessionId: opts.sessionId, agentKind: opts.agentKind, cwd: opts.cwd }
        : undefined,
    newSession: true,
  });

  const card = buildSessionHistoryCard(
    {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      displayTitle,
      aiTitle,
      recap,
      events: content,
      usage,
    },
    {
      agentKind: opts.agentKind,
      headerText: `📂 \`${opts.cwd}\`\n${opts.resumedLine}${opts.headerTail ? `\n${opts.headerTail}` : ''}`,
      title: `${isActive || hostRunning ? `⏳ ${opts.titleBase}（完成中）` : `${opts.idleIcon} ${opts.titleBase}`} · ${agentName}`,
      usageResult: 'success',
      stillRunning: hostRunning,
      ...(opts.emptyPlaceholder !== undefined ? { emptyPlaceholder: opts.emptyPlaceholder } : {}),
      actions,
    },
  );

  return { card };
}

/**
 * Whether a session of the given agent kind can be compacted from a resume
 * card. duck-typing — check if the runner has `runCompact`
 * (codex app-server, kimi acp), instead of hardcoding agentKind === 'codex'.
 */
export function canCompactSession(host: CommandRouter, agentKind: string, cwd?: string): boolean {
  if (!cwd) return false;
  return host.bridge.hasRunCompact(cwd, agentKind as AgentKind);
}

/**
 * Assemble the action buttons for a resume / session-history card.
 * Shared by buildAutoResumeCard, buildConfigSwitchCard, and cmdResume so the
 * button set (stop / compact / new-session) follows one contract instead of
 * drifting per call site.
 *
 * - stop: only when the session has an in-memory active run (isActive), bound
 *   to the real activeRun.runId so bridge.interruptCurrentRun can match.
 * - compact: only when a compact-capable runner applies and the session is
 *   not running (a live run would occupy the runner, so compaction would
 *   fail). The caller passes `compact` only when canCompactSession holds.
 * - new-session: when requested (always shown on resume cards).
 */
export function buildResumeActionButtons(
  host: CommandRouter,
  opts: {
    isActive: boolean;
    activeRunRunId?: string;
    cwd: string;
    compact?: { sessionId: string; agentKind: string };
    /** 宿主侧仍有 turn：绑定 sessionId/cwd/agent，走 session/cancel。 */
    hostStop?: { sessionId: string; agentKind: string; cwd: string };
    newSession?: boolean;
  },
): object[] {
  const actions: object[] = [];
  if (opts.isActive) {
    actions.push(
      cardButton(
        '⏹ 终止',
        { cmd: 'stop', runId: opts.activeRunRunId, cwd: opts.cwd },
        { type: 'danger' },
      ),
    );
  }
  if (opts.hostStop && !opts.isActive) {
    actions.push(
      cardButton(
        '⏹ 终止',
        {
          cmd: 'stop.session',
          sessionId: opts.hostStop.sessionId,
          agent: opts.hostStop.agentKind,
          cwd: opts.hostStop.cwd,
        },
        { type: 'danger' },
      ),
    );
  }
  if (opts.compact && !opts.isActive && !opts.hostStop) {
    actions.push(resumeCompactButton(opts.compact.sessionId, opts.compact.agentKind));
  }
  if (opts.newSession) {
    actions.push(
      newSessionButton() as { tag: string; text: object; type: string; behaviors: object[] },
    );
  }
  return actions;
}

/**
 * DSH /resume preset 一致性校验：返回 mismatch 详情，或 undefined（一致/不可判定）。
 *
 * session 的 preset 在创建时固定（§2.1）。通过 listSessions 拿到目标 session 的
 * agentPreset 与当前配置比对：不一致时不静默复用（返回提示），一致或查询失败
 * （无法判定）时不阻断，避免 DSH 离线导致 /resume 完全不可用。
 */
export function dshPresetMismatch(
  host: CommandRouter,
  reader: AgentSessionReader,
  sessionId: string,
  cwd: string,
): { sessionPreset: string; currentPreset: string } | undefined {
  const currentPreset = host.config.agents?.dsh?.agentPreset;
  if (!currentPreset) return undefined; // 配置跟随服务端默认，无法判定 → 放行
  let sessionPreset: string | undefined;
  try {
    const { sessions } = reader.listSessions(cwd, { limit: 100 });
    sessionPreset = sessions.find((s) => s.sessionId === sessionId)?.agentPreset;
  } catch (err) {
    getLogger().warn(
      `[router] dshPresetMismatch listSessions failed for ${sessionId}: ${(err as Error).message}`,
    );
    return undefined;
  }
  if (!sessionPreset) return undefined; // 服务端未返回 preset → 无法判定，放行
  if (sessionPreset === currentPreset) return undefined;
  return { sessionPreset, currentPreset };
}

/**
 * Build CardKit 2.0 /active card from bridge memory (not file system).
 * Shows only runs that were started by THIS bridge process.
 * Paginates with ACTIVE_PAGE_SIZE (default 20) items per page.
 */
export function buildActiveCardFromMemory(
  host: CommandRouter,
  activeRuns: Array<{
    runId: string;
    sessionId: string;
    cwd: string;
    userId: string;
    chatId: string;
    terminal: string;
  }>,
  activeBashRuns: Array<{
    runId: string;
    cwd: string;
    userId: string;
    chatId: string;
    terminal: string;
    command: string;
  }>,
  offset = 0,
): CommandResult {
  const totalCount = activeRuns.length + activeBashRuns.length;
  const pageSize = ACTIVE_PAGE_SIZE;
  // 统一 clamp 到最后一页边界（原先 clamp 到 totalCount-1，过期 offset 会
  // 泄漏成「第 1 页只显示末尾几条」的残页）
  const { totalPages, safeOffset, currentPage } = pageInfo(totalCount, offset, pageSize);

  // Slice: distribute offset across agent runs first, then bash runs
  const elements: object[] = [];

  let remaining = pageSize;
  let skipped = safeOffset;

  // Agent runs section（跨段 offset 分配：agent 段吃满 remaining 才轮到 bash 段）
  ({ remaining, skipped } = host.appendActiveCardSection(
    elements,
    activeRuns,
    '## 🤖 Agent 任务',
    (run, statusLabel) => [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**📂 ${displayName(run.cwd)}**` },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `> session: ${run.sessionId.slice(0, 12)}...  \n> 状态: ${statusLabel}`,
        },
      },
    ],
    remaining,
    skipped,
  ));

  // Bash runs section（末段：不再使用返回的记账值）
  host.appendActiveCardSection(
    elements,
    activeBashRuns,
    '## 💻 Bash 命令',
    (run, statusLabel) => [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**\`${run.command}\`**` },
      },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `> 目录: ${run.cwd}  \n> 状态: ${statusLabel}` },
      },
    ],
    remaining,
    skipped,
  );

  // Pagination bar（复用 paginationBar：safeOffset 已对齐页边界，
  // offset±pageSize 与原先 currentPage±1 的页码换算等价）
  if (totalPages > 1) {
    elements.push(
      ...paginationBar({
        cmd: 'active.page',
        offset: safeOffset,
        pageSize,
        total: totalCount,
        label: `**第 ${currentPage}/${totalPages} 页** （共 ${totalCount} 项）`,
        prevText: '◀ 上一页',
        nextText: '下一页 ▶',
      }),
    );
  }

  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔄 进行中的任务' },
      template: 'blue' as const,
    },
    body: { elements },
  };

  return { card };
}

/**
 * Render one section of the /active（/ps）card — the agent-runs and
 * bash-runs sections are the same loop (title line → per-entry rows →
 * stop button → trailing hr) and differ only in the title and the two
 * per-entry content rows, which the caller supplies via `renderRows`.
 *
 * Cross-section offset accounting (caller threads `remaining`/`skipped`
 * through the returned value): entries rendered decrement `remaining` and
 * consume the offset (`skipped` → 0, so the next section renders from its
 * own head); a section the offset/page has moved past deducts its full size
 * from `skipped` instead, so agent runs eat the offset before bash runs do.
 */
export function appendActiveCardSection<T extends { runId: string; cwd: string; terminal: string }>(
  host: CommandRouter,
  elements: object[],
  runs: T[],
  title: string,
  renderRows: (run: T, statusLabel: string) => object[],
  remaining: number,
  skipped: number,
): { remaining: number; skipped: number } {
  if (runs.length > 0 && skipped < runs.length && remaining > 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: title } });
    const start = skipped;
    const end = Math.min(start + remaining, runs.length);
    for (let i = start; i < end; i++) {
      const run = runs[i];
      const statusLabel = run.terminal === 'running' ? '运行中' : '处理中';
      elements.push(...renderRows(run, statusLabel));
      elements.push(
        cardButton(
          '⏹ 停止',
          { cmd: 'stop', runId: run.runId, cwd: run.cwd },
          { type: 'danger', size: 'small' },
        ),
      );
      elements.push({ tag: 'hr' });
    }
    return { remaining: remaining - (end - start), skipped: 0 };
  }
  return { remaining, skipped: skipped - runs.length };
}
