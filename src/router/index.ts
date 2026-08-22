import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { SessionStore, SessionReaderRegistry } from '../session/index.js';
import type { AppConfig } from '../config/index.js';
import type { Bridge } from '../bridge/index.js';
import type { AgentBinding } from '../bridge/queue-manager.js';
import {
  getConfigDir,
  getConfigValue,
  setConfigValue,
  setConfigValues,
  mapAgentKey,
  assertSafeKeyPart,
  walkNestedContainer,
  getAgentConfig,
} from '../config/index.js';
import { syncAgentChoices } from '../runner/index.js';
import { WorkspaceStore } from '../workspace/index.js';
import { OrderStore, type OrderEntry } from '../order/index.js';
import { resolveAlias } from '../order/alias-resolve.js';
import type {
  AgentKind,
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionReader,
} from '../runner/index.js';
import { getLogger } from '../logger/index.js';
import { type SessionDisplayUsage, activeRunUsage, clampInt } from './utils.js';
import { markdownDiv, buildSessionHistoryCard, paginationBar } from './card-helpers.js';
import { MAX_FILE_UPLOAD_SIZE } from '../connector/file-limits.js';
import { atomicWrite } from '../persistence/atomic-write.js';
import {
  checkLatestVersion as defaultCheckLatestVersion,
  isNewer as defaultIsNewer,
  runInstallLatest as defaultRunInstallLatest,
  type VersionCheckResult,
  type InstallResult,
} from '../update/index.js';

/** Config card builder - delegates to per-agent builders */
import { getConfigBuilder, listRegisteredAgents, sortAgentsForDisplay } from './config/index.js';
import { probeAllAgents, getCachedAvailability } from '../runner/probe.js';
import { buildConfigCardFromTabs } from './config/common/render.js';
import type { ConfigTab } from './config/common/render.js';

/** Max events to read for auto-resume and /resume cards.
 * Limits events at the read stage so enforceCardBudget rarely needs to truncate.
 * Chosen to be under the 28KB card budget for typical events (~2KB each). */
const AUTO_RESUME_MAX_EVENTS = 5;
/** /resume 列表页大小；`/resume [N]` 的 N clamp 到 [1, RESUME_PAGE_SIZE]。 */
const RESUME_PAGE_SIZE = 5;
/** /active 卡片每页显示的最大条目数（agent run + bash run 合计）。 */
const ACTIVE_PAGE_SIZE = 20;
/**
 * /order 列表页大小；指令超过此数量时显示分页导航栏。
 * 2026-08-13 实测：每行 2 个元素（div + column_set，行间 hr），20 行 + 分页栏
 * = 61 个 body 元素，触发飞书 ErrCode 11310 "element exceeds the limit"
 * （21+ 条指令时第 1 页必炸）。改为 15 行：3*15 - 1 + 2 = 46 个元素，留足余量。
 * 2026-08-19 别名并卡后每行变 3 个元素（文本 div + 操作 column_set + hr），
 * 从 15 降为 8：3*8 - 1 + 2 = 25 个元素，仍在余量内，同时保证手机窄屏
 * 每条指令的操作控件（执行/别名/删除）不被挤压。
 */
const ORDER_PAGE_SIZE = 8;
/**
 * /ws 列表页大小。从 15 降为 5：头部 2 + 5 行 × 3（div + column_set + hr）+
 * 底栏排序 1 + 分页栏 2 ≈ 20 个 body 元素，远低于单卡 60 元素上限（ErrCode 11310），
 * 留足余量。
 */
const WS_PAGE_SIZE = 5;

/**
 * 归一化卡片分页参数：clamp pageSize 到 [1,maxPageSize]，offset 归整为
 * 非负整数并对齐到页边界。非数字 payload（如 'abc'）不得产生 NaN slice。
 *
 * resume.page / active.page 共用，避免两处重复实现分页归一化。
 */
function normalizePageArgs(
  value: { pageSize?: unknown; offset?: unknown },
  maxPageSize: number,
): { pageSize: number; alignedOffset: number } {
  const rawPageSize = Number(value.pageSize);
  const pageSize = Number.isFinite(rawPageSize)
    ? clampInt(Math.trunc(rawPageSize), 1, maxPageSize)
    : maxPageSize;
  const rawOffset = Number(value.offset);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  return { pageSize, alignedOffset: Math.floor(offset / pageSize) * pageSize };
}

/** /resume 列表页内全量预取（readSessionContent）的行数上限；其余行用轻量 summary 兜底。 */
const RESUME_CONTENT_PREFETCH = 5;
/**
 * Reader summary 占位符（trim 后匹配）。各 reader 在"无 user 消息"时返回的
 * 兜底文案不同（claude/pi `(无摘要)`、codex `(no user message)`、kimi
 * `New Session`、空串），都不是真实输入，不得渲染成行标题。
 */
const RESUME_SUMMARY_PLACEHOLDERS = new Set(['', '(no user message)', '(无摘要)', 'New Session']);
import { newSessionButton, resumeCompactButton, agentDisplayName } from '../card/card-shared.js';

interface CommandContext {
  userId: string;
  chatId: string;
  messageId: string;
}

interface CommandResult {
  text?: string;
  markdown?: string;
  card?: object;
}

/**
 * Card-action commands that must run with enqueue({ immediate: true }).
 * These bypass the serial queue and execute immediately.
 *
 * ws.use   — /ws list card "使用 <name>"
 * ws.page  — /ws list card "上一页/下一页"
 * queue.immediate — queue card "立即执行" button (§9.6)
 * queue.cancel    — queue card "撤销" button
 * queue.diagnose  — queue card "诊断" button
 *
 * §9.19: Extended to cover all control-only actions that never spawn Claude:
 * new-session — clear sessionId only
 * stop        — interrupt current run
 * ls.file     — send file only
 * ws.page     — paginate /ws list only
 * ws.remove   — delete workspace alias only
 * resume.use  — set sessionId + agent for correct reader routing
 * help.*      — read-only help commands
 * order.delete — delete order only
 * order.exec is intercepted by index.ts at the enqueue boundary
 * (resolveOrderExecForQueue → router.handle), never reaching this dispatcher.
 */
export function isImmediateAction(cmd: string): boolean {
  // help.* wildcard: any command starting with "help."
  if (cmd.startsWith('help.')) return true;
  return (
    cmd === 'new-session' ||
    cmd === 'stop' ||
    cmd === 'ls.file' ||
    cmd === 'ls.refresh' ||
    cmd === 'ls.browse' ||
    cmd === 'ls.switch' ||
    cmd === 'ls.page' ||
    cmd === 'resume.page' || // control operation: paginate only, never spawns claude
    cmd === 'active.page' || // control operation: paginate active card
    cmd === 'ws.page' || // control operation: paginate /ws list only
    cmd === 'ws.remove' ||
    cmd === 'ws.sort' || // control operation: toggle sort mode only
    cmd === 'resume.use' ||
    cmd === 'ws.use' ||
    cmd === 'queue.immediate' ||
    cmd === 'queue.cancel' ||
    cmd === 'queue.diagnose' ||
    cmd === 'queue.edit' ||
    cmd === 'queue.input' ||
    cmd === 'order.delete' ||
    cmd === 'order.page' ||
    cmd === 'order.aliasEdit' ||
    cmd === 'order.aliasInput' ||
    cmd === 'order.aliasRemove' ||
    cmd === 'order.textEdit' ||
    cmd === 'order.textInput' ||
    cmd === 'config.toggle' ||
    cmd === 'config.set' ||
    cmd === 'config.input' ||
    cmd === 'config.save' ||
    // 审批响应/权限切换必须即时触达在途 run（同 stop 类控制动作）。若走串行
    // 队列会排在等待审批的 run 之后形成死锁：run 不结束审批不执行，run 结束
    // coordinator 已删响应空转（线上复现：approval.respond 排队卡、审批永不生效）。
    cmd === 'approval.respond' ||
    cmd === 'approval.toggle' ||
    cmd === 'approval.answer' ||
    cmd === 'approval.answerSubmit' ||
    cmd === 'approval.answerCustom' ||
    cmd === 'approval.answerNote' ||
    cmd === 'approval.planFeedback'
  );
}

/** Payload carried by a card button click. */
export interface CardActionPayload {
  cmd: string;
  path?: string;
  name?: string;
  runId?: string;
  sessionId?: string;
  cwd?: string;
  workspace?: string;
  messageId?: string;
  userId?: string;
  chatId?: string;
  key?: string;
  /** /ls 与 /resume 列表分页起点（条目数）。 */
  offset?: number;
  /** /resume 列表的 agent 类型。 */
  agent?: string;
  /** /resume 列表页大小覆盖。 */
  pageSize?: number;
  option?: string;
  formValue?: Record<string, unknown>;
  /** CardKit 2.0 input 组件自带提交图标触发回调时回传的输入值 */
  inputValue?: string;
  orderId?: string;
  /** Approval request ID for approval card actions. */
  requestId?: number | string;
  /** Decision for approval.respond (e.g. 'accept', 'decline', 'cancel'). */
  decision?: string;
  /** Unique nonce to prevent duplicate processing. */
  nonce?: string;
  /** Permission item ID for approval.toggle. */
  permId?: string;
  /** Desired selection state for approval.toggle (card renders !current). */
  selected?: boolean;
  /** Claude AskUserQuestion 问题索引（approval.answer / approval.answerSubmit）。 */
  questionIndex?: number;
  /** 多选组件（multi_select_static 等）回传的选中值数组（预留公共层能力）。 */
  options?: string[];
}

/**
 * Response a cardAction handler may return to give the clicking user native
 * immediate feedback (mirrors the SDK's CardActionResponse, passed through by
 * the connector). Currently only `toast` is used. Returning void/undefined
 * means "no immediate response" (original behavior). The index signature
 * keeps it assignable to the SDK's loose `Record<string, unknown>`.
 */
interface CardActionResponse {
  toast?: {
    type: 'success' | 'info' | 'error' | 'warning' | 'loading';
    content: string;
  };
  [key: string]: unknown;
}

/** propagateConfigSave 返回的结构化切换结果 */
interface ConfigSwitchResult {
  /** 切换通知文案（未切换 agent 时为 undefined） */
  notice: string | undefined;
  /** 切换后的新 agent（仅 agent 切换时有值） */
  newAgent?: AgentKind;
  /** 切换后恢复/使用的 sessionId（空串 = 已清空，undefined = 未切换 agent） */
  sessionId?: string;
}

export class CommandRouter {
  /** Valid agent kinds — single source of truth for resume.use / resume.page / cmdResume. */
  static readonly VALID_AGENTS = ['claude', 'codex', 'opencode', 'pi', 'kimi', 'dsh'] as const;
  private sessionStore: SessionStore;
  /** 飞书桥接实例（public：测试直接访问断言，替代 as unknown as）。 */
  bridge: Bridge;
  /** 当前配置（public：测试直接读取断言，替代 as unknown as）。 */
  config: AppConfig;
  /** 配置文件的绝对路径（public：/config 保存链路与测试共用）。 */
  configPath: string;
  private workspaceStore: WorkspaceStore;
  private orderStore: OrderStore;
  private exitHandler: () => void;
  private pendingExit = false;
  /**
   * Spawns the detached replacement bridge process (same argv/config dir) and
   * returns its pid. Injected from index.ts; /restart is unavailable without it.
   */
  private restartSpawner?: () => number;
  private idleTimeoutMs: number;
  /** Dev mode flag: --dev means the bridge was started from source (bun src/index.ts). */
  private devMode: boolean;
  /** Cache file for version checks (<configDir>/update-cache.json). */
  private updateCachePath?: string;
  /** Injected update functions (for testability; defaults to real implementation). */
  private updateFns: {
    checkLatestVersion: (opts?: {
      cachePath?: string;
      bypassCache?: boolean;
    }) => Promise<VersionCheckResult>;
    isNewer: (current: string, latest: string) => boolean | null;
    runInstallLatest: () => Promise<InstallResult>;
  };
  /** /config 卡片编辑暂存区（public：测试直接读取断言，替代 as unknown as）。 */
  pendingConfig: AppConfig | null = null;
  /**
   * Monotonic counter minting unique internal keys for order.exec enqueue
   * actions. One order card can be clicked many times, so the Feishu card
   * messageId is 1:N with enqueue actions and must not be reused as the queue
   * dedup key. Date.now() alone is unsafe (two synchronous calls can share a
   * millisecond); the counter guarantees uniqueness regardless of timing.
   */
  private orderExecKeyCounter = 0;
  /**
   * Per-user sort preference for /ws list (memory-only, not persisted).
   * Default 'recent' (most recently used first), can toggle to 'alpha'.
   */
  private wsSortPreference = new Map<string, 'recent' | 'alpha'>();
  /**
   * Session reader registry for multi-agent path. Resolves the right
   * reader by `config.defaultAgent` (and per-agent override params).
   * NOTE: `/config` card's `defaultAgent` selector does NOT use this —
   * it uses `listRegisteredAgents()` from `router/config/index.ts` (the
   * config-builder registry), which mirrors the agents with a config card.
   */
  /** Session reader 注册中心（public：测试注入/读取，替代 as unknown as）。 */
  sessionReaderRegistry: SessionReaderRegistry;
  /**
   * 串行化 config.* 卡片回调（2026-07-04）。
   * CardKit 2.0 input/button 回调经 `enqueueImmediate` 分发，**不进串行队列**，
   * 多次快速点击 toggle/input 会并发读写 `pendingConfig` 并同时调
   * `updateCardInPlace` → Feishu API 乱序到达，导致 toggle 卡死在某个状态。
   * 此 Promise chain 把所有 config.* 动作串成一个执行链，保证后到的动作
   * 等前一个动作的卡片 patch 完成后再读 `pendingConfig`。
   */
  private configActionQueue: Promise<void> = Promise.resolve();

  constructor(opts: {
    sessionStore: SessionStore;
    bridge: Bridge;
    config: AppConfig;
    configPath: string;
    workspacePath?: string;
    ordersPath?: string;
    exitHandler?: () => void;
    /** Spawn the detached replacement bridge process and return its pid (throws on failure). */
    restartSpawner?: () => number;
    idleTimeoutMs?: number;
    /** Session reader registry (required). */
    sessionReaderRegistry: SessionReaderRegistry;
    /** Dev mode: bridge was started from source (--dev flag). */
    devMode?: boolean;
    /** Version check cache path (<configDir>/update-cache.json). */
    updateCachePath?: string;
    /** Override update functions for testability. */
    updateFns?: {
      checkLatestVersion?: (opts?: {
        cachePath?: string;
        bypassCache?: boolean;
      }) => Promise<VersionCheckResult>;
      isNewer?: (current: string, latest: string) => boolean | null;
      runInstallLatest?: () => Promise<InstallResult>;
    };
  }) {
    this.sessionStore = opts.sessionStore;
    this.bridge = opts.bridge;
    this.config = opts.config;
    this.configPath = opts.configPath;
    this.workspaceStore = new WorkspaceStore(opts.workspacePath);
    this.orderStore = new OrderStore(opts.ordersPath);
    this.exitHandler = opts.exitHandler ?? (() => process.exit(0));
    this.restartSpawner = opts.restartSpawner;
    // idle watchdog 窗口从 config.idle.watchdogMinutes 读取
    // opts.idleTimeoutMs 仅供测试覆盖。
    this.idleTimeoutMs = opts.idleTimeoutMs ?? opts.config.idle.watchdogMinutes * 60_000;
    if (this.bridge) {
      this.bridge.setIdleTimeout(this.idleTimeoutMs);
    }
    this.sessionReaderRegistry = opts.sessionReaderRegistry;
    this.devMode = opts.devMode ?? false;
    this.updateCachePath = opts.updateCachePath;
    this.updateFns = {
      checkLatestVersion: opts.updateFns?.checkLatestVersion ?? defaultCheckLatestVersion,
      isNewer: opts.updateFns?.isNewer ?? defaultIsNewer,
      runInstallLatest: opts.updateFns?.runInstallLatest ?? defaultRunInstallLatest,
    };
  }

  /**
   * Resolve the active session reader for the current defaultAgent.
   * The reader is fetched from the registry each time to reflect config changes.
   */
  private get sessionReader(): AgentSessionReader {
    return this.sessionReaderRegistry.get(this.config.defaultAgent);
  }

  /**
   * Route a message: if it starts with /, handle as command; if it starts with !, execute as bash; otherwise forward to Claude.
   */
  async handle(
    message: string,
    ctx: CommandContext,
    opts?: { cwdOverride?: string; binding?: AgentBinding },
  ): Promise<CommandResult | null> {
    const trimmed = message.trim();
    const startsWithBang = trimmed.startsWith('!');
    const startsWithSlash = trimmed.startsWith('/');
    getLogger().info(
      `[router] handle message="${message.slice(0, 50)}..." trimmed="${trimmed.slice(0, 50)}..." startsWithSlash=${startsWithSlash} startsWithBang=${startsWithBang}`,
    );

    if (startsWithSlash) {
      const result = await this.executeCommand(trimmed, ctx);
      if (result) {
        await this.bridge.sendResult(result, ctx);
      }
      if (this.pendingExit) {
        // 干净退出前冲刷待合批的媒体保存提示，避免 500ms 窗口内的提示丢失。
        await this.bridge.flushAllMediaNotifications();
        this.exitHandler();
      }
      return result;
    }

    // Handle bang commands (!command)
    if (trimmed.startsWith('!')) {
      const cmd = trimmed.slice(1).trim();
      if (!cmd) {
        await this.bridge.sendResult({ text: '请输入要执行的命令，例如 !ls' }, ctx);
        return null;
      }
      await this.bridge.executeBash(cmd, ctx);
      return null;
    }

    // Forward to Claude (P1-14: pass the enqueue-time workspace through so the
    // run uses the same cwd as the serial queue lane, even if /cd ran while
    // the message was queued)
    await this.bridge.forwardToClaude(trimmed, ctx, opts);
    return null;
  }

  /**
   * 一次别名展开：bridge 收到用户消息后、命令分发前调用。
   * 仅 `$name` 开头的消息可能被展开；未知别名 / 非 `$` 消息原样返回。
   * 别名来自 order 的 `alias` 字段（1 条指令 = 1 个别名），展开文本即指令文本。
   */
  expandAliasMessage(message: string): string {
    const entries = this.orderStore
      .get()
      .filter((o): o is OrderEntry & { alias: string } => typeof o.alias === 'string')
      .map((o) => ({ name: o.alias, text: o.text }));
    return resolveAlias(message, entries) ?? message;
  }

  /**
   * Handle a CardKit card button click (§6.2).
   * Validates payload and dispatches to the corresponding command.
   */
  async handleCardAction(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    switch (value.cmd) {
      case 'ls.file':
        await this.cardLsFile(value.path, ctx);
        return;
      case 'ls.refresh':
        await this.handleLsRefresh(value, ctx);
        return;
      case 'ls.browse':
        await this.handleLsBrowse(value, ctx);
        return;
      case 'ls.switch':
        await this.handleLsSwitch(value, ctx);
        return;
      case 'ls.page':
        return this.handleLsPage(value, ctx);
      case 'ws.page':
        return this.handleWsPage(value, ctx);
      case 'ws.use':
        return await this.handleWsUse(value, ctx);
      case 'ws.sort':
        return await this.handleWsSort(value, ctx);
      case 'ws.remove':
        return await this.handleWsRemove(value, ctx);
      case 'resume.use': {
        // resume.use carries an agent field from /resume [agent] list cards
        // (both active and completed cards include the agent field).
        const resumeAgent = value.agent ?? this.config.defaultAgent;
        const validAgents = CommandRouter.VALID_AGENTS;
        const resolvedAgent = validAgents.includes(resumeAgent as (typeof validAgents)[number])
          ? (resumeAgent as (typeof validAgents)[number])
          : this.config.defaultAgent;

        const entry = this.sessionStore.get(ctx.userId);
        const cwd = entry?.cwd;
        if (!cwd) {
          await this.bridge.sendResult({ text: '请先 /cd 设置工作目录' }, ctx);
          return;
        }

        // P1-5：校验前不得写入 sessionId。旧实现先无条件 setSessionId 再调
        // cmdResume 校验，过期卡片（session 不在当前 cwd）校验失败时 store 已被
        // 污染；value.sessionId 缺失时还会静默清空已有绑定。现在统一走 cmdResume
        // 的已验证路径（:2352 校验通过才写入），sessionId 缺失直接报错。
        if (!value.sessionId) {
          await this.bridge.sendResult(
            { text: '缺少 sessionId，请重新从 /resume 列表选择会话' },
            ctx,
          );
          return;
        }
        await this.bridge.sendResult(this.cmdResume([resolvedAgent, value.sessionId], ctx), ctx);
        return;
      }
      case 'resume.page':
        return this.handleResumePage(value, ctx);
      case 'active.page':
        return this.handleActivePage(value, ctx);
      case 'new-session':
        this.sessionStore.clearSessionId(ctx.userId, this.config.defaultAgent, {
          clearSessionCwd: true,
        });
        {
          const cwd = this.sessionStore.getCwd(ctx.userId) ?? '(未设置)';
          const agentName = agentDisplayName(this.config.defaultAgent);
          await this.bridge.sendResult(
            { text: `已创建新 ${agentName} 会话，下一条消息将开始全新对话\n📁 ${cwd}` },
            ctx,
          );
        }
        return;
      case 'stop':
        await this.handleCardStop(value, ctx);
        return;
      case 'queue.cancel':
        // 撤销：从队列中删除这个消息
        await this.handleQueueCancel(value, ctx);
        return;
      case 'queue.immediate':
        // 立即执行：停止当前进程，删除队列中这个消息之前的全部消息，立即执行这一条
        await this.handleQueueImmediate(value, ctx);
        return;
      case 'queue.diagnose':
        // 诊断：切换到项目目录，启动 Claude -p 定位问题
        await this.handleQueueDiagnose(value, ctx);
        return;
      case 'queue.edit':
        // 编辑：显示输入框让用户修改消息内容
        await this.handleQueueEdit(value, ctx);
        return;
      case 'queue.input':
        // 输入：提交新消息内容。返回 toast（SDK 作为飞书回调响应给点击用户即时反馈）。
        return await this.handleQueueInput(value, ctx);
      case 'order.delete':
        return await this.handleOrderDelete(value, ctx);
      case 'order.page':
        return await this.handleOrderPage(value, ctx);
      case 'order.aliasEdit':
        return await this.handleOrderAliasEdit(value, ctx);
      case 'order.aliasInput':
        return await this.handleOrderAliasInput(value, ctx);
      case 'order.aliasRemove':
        return await this.handleOrderAliasRemove(value, ctx);
      case 'order.textEdit':
        return await this.handleOrderTextEdit(value, ctx);
      case 'order.textInput':
        return await this.handleOrderTextInput(value, ctx);
      case 'config.toggle':
      case 'config.set':
      case 'config.input':
      case 'config.save':
        // 2026-07-04: 串行化所有 config.* 动作。CardKit 2.0 回调经 enqueueImmediate
        // 不进串行队列，多次快速点击 toggle/input 会并发读写 pendingConfig 并同时
        // 调 updateCardInPlace → Feishu API 乱序到达导致 toggle 卡死。
        // 2026-07-18: 返回 enqueueConfigAction 的结果以支持 toast 响应
        return this.enqueueConfigAction(value, ctx);
      case 'approval.respond':
      case 'approval.toggle':
      case 'approval.answer':
      case 'approval.answerSubmit':
      case 'approval.answerCustom':
      case 'approval.answerNote':
      case 'approval.planFeedback':
        return this.handleApprovalAction(value, ctx);
      case 'codex.compact':
        await this.bridge.handleCodexCompact(value, ctx);
        return;
      case 'resume.compact':
        await this.bridge.handleResumeCompact(value, ctx);
        return;
      default: {
        // Help card buttons: help.<cmd> → execute /<cmd>
        if (value.cmd.startsWith('help.')) {
          const subCmd = value.cmd.slice(5); // e.g. "status", "ps", "stop"
          const result = await this.executeCommand(`/${subCmd}`, ctx);
          if (result) {
            await this.bridge.sendResult(result, ctx);
          }
          // /exit、/restart 等命令通过 pendingExit 表达"回复送达后退出"。
          // handle() 在 sendResult 后消费它；help.* 按钮点击走 handleCardAction，
          // 必须同样消费，否则点击 /restart 按钮 spawn 成功后旧进程不退出，
          // 新进程撞单例锁退出 → 重启两头落空（2026-08-01 红绿 anchor 锁定）。
          if (this.pendingExit) {
            await this.bridge.flushAllMediaNotifications();
            this.exitHandler();
          }
          return;
        }
        // Design constraint: miss paths must reply via bridge.sendResult —
        // don't silently swallow unknown card actions.
        getLogger().warn(`[router] unknown card action: ${value.cmd}`);
        await this.bridge.sendResult({ text: `⚠️ 未知的卡片操作: ${value.cmd}` }, ctx);
        return;
      }
    }
  }

  /**
   * Handle approval-related card actions.
   * Routes to the appropriate bridge method based on value.cmd.
   * Returns a toast response for immediate user feedback.
   */
  /** 答案类操作的统一失败反馈：重复投递（同一 nonce 第二次点击）是已生效的
   *  中性事件，报 error 会误导（首次点击实际已成功）。 */
  private answerFailureToast(msg: string): CardActionResponse {
    if (/already submitted \(duplicate nonce\)/.test(msg)) {
      return { toast: { type: 'info', content: '该选项已处理，请勿重复点击' } };
    }
    return { toast: { type: 'error', content: `答案提交失败：${msg}` } };
  }

  private async handleApprovalAction(
    value: CardActionPayload,
    _ctx: CommandContext,
  ): Promise<CardActionResponse> {
    const { runId, requestId, decision, nonce, permId } = value;

    if (value.cmd === 'approval.respond') {
      if (!runId || requestId === undefined || !decision || !nonce) {
        return { toast: { type: 'error', content: '缺少审批响应参数' } };
      }
      try {
        await this.bridge.handleApprovalRespond({
          runId,
          requestId,
          decision,
          nonce,
        });
        return { toast: { type: 'success', content: '审批已提交' } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 审批已过期：给用户明确反馈，不静默不误导（2026-08-12 事故：点了允许无任何反馈）。
        const content = /state=expired/.test(msg)
          ? '⏰ 审批已过期，无法响应'
          : `审批响应失败：${msg}`;
        return { toast: { type: 'error', content } };
      }
    }

    if (value.cmd === 'approval.toggle') {
      if (!runId || requestId === undefined || !permId) {
        return { toast: { type: 'error', content: '缺少权限切换参数' } };
      }
      try {
        await this.bridge.handleApprovalToggle({
          runId,
          requestId,
          permId,
          selected: value.selected ?? true,
        });
        return { toast: { type: 'info', content: '已切换' } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toast: { type: 'error', content: `权限切换失败：${msg}` } };
      }
    }

    if (value.cmd === 'approval.answer') {
      if (
        !runId ||
        requestId === undefined ||
        value.questionIndex === undefined ||
        !value.option ||
        !nonce
      ) {
        return { toast: { type: 'error', content: '缺少问题答案参数' } };
      }
      try {
        await this.bridge.handleApprovalAnswer({
          runId,
          requestId,
          questionIndex: value.questionIndex,
          option: value.option,
          nonce,
        });
        return { toast: { type: 'success', content: '已选择' } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return this.answerFailureToast(msg);
      }
    }

    if (value.cmd === 'approval.answerSubmit') {
      if (!runId || requestId === undefined || value.questionIndex === undefined || !nonce) {
        return { toast: { type: 'error', content: '缺少提交参数' } };
      }
      try {
        await this.bridge.handleApprovalAnswerSubmit({
          runId,
          requestId,
          questionIndex: value.questionIndex,
          nonce,
        });
        return { toast: { type: 'success', content: '答案已提交' } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return this.answerFailureToast(msg);
      }
    }

    if (value.cmd === 'approval.answerCustom') {
      if (
        !runId ||
        requestId === undefined ||
        value.questionIndex === undefined ||
        !nonce ||
        !value.inputValue
      ) {
        return { toast: { type: 'error', content: '缺少答案文本参数' } };
      }
      try {
        await this.bridge.handleApprovalAnswerCustom({
          runId,
          requestId,
          questionIndex: value.questionIndex,
          text: value.inputValue,
          nonce,
        });
        return { toast: { type: 'success', content: '答案已提交' } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return this.answerFailureToast(msg);
      }
    }

    if (value.cmd === 'approval.answerNote') {
      if (
        !runId ||
        requestId === undefined ||
        value.questionIndex === undefined ||
        !nonce ||
        !value.inputValue
      ) {
        return { toast: { type: 'error', content: '缺少补充说明参数' } };
      }
      try {
        await this.bridge.handleApprovalAnswerNote({
          runId,
          requestId,
          questionIndex: value.questionIndex,
          text: value.inputValue,
          nonce,
        });
        return { toast: { type: 'success', content: '补充说明已保存' } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return this.answerFailureToast(msg);
      }
    }

    if (value.cmd === 'approval.planFeedback') {
      if (!runId || requestId === undefined || !nonce || !value.inputValue) {
        return { toast: { type: 'error', content: '缺少修改意见参数' } };
      }
      try {
        await this.bridge.handleApprovalPlanFeedback({
          runId,
          requestId,
          text: value.inputValue,
          nonce,
        });
        return { toast: { type: 'success', content: '修改意见已保存' } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toast: { type: 'error', content: `修改意见保存失败：${msg}` } };
      }
    }

    return { toast: { type: 'error', content: '未知的审批操作' } };
  }

  /**
   * Handle queue.cancel: remove this message from the queue.
   */
  private async handleQueueCancel(
    value: { workspace?: string; messageId?: string },
    ctx: CommandContext,
  ): Promise<void> {
    const workspace = value.workspace;
    const messageId = value.messageId;

    if (!workspace || !messageId) {
      await this.bridge.sendResult({ text: '⚠️ 卡片 payload 缺少必要信息' }, ctx);
      return;
    }

    const removed = this.bridge.removeFromQueue(workspace, messageId);
    if (removed) {
      // Update the queue card in-place to "cancelled" state
      await this.bridge.updateQueueCardToCancelled(workspace, messageId);
      // Send a brief confirmation (user can see the card has been updated)
      await this.bridge.sendResult({ text: '✅ 已从队列中撤销' }, ctx);
    } else {
      await this.bridge.sendResult({ text: '⚠️ 该消息不在队列中（可能已开始执行）' }, ctx);
    }
  }

  /**
   * Handle queue.immediate: stop current run, clear queue before this message, execute this message immediately.
   * Instead of asking user to resend, we keep the target task in queue and let it execute.
   */
  private async handleQueueImmediate(
    value: { workspace?: string; messageId?: string },
    ctx: CommandContext,
  ): Promise<void> {
    const workspace = value.workspace;
    const messageId = value.messageId;

    if (!workspace || !messageId) {
      await this.bridge.sendResult({ text: '卡片 payload 缺少必要信息' }, ctx);
      return;
    }

    // 1. Check target exists BEFORE any await. The queue chain can advance
    // while later awaits (interruptCurrentRun / markQueueCardExecuting's card
    // send) are in flight, so the target must be read synchronously at entry.
    const targetTask = this.bridge.getQueuedTask(workspace, messageId);

    if (!targetTask) {
      // The target already began (or was cancelled) before this handler ran. We
      // must NOT claim the queue was cleared — nothing is removed in this branch
      // and tasks queued behind the target are still waiting (see A13).
      await this.bridge.sendResult(
        {
          text: '该消息已不在队列中（可能已开始执行或被撤销），无法立即执行。其余排队消息保持原状。',
        },
        ctx,
      );
      return;
    }

    // 1.5. If the user edited the message, the original closure (captured at
    // enqueue time with stale content) must NOT run. Register a one-shot
    // replacement closure on the task's EXISTING queue slot BEFORE any await:
    // interruptCurrentRun / markQueueCardExecuting can let the chain advance to
    // this task's begin, and begin consumes the replacement at that point — a
    // registration after those awaits would arrive too late (the stale closure
    // runs and the replacement leaks as a permanent dead closure). Registering
    // on the existing slot (instead of removeFromQueue + re-enqueue) preserves
    // the queue position: enqueue can only append to the promise chain tail,
    // which would put the edited task behind tasks queued after it.
    if (targetTask.editedMessage) {
      const editedContent = targetTask.editedMessage;
      // D3/Step3: 替换闭包复用原任务的 binding（不重新快照）+ 恢复丢失的
      // cwdOverride（lane cwd 同源）。否则编辑后重新执行的 run 会丢 cwd 与绑定。
      this.bridge.setTaskReplacement(workspace, messageId, async () => {
        await this.handle(editedContent, ctx, {
          cwdOverride: workspace,
          binding: targetTask.binding,
        });
      });
    }

    // 2. Stop current running process
    // (Note: queue executing count is reset inside Bridge.interruptCurrentRun
    //  so all stop paths — /stop, /t, card stop, queue.immediate — are covered.)
    const stopped = await this.bridge.interruptCurrentRun({
      userId: ctx.userId,
      chatId: ctx.chatId,
      workspace,
    });
    getLogger().info(`[router] queue.immediate: stopped=${stopped}`);

    // 3. Remove all tasks BEFORE this one (by position in the current queue).
    // The target may have begun while interruptCurrentRun was awaiting (the chain
    // advances concurrently): then it is already out of the snapshot and every
    // remaining queued task is BEHIND it — clearing must stop, not run off the
    // end and delete tasks queued after the target.
    const tasks = this.bridge.getQueuedTasks(workspace);
    const targetIdx = tasks.findIndex((t) => t.messageId === messageId);
    let removedCount = 0;
    const removedIds: string[] = [];
    // Phase 1: remove synchronously. The queue chain advances on any await
    // (card PATCH round trips included), so every task before the target must
    // be removed before yielding to the event loop — otherwise a task the user
    // asked to clear can begin executing while its cancellation card is still
    // in flight.
    for (let i = 0; i < targetIdx; i++) {
      const task = tasks[i];
      if (this.bridge.removeFromQueue(workspace, task.messageId)) {
        removedCount++;
        removedIds.push(task.messageId);
      }
    }
    if (targetIdx < 0) {
      getLogger().debug(
        `[router] queue.immediate: target no longer queued (began/cancelled), not clearing tasks behind it`,
      );
    }
    // Phase 2: update cancelled cards after all removals. All tasks before the
    // target are already gone, so any chain advance can only reach the target
    // itself — the card updates may safely run in the background.
    for (const removedId of removedIds) {
      void this.bridge.updateQueueCardToCancelled(workspace, removedId);
    }

    // 4. DO NOT remove the target task - keep it in queue to execute immediately
    // The queue will naturally execute it after the current task (which we just stopped)

    // 4.4. Refresh the replacement with the latest edited content (idempotent:
    // re-registering over the same slot). Covers the user editing the message
    // again while interruptCurrentRun was awaiting; skipped automatically once
    // the task has begun, because getQueuedTask then returns undefined.
    const latestTask = this.bridge.getQueuedTask(workspace, messageId);
    if (latestTask?.editedMessage) {
      const editedContent = latestTask.editedMessage;
      // D3/Step3: 复用原任务 binding + 恢复 cwdOverride（同上）。
      this.bridge.setTaskReplacement(workspace, messageId, async () => {
        await this.handle(editedContent, ctx, {
          cwdOverride: workspace,
          binding: latestTask.binding,
        });
      });
    }

    // 4.5/6. The target must only be marked executing (and the toast may only
    // promise immediate execution) when it is really the next task after the
    // stop. While interruptCurrentRun was awaiting, a task ahead of the target
    // may have begun and now occupy the workspace — the target is still queued
    // but is NOT next, so its card must stay queued and the toast must say so.
    const targetStillQueued = this.bridge.getQueuedTask(workspace, messageId) !== undefined;
    if (!targetStillQueued) {
      // The target began or was cancelled while earlier awaits were in flight —
      // a success toast must never promise execution of a task that will not
      // run. The two missing-reason states get distinct feedback: a target
      // that began while the interrupt was in flight is already executing, so
      // the toast must acknowledge that instead of telling the user nothing
      // was scheduled; only a target that was actually cancelled (never began)
      // gets the "未安排执行" wording.
      if (this.bridge.hasTaskBegan(messageId)) {
        await this.bridge.sendResult(
          { text: `ℹ️ 目标消息已开始执行，无需重复操作。已清除 ${removedCount} 条排队消息。` },
          ctx,
        );
      } else {
        await this.bridge.sendResult(
          {
            text: `⚠️ 目标消息已不在队列中（可能已被撤销），未安排执行。已清除 ${removedCount} 条排队消息。`,
          },
          ctx,
        );
      }
      return;
    }
    const workspaceBusy = this.bridge.isBusyFor(workspace);
    if (!workspaceBusy) {
      // Normal path: nothing new began during the stop, the target is next.
      // Mark its own card as executing now so buttons grey out immediately.
      // Done BEFORE any removal so getQueuedTask still returns the task with
      // its (possibly edited) messagePreview for the card. The queue callback's
      // later updateQueueCardToExecuting call becomes a no-op (idempotent).
      await this.bridge.markQueueCardExecuting(workspace, messageId);
      const stopPrefix = stopped ? '⚡ 已停止当前任务，' : '';
      await this.bridge.sendResult(
        { text: `${stopPrefix}清除了 ${removedCount} 条排队消息。您的消息将立即执行。` },
        ctx,
      );
    } else {
      await this.bridge.sendResult(
        {
          text: `⚠️ 排在目标之前的任务已开始执行，目标消息保持排队。已清除 ${removedCount} 条排队消息。`,
        },
        ctx,
      );
    }
  }

  /**
   * Handle queue.diagnose: show diagnostic info for why message is queuing.
   */
  private async handleQueueDiagnose(
    value: { workspace?: string; messageId?: string; userId?: string; chatId?: string },
    ctx: CommandContext,
  ): Promise<void> {
    const workspace = value.workspace;
    const messageId = value.messageId;
    const targetUserId = value.userId ?? ctx.userId;

    if (!workspace || !messageId) {
      await this.bridge.sendResult({ text: '卡片 payload 缺少必要信息' }, ctx);
      return;
    }

    const task = this.bridge.getQueuedTask(workspace, messageId);
    const queueInfo = this.bridge.getQueueInfo(workspace);
    const activeRuns = this.bridge.getAllActiveRuns();

    // Build diagnostic info
    const now = new Date().toLocaleString('zh-CN');
    const pid = process.pid;
    const sessionId = this.sessionStore.getSessionId(targetUserId, this.config.defaultAgent);

    // Format active runs info
    let activeRunsInfo = '无';
    if (activeRuns.size > 0) {
      const runInfos: string[] = [];
      for (const [cwd, run] of activeRuns) {
        runInfos.push(`- 📂 ${cwd}\n  runId: ${run.runId.slice(0, 8)}...\n  userId: ${run.userId}`);
      }
      activeRunsInfo = runInfos.join('\n');
    }

    const diagnosticCard = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '🔧 队列诊断报告' },
      },
      body: {
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: `**时间**: ${now}\n**进程 PID**: ${pid}` },
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**消息信息**\n- 工作目录: \`${workspace}\`\n- 会话 ID: \`${sessionId ?? '(none)'}\`\n- 消息预览: ${task?.messagePreview ?? '(unknown)'}`,
            },
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**队列状态**\n- 排队的任务数: ${queueInfo.position}\n- 当前正在运行: ${queueInfo.isRunning ? '✅ 是' : '❌ 否'}\n- 排在当前任务之前的消息数: ${queueInfo.tasksAhead}`,
            },
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: { tag: 'lark_md', content: `**活跃运行**\n${activeRunsInfo}` },
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**可能原因**\n1. **当前有其他任务在运行** — 串行队列确保每次只执行一个任务\n2. **之前的任务卡住了** — 可点击"⚡ 立即执行"停止当前任务并执行这一条\n3. **Idle 超时触发** — 如果之前的任务长时间没有输出，watchdog 会自动停止它`,
            },
          },
        ],
      },
    };

    await this.bridge.sendResult({ card: diagnosticCard }, ctx);
  }

  /**
   * Handle queue.edit: show input field for editing the queued message.
   */
  private async handleQueueEdit(
    value: { workspace?: string; messageId?: string },
    ctx: CommandContext,
  ): Promise<void> {
    const workspace = value.workspace;
    const messageId = value.messageId;

    if (!workspace || !messageId) {
      await this.bridge.sendResult({ text: '⚠️ 卡片 payload 缺少必要信息' }, ctx);
      return;
    }

    // Get current message preview
    const task = this.bridge.getQueuedTask(workspace, messageId);
    if (!task) {
      await this.bridge.sendResult({ text: '⚠️ 该消息不在队列中（可能已开始执行）' }, ctx);
      return;
    }

    // Build edit card
    // CardKit 2.0 input 自带 ✓ 提交图标，点击时输入值走 raw.action.input_value
    // （SDK normalizer 丢弃，需 connector includeRawEvent: true + index.ts 从 raw 提取）。
    // 用 column_set + input + behaviors，不用 form 容器（form 触发 300123 无 submit button /
    // 200621 嵌套 column，submit-typed button 也被 CardKit 2.0 拒绝 HTTP 400）。
    const editCard = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '✏️ 编辑排队消息' },
      },
      body: {
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: `**当前消息:**\n\`${task.messagePreview}\`` },
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: { tag: 'lark_md', content: '💡 输入新内容后点击右侧 ✓ 提交图标' },
          },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 3,
                elements: [
                  {
                    tag: 'input',
                    name: 'newMessage',
                    placeholder: { tag: 'plain_text', content: '输入新的消息内容...' },
                    default_value: task.messagePreview,
                    behaviors: [
                      { type: 'callback', value: { cmd: 'queue.input', workspace, messageId } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // 原地更新原排队卡片，而不是发送新卡片
    await this.bridge.updateCardInPlace(editCard, ctx);
  }

  /**
   * Handle queue.input: update the queued message with new content.
   * Returns a CardActionResponse carrying both a toast (immediate feedback,
   * no separate message sent) and a `card` field so Feishu renders the
   * updated queue card in place, closing the edit form. A toast-only response
   * leaves the card stuck in the edit state (Feishu keeps the pre-click card
   * when the callback response has no `card` field).
   */
  private async handleQueueInput(
    value: {
      workspace?: string;
      messageId?: string;
      inputValue?: string;
      formValue?: Record<string, unknown>;
    },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    const workspace = value.workspace;
    const messageId = value.messageId;
    const newMessage = value.inputValue ?? (value.formValue?.['newMessage'] as string | undefined);

    if (!workspace || !messageId) {
      await this.bridge.sendResult({ text: '⚠️ 卡片 payload 缺少必要信息' }, ctx);
      return;
    }

    if (!newMessage) {
      await this.bridge.sendResult({ text: '⚠️ 缺少新消息内容' }, ctx);
      return;
    }

    // RACE FIX: register the replacement closure BEFORE any await. The old
    // code awaited updateMessagePreview first, yielding to the microtask
    // queue. Between that yield and the later setTaskReplacement call, the
    // queue chain could advance: the task's begin path would find no
    // replacement → the original stale closure would run → the user saw
    // "消息已更新" but the agent executed the old prompt.
    //
    // By registering synchronously first, the begin path always finds the
    // replacement if the task starts during the subsequent await. Both
    // setTaskReplacement and the begin-path consumption are synchronous, so
    // there is no interleaving window.
    //
    // D3/Step3：复用原任务 binding（不重新快照）+ 恢复 cwdOverride。
    const inputTask = this.bridge.getQueuedTask(workspace, messageId);
    if (!inputTask) {
      // Task already left the queue (began or was cancelled) before we could
      // register the replacement. Return a toast so the edit-form card gets
      // dismissed — sendResult alone leaves the card stuck in the edit state
      // (Feishu keeps the pre-click card when the callback response has no
      // toast/card field).
      return { toast: { type: 'info', content: '任务已不在队列中（可能已开始执行或被撤销）' } };
    }
    this.bridge.setTaskReplacement(workspace, messageId, async () => {
      await this.handle(newMessage, ctx, { cwdOverride: workspace, binding: inputTask.binding });
    });

    // Update the message preview (and editedMessage so handleQueueImmediate
    // re-enqueues the edited content instead of the stale original closure),
    // and build the updated queue card. Returning the card in the callback
    // response makes Feishu render it in place -- a toast-only response leaves
    // the card stuck in the edit state (Feishu keeps the pre-click card when
    // the callback response has no `card` field).
    //
    // After the synchronous replacement registration above, it is safe to
    // await here: even if the queue chain advances and the replacement is
    // consumed, the user-facing card update is best-effort (the executing card
    // is updated by updateQueueCardToExecuting instead).
    const card = await this.bridge.updateMessagePreview(workspace, messageId, newMessage);
    if (!card) {
      // Task left the queue during the await (began or cancelled). The
      // replacement was already consumed (begin path) or cleaned up
      // (cancel/removeFromQueue path). Inform the user the edit didn't stick
      // as a *card update*, but the replacement closure was already in effect.
      if (this.bridge.hasTaskBegan(messageId)) {
        return {
          toast: { type: 'success', content: '消息已更新（任务已开始执行）' },
        };
      }
      return {
        toast: { type: 'info', content: '任务已不在队列中，编辑未生效' },
      };
    }
    return {
      toast: { type: 'success', content: '消息已更新' },
      card: { type: 'raw', data: card },
    };
  }

  /**
   * Handle ls.switch: switch cwd to target directory after path validation.
   */
  private async handleLsSwitch(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    const targetPath = value.path;
    if (!targetPath) {
      await this.bridge.sendResult({ text: '卡片 payload 缺少 path' }, ctx);
      return;
    }
    const cwd = this.sessionStore.getCwd(ctx.userId);
    if (!cwd) {
      await this.bridge.sendResult({ text: '请先使用 /cd <path> 设置工作目录' }, ctx);
      return;
    }
    const resolvedTarget = path.resolve(targetPath);
    // 与 ls.browse 对齐：目标只要存在且是目录即可切换（不再做子树/父级限制）。
    // 安全边界由 binder owner 认证兜底，见 docs/architecture/design.md §9.7 更新说明。
    if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isDirectory()) {
      await this.bridge.sendResult({ text: `路径无效: ${resolvedTarget}` }, ctx);
      return;
    }
    // Canonicalize via realpath; if the target vanished between stat and
    // realpath (TOCTOU), reject gracefully instead of throwing.
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolvedTarget);
    } catch {
      await this.bridge.sendResult({ text: `路径无效: ${resolvedTarget}` }, ctx);
      return;
    }
    // Set cwd + auto-resume + user notification (shared with /cd and /ws use)
    const notifyResult = this.switchCwdAndNotify(ctx.userId, canonical, ctx);
    // Card channel: refresh ls card in-place (existing behavior preserved)
    const card = this.cmdLs([canonical], ctx, 0);
    await this.bridge.updateCardInPlace(card.card!, ctx);
    // Message channel: send switch confirmation / auto-resume card to chat
    await this.bridge.sendResult(notifyResult, ctx);
  }

  /**
   * Handle ls.refresh: reload current directory.
   */
  private async handleLsRefresh(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    const targetPath = value.path;
    const offset = value.offset ?? 0;
    // TOCTOU guard (review P2-2): existsSync → statSync can race (target
    // deleted in between), throwing into enqueueImmediate's catch which only
    // logs — violating the "card button clicks must give visible feedback"
    // red line. Treat a vanished/non-dir path as "use current cwd" instead of
    // crashing the refresh.
    let card: CommandResult | null;
    try {
      card =
        targetPath && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
          ? this.cmdLs([targetPath], ctx, offset)
          : this.cmdLs([], ctx, offset);
    } catch {
      card = this.cmdLs([], ctx, offset);
    }
    await this.bridge.updateCardInPlace(card.card!, ctx);
  }

  /**
   * Handle ls.page: paginate to a specific offset.
   */
  private async handleLsPage(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    const targetPath = value.path;
    const offset = value.offset ?? 0;
    if (!targetPath) {
      return { toast: { type: 'error', content: '卡片 payload 缺少 path' } };
    }
    const resolvedTarget = path.resolve(targetPath);
    // TOCTOU guard (review P2-2): existsSync → statSync can race; without the
    // try/catch the throw lands in enqueueImmediate's silent .catch and the
    // paginated card never updates (no visible feedback for the click).
    let isDir: boolean;
    try {
      isDir = fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return { toast: { type: 'error', content: `路径无效: ${resolvedTarget}` } };
    }
    const card = this.cmdLs([resolvedTarget], ctx, offset);
    // 直接更新卡片，与 ls.browse/ls.refresh 行为一致
    await this.bridge.updateCardInPlace(card.card!, ctx);
    return { toast: { type: 'success', content: '' } };
  }

  /**
   * Handle resume.page: paginate the /resume session list in place.
   * Mirrors handleLsPage — updates the same card, never sends a new one.
   */
  private async handleResumePage(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    const resumeAgent = value.agent ?? this.config.defaultAgent;
    const validAgents = CommandRouter.VALID_AGENTS;
    const resolvedAgent = validAgents.includes(resumeAgent as (typeof validAgents)[number])
      ? (resumeAgent as (typeof validAgents)[number])
      : this.config.defaultAgent;

    const { pageSize, alignedOffset } = normalizePageArgs(value, RESUME_PAGE_SIZE);

    const entry = this.sessionStore.get(ctx.userId);
    const cwd = entry?.cwd;
    if (!cwd) {
      return { toast: { type: 'error', content: '请先 /cd 设置工作目录' } };
    }

    // cmdResume clamps stale/out-of-range offsets and re-fetches internally.
    const result = this.cmdResume([resolvedAgent, String(pageSize)], ctx, alignedOffset);
    if (!result.card) {
      // e.g. the agent has no sessions in this directory — surface an error
      // toast instead of a contradictory success toast plus text reply.
      // Agent name keeps the toast consistent with the text branch of cmdResume.
      return {
        toast: {
          type: 'error',
          content: `当前目录没有 ${agentDisplayName(resolvedAgent)} 的 session 记录`,
        },
      };
    }
    await this.bridge.updateCardInPlace(result.card, ctx);
    return { toast: { type: 'success', content: '' } };
  }

  /**
   * Handle active.page: paginate the /active run list in place.
   * Mirrors handleResumePage — updates the same card, never sends a new one.
   */
  private async handleActivePage(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    const { alignedOffset } = normalizePageArgs(value, ACTIVE_PAGE_SIZE);

    const result = this.cmdActive([], ctx, alignedOffset);
    if (!result.card) {
      return { toast: { type: 'error', content: '当前没有正在进行中的任务' } };
    }
    await this.bridge.updateCardInPlace(result.card, ctx);
    return { toast: { type: 'success', content: '' } };
  }

  /**
   * Handle ls.browse: browse directory without switching cwd.
   */
  private async handleLsBrowse(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    const targetPath = value.path;
    if (!targetPath) {
      await this.bridge.sendResult({ text: '卡片 payload 缺少 path' }, ctx);
      return;
    }
    const resolvedTarget = path.resolve(targetPath);
    if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isDirectory()) {
      await this.bridge.sendResult({ text: `路径无效: ${resolvedTarget}` }, ctx);
      return;
    }
    // Always reset to page 0 when browsing to a new directory
    const card = this.cmdLs([resolvedTarget], ctx, 0);
    await this.bridge.updateCardInPlace(card.card!, ctx);
  }

  /**
   * Handle stop card action: interrupt current run.
   */
  private async handleCardStop(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    if (!value.runId || !ctx.userId || !ctx.chatId) {
      await this.bridge.sendResult({ text: '⚠️ 无效的停止请求，缺少必要信息' }, ctx);
      return;
    }
    const stopped = await this.bridge.interruptCurrentRun({
      userId: ctx.userId,
      chatId: ctx.chatId,
      runId: value.runId,
    });
    // Regression 2026-06-22: card stop button silently no-op'd when the
    // run had already exited. Give the user a visible result.
    if (!stopped) {
      await this.bridge.sendResult({ text: '该任务已结束，无需终止' }, ctx);
    }
  }

  /**
   * Resolve an order's text at the enqueue boundary so order.exec can enter
   * the serial queue as an equivalent user message (Plan A) — the same path a
   * hand-typed message takes. index.ts calls this before bridge.enqueue and
   * uses the returned `orderText` as the queue messagePreview / edit
   * default_value, and `internalKey` as the queue dedup key.
   *
   * Why an internal key instead of the Feishu card messageId: one order card
   * can be clicked many times, so the card messageId is 1:N with enqueue
   * actions. Reusing it collides queuedTasks / queueCardMessages lookups.
   * Each call therefore mints a unique key (the Feishu messageId still flows
   * through ctx for replies/reactions — the two concerns are separate).
   *
   * `updateUsedAt` runs here, at resolve time, so the usage timestamp
   * survives even an immediate crash before the queued task ever runs
   * (preserves the H3 crash-safe property previously held by handleOrderExec,
   * which recorded it right before forwardToClaude).
   *
   * Returns null when the order no longer exists; index.ts surfaces the error.
   */
  resolveOrderExecForQueue(orderId: string): { orderText: string; internalKey: string } | null {
    if (!this.orderStore.has(orderId)) return null;
    const order = this.orderStore.get().find((o) => o.id === orderId);
    if (!order) return null;
    this.orderStore.updateUsedAt(order.id);
    return {
      orderText: order.text,
      internalKey: `order-${order.id}-${this.orderExecKeyCounter++}`,
    };
  }
  /**
   * Handle order.delete: remove the order and update card in place.
   */
  private async handleOrderDelete(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    const orderId = value.orderId;

    if (!orderId) {
      return { toast: { type: 'error', content: '卡片 payload 缺少必要信息' } };
    }

    if (!this.orderStore.has(orderId)) {
      return { toast: { type: 'error', content: '指令不存在或已被删除' } };
    }

    // Delete the order
    this.orderStore.remove(orderId);

    // Refresh the order list and update card in place, preserving current page
    const currentOffset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    const result = this.cmdOrder([], ctx, currentOffset);
    await this.bridge.updateCardInPlace(result.card!, ctx);

    return { toast: { type: 'success', content: '已删除指令' } };
  }

  /**
   * Handle order.page: paginate the /order list in place.
   * Mirrors handleLsPage — updates the same card, never sends a new one.
   */
  private async handleOrderPage(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    const offset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    // cmdOrder internally clamps stale/out-of-range offsets
    const result = this.cmdOrder([], ctx, offset);
    await this.bridge.updateCardInPlace(result.card!, ctx);
    return { toast: { type: 'success', content: '' } };
  }

  /**
   * Handle order.aliasEdit: 展示别名编辑卡（input + ✓ 提交图标）。
   * 有别名时预填；提交 `order.aliasInput` 处理（含校验与唯一性）。
   */
  private async handleOrderAliasEdit(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    const orderId = value.orderId;
    const offset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    if (!orderId) {
      return { toast: { type: 'error', content: '卡片 payload 缺少必要信息' } };
    }
    this.orderStore.reload();
    const order = this.orderStore.get().find((o) => o.id === orderId);
    if (!order) {
      return { toast: { type: 'error', content: '指令不存在或已被删除' } };
    }
    const displayText = order.text.length > 100 ? order.text.slice(0, 97) + '...' : order.text;
    // CardKit 2.0 input 自带 ✓ 提交图标（input_value 经 raw 回传，红线）。
    // 不用 form 容器（触发 300123 无 submit button / 200621 嵌套 column）。
    const editCard = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '✏️ 给指令起别名' },
      },
      body: {
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: `**当前指令:**\n\`${displayText}\`` },
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: '💡 输入别名名后点击右侧 ✓ 提交；留空提交 = 删除该别名',
            },
          },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 3,
                elements: [
                  {
                    tag: 'input',
                    name: 'aliasName',
                    placeholder: { tag: 'plain_text', content: '输入 $别名名（如 all）...' },
                    default_value: order.alias ?? '',
                    behaviors: [
                      {
                        type: 'callback',
                        value: { cmd: 'order.aliasInput', orderId, offset },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    await this.bridge.updateCardInPlace(editCard, ctx);
  }

  /**
   * Handle order.aliasInput: 提交别名（绑/改/解绑），随后重渲染 /order 列表卡。
   * 留空 = 解绑；非空按命名规则 + 全局唯一校验，失败仅 toast 不重渲染。
   */
  private async handleOrderAliasInput(
    value: {
      orderId?: string;
      offset?: number;
      inputValue?: string;
      formValue?: Record<string, unknown>;
    },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    const orderId = value.orderId;
    const offset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    const name = value.inputValue ?? (value.formValue?.['aliasName'] as string | undefined);
    if (!orderId) {
      return { toast: { type: 'error', content: '卡片 payload 缺少必要信息' } };
    }
    this.orderStore.reload();
    const order = this.orderStore.get().find((o) => o.id === orderId);
    if (!order) {
      return { toast: { type: 'error', content: '指令不存在或已被删除' } };
    }
    const trimmed = name?.trim() ?? '';
    // 变更前快照旧别名：setAlias 会原地变异 order 对象（delete entry.alias），
    // 删除后 order.alias 已为 undefined，直接用会让成功文案显示 `$undefined`。
    const prevAlias = order.alias;
    try {
      this.orderStore.setAlias(order.id, trimmed === '' ? undefined : trimmed);
    } catch (err) {
      return { toast: { type: 'error', content: (err as Error).message } };
    }
    // 成功：重渲染列表卡（保持页码）。必须把 card 放进 callback 响应体让飞书
    // 原地替换 pre-click 编辑卡——toast-only 响应会停留在编辑界面（飞书保留
    // 点击前那张卡），见 handleQueueInput 同款注释。
    const result = this.cmdOrder([], ctx, offset);
    return {
      toast: {
        type: 'success',
        content: trimmed === '' ? `✅ 已移除别名 $${prevAlias ?? ''}` : `✅ 已绑定别名 $${trimmed}`,
      },
      card: { type: 'raw', data: result.card! },
    };
  }

  /** Handle order.aliasRemove: 删除某条指令的别名并原地重渲染列表卡。 */
  private async handleOrderAliasRemove(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    const orderId = value.orderId;
    const offset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    if (!orderId) {
      return { toast: { type: 'error', content: '卡片 payload 缺少必要信息' } };
    }
    this.orderStore.reload();
    const order = this.orderStore.get().find((o) => o.id === orderId);
    if (!order || !order.alias) {
      return { toast: { type: 'error', content: '指令不存在或没有别名' } };
    }
    // 变更前快照旧别名：setAlias(undefined) 会原地变异 order（delete alias），
    // 删除后 order.alias 已为 undefined，直接拼会让成功文案显示 `$undefined`。
    const removedAlias = order.alias;
    this.orderStore.setAlias(order.id, undefined);
    // 必须把 card 放进 callback 响应体让飞书原地替换 pre-click 卡片，否则删除
    // 后卡片停留在旧状态（别名视觉上未消失）。同 handleQueueInput 语义。
    const result = this.cmdOrder([], ctx, offset);
    return {
      toast: { type: 'success', content: `✅ 已移除别名 $${removedAlias}` },
      card: { type: 'raw', data: result.card! },
    };
  }

  /**
   * Handle order.textEdit: 展示指令文本编辑卡（input + ✓ 提交图标）。
   * 预填当前 text（完整内容，不截断——input 组件有自有滚动条）；
   * 提交 `order.textInput` 处理（trim + 长度校验 + OrderStore.updateText）。
   * 完全镜像 handleOrderAliasEdit 的 4 段结构（reload → find → 构造 editCard →
   * updateCardInPlace）。
   */
  private async handleOrderTextEdit(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    const orderId = value.orderId;
    const offset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    if (!orderId) {
      return { toast: { type: 'error', content: '卡片 payload 缺少必要信息' } };
    }
    this.orderStore.reload();
    const order = this.orderStore.get().find((o) => o.id === orderId);
    if (!order) {
      return { toast: { type: 'error', content: '指令不存在或已被删除' } };
    }
    // 列表卡显示的是截断版（≤100 字符 + ...），编辑卡预览也保持一致；
    // input 组件 default_value 预填完整 text（不受截断影响），用户提交后生效完整文本。
    const displayText = order.text.length > 100 ? order.text.slice(0, 97) + '...' : order.text;
    // CardKit 2.0 input 自带 ✓ 提交图标（input_value 经 raw 回传，红线）。
    // 不用 form 容器（触发 300123 无 submit button / 200621 嵌套 column）。
    const editCard = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '✏️ 编辑指令' },
      },
      body: {
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: `**当前指令:**\n\`${displayText}\`` },
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: '💡 修改后点击右侧 ✓ 提交；空白提交 = 报错；最多 200 字符',
            },
          },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 3,
                elements: [
                  {
                    tag: 'input',
                    name: 'text',
                    placeholder: { tag: 'plain_text', content: '输入新的指令文本...' },
                    default_value: order.text,
                    // max_length 与 MAX_TEXT_LENGTH=200 对齐：超长在输入侧直接截断，
                    // 避免提交后才报错（后端 updateText 仍会二次校验，双保险）。
                    max_length: 200,
                    behaviors: [
                      {
                        type: 'callback',
                        value: { cmd: 'order.textInput', orderId, offset },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    await this.bridge.updateCardInPlace(editCard, ctx);
  }

  /**
   * Handle order.textInput: 提交指令文本编辑。校验 orderId → OrderStore.updateText
   * （store 内部统一 trim + 空/超长校验）。成功 toast + 原地重渲染列表卡（同
   * handleOrderAliasInput 语义：toast-only 响应会让飞书停留在 pre-click 编辑卡，
   * 必须把 card 放进 callback 响应体）；失败仅 error toast。
   * 保留 usedAt / alias / createdAt（OrderStore.updateText 只动 text 字段）。
   */
  private async handleOrderTextInput(
    value: {
      orderId?: string;
      offset?: number;
      inputValue?: string;
      formValue?: Record<string, unknown>;
    },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    const orderId = value.orderId;
    const offset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    const raw = value.inputValue ?? (value.formValue?.['text'] as string | undefined);
    if (!orderId) {
      return { toast: { type: 'error', content: '卡片 payload 缺少必要信息' } };
    }
    this.orderStore.reload();
    const order = this.orderStore.get().find((o) => o.id === orderId);
    if (!order) {
      return { toast: { type: 'error', content: '指令不存在或已被删除' } };
    }
    let updated: OrderEntry | undefined;
    try {
      updated = this.orderStore.updateText(order.id, raw ?? '');
    } catch (err) {
      return { toast: { type: 'error', content: (err as Error).message } };
    }
    if (!updated) {
      // reload + find 后 updateText 不应返回 undefined；防御性兜底（如并发删除）。
      return { toast: { type: 'error', content: '指令不存在或已被删除' } };
    }
    // 成功：重渲染列表卡（保持页码）。必须把 card 放进 callback 响应体让飞书
    // 原地替换 pre-click 编辑卡——toast-only 响应会停留在编辑界面（飞书保留
    // 点击前那张卡），见 handleQueueInput / handleOrderAliasInput 同款注释。
    const result = this.cmdOrder([], ctx, offset);
    const preview = updated.text.length > 50 ? updated.text.slice(0, 50) + '...' : updated.text;
    return {
      toast: { type: 'success', content: `✅ 已更新指令: ${preview}` },
      card: { type: 'raw', data: result.card! },
    };
  }

  /**
   * Handle ws.use card action: switch to the workspace, then refresh the /ws
   * list card in place so "recent" sort order is immediately visible.
   *
   * Unlike the command-line `/ws use` (which returns text), the card action
   * uses toast + inplace refresh for a cleaner UX (matching ws.remove/ws.sort).
   * If auto-resume produces a card, it is sent as a separate reply.
   */
  private async handleWsUse(
    value: { name?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    const name = value.name ?? '';
    const useResult = this.cmdWs(['use', name], ctx);

    // Error cases (workspace not found, path invalid, etc.): relay as error toast
    if (useResult.text && !useResult.text.includes('已切换')) {
      return { toast: { type: 'error', content: useResult.text } };
    }

    // Success: send auto-resume card, or a persistent text confirmation when
    // there is no history session. Toast alone is insufficient: for this
    // immediate action the callback response is swallowed by enqueueImmediate
    // (fire-and-forget), and even if delivered it is transient — the user gets
    // no perceivable feedback on the switch. Same rationale as config.save
    // agent-switch notice: persistent message first, toast only as a
    // fallback if sendResult fails.
    let fallbackToast: string | undefined;
    if (useResult.card || useResult.text) {
      const sent = await this.bridge.sendResult(useResult, ctx);
      if (!sent && useResult.text) {
        fallbackToast = useResult.text;
      }
    }

    // Refresh the /ws list card in place so "recent" sort is immediately visible
    const currentOffset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    const refreshed = this.cmdWs([], ctx, currentOffset);
    if (refreshed.card) {
      await this.bridge.updateCardInPlace(refreshed.card, ctx);
    }

    // Toast feedback (suppress text when a persistent message was already sent)
    return {
      toast: {
        type: 'success',
        content: fallbackToast ?? '',
      },
    };
  }

  /**
   * Handle ws.remove: remove the workspace alias and refresh the /ws list card
   * in place (mirrors handleOrderDelete). Without this the stale alias would
   * remain visible on the card the user just clicked.
   */
  private async handleWsRemove(
    value: { name?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    const name = value.name;
    if (!name) {
      return { toast: { type: 'error', content: '卡片 payload 缺少必要信息' } };
    }

    // Execute the removal (consumes the write-side effect; the returned text
    // is discarded — feedback flows through the toast + refreshed card).
    this.cmdWs(['remove', name], ctx);

    // Rebuild the /ws list card and update it in place, preserving the page
    // the user was on when they clicked 删除.
    const currentOffset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    const refreshed = this.cmdWs([], ctx, currentOffset);
    await this.bridge.updateCardInPlace(refreshed.card!, ctx);

    return { toast: { type: 'success', content: `已删除 workspace "${name}"` } };
  }

  /**
   * Handle ws.page: paginate the /ws list in place.
   * Mirrors handleOrderPage — updates the same card, never sends a new one.
   */
  private async handleWsPage(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    const offset = Math.max(0, Math.trunc(Number(value.offset) || 0));
    // cmdWs internally clamps stale/out-of-range offsets
    const result = this.cmdWs([], ctx, offset);
    await this.bridge.updateCardInPlace(result.card!, ctx);
    return { toast: { type: 'success', content: '' } };
  }

  /**
   * Handle ws.sort: toggle sort preference and refresh the /ws list card.
   * Sort preference is memory-only (not persisted); restart resets to 'recent'.
   */
  private async handleWsSort(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    const userId = ctx.userId;
    const current = this.wsSortPreference.get(userId) ?? 'recent';
    const next = current === 'recent' ? 'alpha' : 'recent';
    this.wsSortPreference.set(userId, next);
    const result = this.cmdWs([], ctx, 0);
    await this.bridge.updateCardInPlace(result.card!, ctx);
    const nextLabel = next === 'recent' ? '🕐 最近使用' : '🔤 字母顺序';
    return {
      toast: { type: 'success', content: `已切换为 ${nextLabel}` },
    };
  }

  /**
   * `ls.file` card button: send file to Feishu, rejecting if > 30MB.
   */
  private async cardLsFile(target: string | undefined, ctx: CommandContext): Promise<void> {
    if (!target) {
      await this.bridge.sendResult({ text: '卡片 payload 缺少 path' }, ctx);
      return;
    }

    const resolvedTarget = path.resolve(target);

    if (!fs.existsSync(resolvedTarget)) {
      await this.bridge.sendResult({ text: `文件不存在: ${resolvedTarget}` }, ctx);
      return;
    }

    // Check it's a file, not directory
    if (!fs.statSync(resolvedTarget).isFile()) {
      await this.bridge.sendResult({ text: `不是文件: ${resolvedTarget}` }, ctx);
      return;
    }

    // Check file size (30MB, aligned with Feishu im/v1/files API)
    const stat = fs.statSync(resolvedTarget);
    if (stat.size > MAX_FILE_UPLOAD_SIZE) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      await this.bridge.sendResult(
        {
          text: `文件太大 (${sizeMB}MB)，超过 ${MAX_FILE_UPLOAD_SIZE / (1024 * 1024)}MB 限制不能发送`,
        },
        ctx,
      );
      return;
    }

    await this.bridge.sendFile(resolvedTarget, ctx);
  }

  // --- PendingConfig 辅助方法 ---

  /** 确保 pendingConfig 已初始化（从当前 config 克隆） */
  ensurePendingConfig(): void {
    if (!this.pendingConfig) {
      this.pendingConfig = structuredClone(this.config);
    }
  }

  /**
   * 串行化 config.* 卡片回调（2026-07-04 修复 toggle 卡死 bug）。
   *
   * CardKit 2.0 input/button 回调经 `enqueueImmediate` 分发，不进 bridge 的
   * 串行队列；多次快速点击 toggle 会并发读写 `pendingConfig` 并同时调
   * `updateCardInPlace` → 两个 patch 请求乱序到达飞书，后到达的 patch（点击 1
   * 的旧卡片）覆盖先到达的 patch（点击 2 的新卡片），用户看到 toggle 卡死。
   *
   * 此方法把所有 config.* 动作串成一个 Promise chain：每个动作等前一个动作
   * 的 `updateCardInPlace` 完全 settle 后再读 `pendingConfig`。
   */
  private enqueueConfigAction(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    const run = async (): Promise<CardActionResponse | void> => {
      try {
        return await this.dispatchConfigAction(value, ctx);
      } catch (err) {
        getLogger().error('[router] config action error:', err);
      }
    };
    const next = this.configActionQueue.then(run);
    // chain 永不 reject（错误已在 run 内吞掉），保证后续动作不被卡住
    this.configActionQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 实际的 config.* 分发逻辑（在串行队列内执行） */
  /** config.* 卡片动作分发（public：测试直接调用，替代 as unknown as）。 */
  async dispatchConfigAction(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    switch (value.cmd) {
      case 'config.toggle': {
        const key = value.key as string | undefined;
        if (!key) {
          await this.bridge.sendResult({ text: '缺少配置项 key' }, ctx);
          return;
        }
        this.ensurePendingConfig();
        const current = getConfigValue(this.pendingConfig!, key);
        // 布尔字段未设置时视为 false，而非报错（如布尔配置项尚未写入 config）
        const boolVal = typeof current === 'boolean' ? current : false;
        try {
          // 只改暂存区，不写盘；原地更新卡片而非发送新卡（2026-07-04）
          this.setNestedValue(this.pendingConfig!, key, !boolVal);
          await this.bridge.updateCardInPlace(this.buildConfigCard().card!, ctx);
        } catch (err) {
          await this.bridge.sendResult({ text: `设置失败: ${(err as Error).message}` }, ctx);
        }
        return;
      }
      case 'config.set': {
        // Set config value from select dropdown (option from CardKit 2.0)
        const key = value.key as string | undefined;
        const newValue = value.option as string | undefined;
        if (!key || newValue === undefined) {
          await this.bridge.sendResult({ text: '缺少参数' }, ctx);
          return;
        }
        try {
          this.ensurePendingConfig();

          // 使用 agent config builder 处理字段变更（处理依赖关系如 provider→model）
          const defaultAgent = this.pendingConfig!.defaultAgent ?? 'claude';
          const configBuilder = getConfigBuilder(defaultAgent);
          const patches = configBuilder.handleFieldChange(key, newValue, this.pendingConfig!);

          for (const patch of patches) {
            this.setNestedValue(this.pendingConfig!, patch.key, patch.value);
          }

          await this.bridge.updateCardInPlace(this.buildConfigCard().card!, ctx);
        } catch (err) {
          await this.bridge.sendResult({ text: `设置失败: ${(err as Error).message}` }, ctx);
        }
        return;
      }
      case 'config.input': {
        // Handle input field: value.key is the field key.
        // 2026-07-04: CardKit 2.0 input 自带提交图标触发 callback，回传 input_value。
        // Fall back to formValue[key]: the SDK currently reports input values
        // via action.formValue for form-wrapped inputs.
        const key = value.key as string | undefined;
        if (!key) {
          await this.bridge.sendResult({ text: '缺少配置项 key' }, ctx);
          return;
        }
        const newValue = value.inputValue ?? (value.formValue?.[key] as string | undefined);
        if (newValue === undefined) {
          await this.bridge.sendResult({ text: '缺少输入值' }, ctx);
          return;
        }
        try {
          this.ensurePendingConfig();

          // 使用 agent config builder 处理字段变更
          const defaultAgent = this.pendingConfig!.defaultAgent ?? 'claude';
          const configBuilder = getConfigBuilder(defaultAgent);
          const patches = configBuilder.handleFieldChange(key, newValue, this.pendingConfig!);

          for (const patch of patches) {
            this.setNestedValue(this.pendingConfig!, patch.key, patch.value);
          }

          await this.bridge.updateCardInPlace(this.buildConfigCard().card!, ctx);
        } catch (err) {
          await this.bridge.sendResult({ text: `设置失败: ${(err as Error).message}` }, ctx);
        }
        return;
      }
      case 'config.save': {
        // 批量保存：将 pendingConfig 一次性写入磁盘
        if (!this.pendingConfig) {
          await this.bridge.sendResult({ text: '没有待保存的修改' }, ctx);
          return;
        }
        const updates = this.diffConfig(this.config, this.pendingConfig);
        if (Object.keys(updates).length === 0) {
          this.pendingConfig = null;
          await this.bridge.sendResult({ text: '没有变更需要保存' }, ctx);
          return;
        }

        try {
          const oldDefaultAgent = this.config.defaultAgent;
          this.config = setConfigValues(this.configPath, this.config, updates);
          // P1-6：运行时传播（idleTimeout / clearRunners / syncAgentChoices /
          // defaultAgent 切换的 session 处理）抽到共享方法，与文本直写路径共用。
          const switchResult = this.propagateConfigSave(oldDefaultAgent, updates, ctx);

          this.pendingConfig = null;
          // 原地更新卡片：保存后卡片刷新为已保存状态（2026-07-04）
          // 2026-08-03: 卡片刷新失败不吞切换通知——保存已成功，仅记录日志，
          // 后续切换消息照常发送；真正写盘/传播阶段的失败才走外层 catch 报「保存失败」。
          try {
            // host 可能已变更 → 重新预取 DSH 目录（内部按 host 缓存，未变不重复拉）
            await this.prefetchConfigCardCatalogs();
            await this.bridge.updateCardInPlace(this.buildConfigCard().card!, ctx);
          } catch (refreshErr) {
            getLogger().warn(
              `[router] config.save 卡片刷新失败（保存已成功）: ${(refreshErr as Error).message}`,
            );
          }

          // 2026-08-13: agent 切换时发送 Resume 卡片（替代纯文本通知），
          // 让用户直观看到新 agent 的会话状态和历史。
          // 发送失败（resolve false）时兜底回退 toast 即时反馈。
          if (switchResult.notice) {
            const switchCard = this.buildConfigSwitchCard(switchResult, ctx);
            const sent = await this.bridge.sendResult(switchCard, ctx);
            if (!sent) {
              return {
                toast: { type: 'info', content: switchResult.notice },
              };
            }
          }
        } catch (err) {
          await this.bridge.sendResult({ text: `保存失败: ${(err as Error).message}` }, ctx);
        }
        return;
      }
      default:
        return;
    }
  }

  /** 设置嵌套属性值（仅修改内存对象，不写盘） */
  /** 在 pendingConfig 上按 dot-separated key 设置嵌套值（config 卡片编辑用）。 */
  setNestedValue(target: AppConfig, key: string, value: unknown): void {
    // Path mapping 共用 config 模块的 mapAgentKey（G11 Inconsistency 修复）：
    // pi.xxx/codex.xxx/opencode.xxx → agents.xxx，claude.xxx 保持顶层
    const mappedKey = mapAgentKey(key);
    const parts = mappedKey.split('.');
    // 复用 config 模块的 walkNestedContainer（含 __proto__/prototype/constructor
    // 守卫与中间段补 {}），router 只保留 value=undefined → delete 分支。
    const container = walkNestedContainer(target, parts, true);
    const lastPart = parts[parts.length - 1];
    assertSafeKeyPart(lastPart);
    if (value === undefined) {
      // value=undefined 表示"删除键"（如清空 reasoningEffort），
      // 不能写成 undefined 值——diffConfig 会把 undefined 转成字面量 "undefined"
      // 写入 config.yaml 并透传给 codex（ReasoningEffort::Custom("undefined")）。
      delete container![lastPart];
    } else {
      container![lastPart] = value;
    }
  }

  /** 对比原始 config 与 pendingConfig，返回变化的 key→string 映射 */
  /** config diff（public：测试直接调用，替代 as unknown as）。 */
  diffConfig(original: AppConfig, pending: AppConfig): Record<string, string | undefined> {
    const updates: Record<string, string | undefined> = {};
    this.collectDiff('', original, pending, updates);
    return updates;
  }

  /** 递归收集差异 */
  private collectDiff(
    prefix: string,
    original: unknown,
    pending: unknown,
    result: Record<string, string | undefined>,
  ): void {
    if (original === pending) return;
    // 如果 pending 是对象（非 null）但 original 不是对象，
    // 把 original 当作空对象递归进入 pending 内部，
    // 避免把整个对象转成 "[object Object]" 字符串
    if (
      typeof pending === 'object' &&
      pending !== null &&
      (typeof original !== 'object' || original === null)
    ) {
      const pendObj = pending as Record<string, unknown>;
      for (const k of Object.keys(pendObj)) {
        const newKey = prefix ? `${prefix}.${k}` : k;
        this.collectDiff(newKey, undefined, pendObj[k], result);
      }
      return;
    }
    if (
      typeof original !== 'object' ||
      typeof pending !== 'object' ||
      original === null ||
      pending === null
    ) {
      // 叶子节点，记录差异
      const key = prefix || 'root';
      // pending 为 undefined 表示键被删除，必须保留 undefined 语义，
      // 不能 String(pending) 成 "undefined"
      result[key] = pending === undefined ? undefined : String(pending);
      return;
    }
    // 两者都是对象，递归比较
    const origObj = original as Record<string, unknown>;
    const pendObj = pending as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(pendObj)]);
    for (const k of allKeys) {
      const newKey = prefix ? `${prefix}.${k}` : k;
      this.collectDiff(newKey, origObj[k], pendObj[k], result);
    }
  }

  /**
   * config 写盘后的运行时传播（P1-6：自 config.save 卡片路径抽出，卡片保存与
   * `/config <key> <value>` 文本直写两条路径共用）。
   *
   * 1. bridge 运行时值同步：setConfig + idle watchdog timeout；
   * 2. agent 配置或 defaultAgent 变更 → clearRunners（否则 runner 缓存继续用旧
   *    配置值，/status 与真实 run 自相矛盾）；
   * 3. defaultAgent 切换 → 旧 agent session 存 previousSessions、新 agent 恢复
   *    或清空（等效 /new）；
   * 4. 当前 agent 配置变更 → syncAgentChoices 并原子写盘（P1-7：禁裸同步写盘，
   *    写一半崩溃会截断 config.yaml 导致 bridge 起不来）。
   *
   * @param updates 以 config 路径形式给出的变更 key（卡片路径来自 diffConfig；
   *   直写路径传 mapAgentKey(key)，保证 pi./codex./opencode./kimi. 命中 agents.*）。
   * @returns 结构化切换结果（含 notice 文案 + 新 agent/sessionId 信息）
   */
  private propagateConfigSave(
    oldDefaultAgent: AgentKind,
    updates: Record<string, string | undefined>,
    ctx: CommandContext,
  ): ConfigSwitchResult {
    this.bridge.setConfig(this.config);
    // idle.watchdogMinutes 改动需同步到 bridge 的 idleTimeoutMs
    this.idleTimeoutMs = this.config.idle.watchdogMinutes * 60_000;
    this.bridge.setIdleTimeout(this.idleTimeoutMs);

    // 2026-07-13: 检测是否有任何 agent 配置变更或 defaultAgent 切换
    const hasDefaultAgentChange = oldDefaultAgent !== this.config.defaultAgent;
    const hasAgentConfigChange = Object.keys(updates).some(
      (k) =>
        k.startsWith('agents.') ||
        k.startsWith('claude.') ||
        k.startsWith('pi.') ||
        k.startsWith('codex.') ||
        k.startsWith('opencode.') ||
        k.startsWith('kimi.') ||
        k === 'defaultAgent' ||
        k === 'claude' ||
        k === 'pi' ||
        k === 'codex' ||
        k === 'opencode' ||
        k === 'kimi',
    );

    // 当 defaultAgent 改变时，清除旧 agent 的 sessionId，
    // 同时清除新 agent 的 sessionId（等效于 /new 命令），
    // 并支持 session 恢复 - 切换回来时如果条件满足则恢复之前的 session。
    let switchNotice: string | undefined;
    let switchNewAgent: AgentKind | undefined;
    let switchSessionId: string | undefined;
    if (hasDefaultAgentChange) {
      const newAgent = this.config.defaultAgent;
      switchNewAgent = newAgent;

      // Step 0: 在清空 old 之前计算「用户活动」基线差（arrival 基线）：
      const oldSessionId = this.sessionStore.getSessionId(ctx.userId, oldDefaultAgent);
      const oldArrivalSessionId = this.sessionStore.getArrivalSessionId(
        ctx.userId,
        oldDefaultAgent,
      );
      const userChangedOld = (oldSessionId ?? '') !== (oldArrivalSessionId ?? '');

      // Step 1: 保存旧 agent 的 session 到 previousSessions（如果有）
      if (oldSessionId) {
        this.sessionStore.setPreviousSessionId(ctx.userId, oldDefaultAgent, oldSessionId);
      }

      // Step 2: 清除旧 agent 的 session（保存后清除，为新会话腾出空间）
      this.sessionStore.clearSessionId(ctx.userId, oldDefaultAgent);

      // Step 2.5: 显式选择判定
      const newSessionId = this.sessionStore.getSessionId(ctx.userId, newAgent);
      const newArrivalSessionId = this.sessionStore.getArrivalSessionId(ctx.userId, newAgent);
      const userSelectedNew =
        !!newSessionId && (newSessionId ?? '') !== (newArrivalSessionId ?? '');

      // Step 3: 恢复判定
      const previousSessionId = this.sessionStore.getPreviousSessionId(ctx.userId, newAgent);
      const canRestore = !!previousSessionId && !userChangedOld;

      if (userSelectedNew) {
        this.sessionStore.setArrivalSessionId(ctx.userId, newAgent, newSessionId);
        const newAgentName = agentDisplayName(newAgent);
        switchNotice = `已切换到 ${newAgentName}，已使用所选 session，sessionId: ${newSessionId}`;
        switchSessionId = newSessionId!;
      } else if (canRestore) {
        this.sessionStore.setSessionId(ctx.userId, newAgent, previousSessionId);
        this.sessionStore.clearPreviousSessionId(ctx.userId, newAgent);
        this.sessionStore.setArrivalSessionId(ctx.userId, newAgent, previousSessionId);
        const newAgentName = agentDisplayName(newAgent);
        switchNotice = `已切换到 ${newAgentName}，将继续之前的 session，sessionId: ${previousSessionId}`;
        switchSessionId = previousSessionId;
      } else {
        this.sessionStore.clearSessionId(ctx.userId, newAgent, { clearSessionCwd: true });
        this.sessionStore.setArrivalSessionId(ctx.userId, newAgent, '');
        const newAgentName = agentDisplayName(newAgent);
        switchNotice = `已切换到 ${newAgentName}，session 已清空，下次消息将启动新对话`;
        switchSessionId = '';
      }
    }

    // DSH preset 变更 = 下次 run 新建 session（§4.3 D1）：
    // preset 在 session 创建时固定，中途切换会被服务端拒绝（agent-preset-conflict）。
    // 旧 sessionId 存入 previousSessions 停车位（可手动 /resume，但 /resume 会做
    // preset 一致性校验），当前 sessionId 清空——下次 run 走 session.create 新建。
    const hasDshPresetChange = Object.keys(updates).some((k) => k === 'agents.dsh.agentPreset');
    // 已发生 agent 切换时（switchNotice 已设置）preset 分支跳过，避免覆盖切换 notice；
    // 切换分支对 dsh 的 session 已做恢复/清空处理。
    if (hasDshPresetChange && this.config.defaultAgent === 'dsh' && !switchNotice) {
      const oldSessionId = this.sessionStore.getSessionId(ctx.userId, 'dsh');
      if (oldSessionId) {
        this.sessionStore.setPreviousSessionId(ctx.userId, 'dsh', oldSessionId);
        this.sessionStore.clearSessionId(ctx.userId, 'dsh');
        switchNotice = `DSH preset 已变更，旧会话已停放到恢复槽（可 /resume 校验后恢复），下次消息将新建会话`;
      } else {
        switchNotice = `DSH preset 已变更，下次消息将新建会话`;
      }
    }

    // DSH host 变更 = 换服务（CC-02）：旧 host 的 sessionId 发往新 host 是错的。
    // 视为 session 边界，仿 preset 分支停车 + 清空当前 sessionId，下次 run 新建会话。
    const hasDshHostChange = Object.keys(updates).some((k) => k === 'agents.dsh.host');
    if (hasDshHostChange && this.config.defaultAgent === 'dsh' && !switchNotice) {
      const oldSessionId = this.sessionStore.getSessionId(ctx.userId, 'dsh');
      if (oldSessionId) {
        this.sessionStore.setPreviousSessionId(ctx.userId, 'dsh', oldSessionId);
        this.sessionStore.clearSessionId(ctx.userId, 'dsh');
        switchNotice = `DSH host 已变更，旧会话已停放到恢复槽（可 /resume 校验后恢复），下次消息将新建会话`;
      } else {
        switchNotice = `DSH host 已变更，下次消息将新建会话`;
      }
    }

    // 2026-07-13: 同步 agent 配置到 agentChoices（用于切换 agent 时恢复配置）
    const currentAgent = this.config.defaultAgent;
    const currentAgentConfigKey = `agents.${currentAgent}`;
    const hasCurrentAgentUpdate = Object.keys(updates).some(
      (k) => k === currentAgentConfigKey || k.startsWith(`${currentAgentConfigKey}.`),
    );
    if (hasCurrentAgentUpdate) {
      this.config = syncAgentChoices(this.config, currentAgent);
      // P1-7：agentChoices 同步写盘必须走原子写（tmp+rename），禁裸同步写盘
      atomicWrite(this.configPath, YAML.stringify(this.config));
      this.bridge.setConfig(this.config);
    }

    // P1-6 + live approval settings (§P5): active workspace-lifetime runners
    // are not evicted by clearRunners() (would orphan the live subprocess).
    // Push the new approval-mode settings to those runners via the unified
    // duck method `updateApprovalMode` (codex thread/settings/update,
    // kimi/opencode session/set_mode) so they take effect for subsequent
    // turns without waiting for the runner to be recreated.
    const hasApprovalConfigChange = Object.keys(updates).some(
      (k) =>
        k === 'agents.codex' ||
        k.startsWith('agents.codex.') ||
        k === 'codex' ||
        k.startsWith('codex.') ||
        k === 'agents.kimi' ||
        k.startsWith('agents.kimi.') ||
        k === 'kimi' ||
        k.startsWith('kimi.') ||
        k === 'agents.opencode' ||
        k.startsWith('agents.opencode.') ||
        k === 'opencode' ||
        k.startsWith('opencode.'),
    );
    if (hasApprovalConfigChange) {
      this.bridge.syncActiveApprovalModes();
    }

    // 2026-07-13: 任何 agent 配置变更或 defaultAgent 切换，都清除 runner 缓存
    if (hasDefaultAgentChange || hasAgentConfigChange) {
      this.bridge.clearRunners();
    }

    return { notice: switchNotice, newAgent: switchNewAgent, sessionId: switchSessionId };
  }

  private async executeCommand(
    message: string,
    ctx: CommandContext,
  ): Promise<CommandResult | null> {
    const parts = message.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
      case 'h':
        return this.cmdHelp();
      case 'status':
      case 's':
        return this.cmdStatus(ctx);
      case 'ps':
        return this.cmdPs(ctx);
      case 'stop':
      case 't':
        return await this.cmdStop(ctx);
      case 'exit':
      case 'quit':
      case 'e':
        return await this.cmdExit();
      case 'restart':
        return this.cmdRestart();
      case 'new':
        return this.cmdNew(ctx);
      case 'cd':
        return this.cmdCd(args, ctx);
      case 'ls':
        return this.cmdLs(args, ctx);
      case 'ws':
        return this.cmdWs(args, ctx);
      case 'resume':
      case 'r':
        return this.cmdResume(args, ctx);
      case 'active':
        return this.cmdActive(args, ctx);
      case 'reconnect':
        return await this.cmdReconnect();
      case 'config':
      case 'c':
        return await this.cmdConfig(args, ctx);
      case 'order':
      case 'o':
        return this.cmdOrder(args, ctx);
      case 'update':
      case 'u':
        return await this.cmdUpdate(args, ctx);
      default:
        return { text: `未知命令 /${cmd}，输入 /help 查看可用命令` };
    }
  }

  // --- Command implementations ---

  cmdHelp(): CommandResult {
    // 按钮组（可直接点击触发；按钮 label 只保留子命令，不含参数）
    // 2026-07-04: /ws 子命令 (save|use|remove) 移到右侧文本说明，按钮只显示 /ws
    // 2026-07-04: 按钮 label 按长度升序排列（短在上，长在下），视觉更整齐
    const buttonCommands = [
      { cmd: 'help', label: '/help /h', desc: '显示此帮助' },
      { cmd: 'ps', label: '/ps', desc: '查看是否有 agent 进程在跑' },
      { cmd: 'new', label: '/new', desc: '清空当前 session（保留 cwd）' },
      { cmd: 'stop', label: '/stop /t', desc: '终止当前 Agent 进程' },
      { cmd: 'ws', label: '/ws', desc: 'workspace 管理（save|use|remove）' },
      { cmd: 'config', label: '/config /c', desc: '查看和修改配置（卡片交互）' },
      { cmd: 'active', label: '/active', desc: '查看所有正在进行中的 session' },
      { cmd: 'exit', label: '/exit /e', desc: '退出 bridge' },
      { cmd: 'restart', label: '/restart', desc: '重启 bridge（新进程，config 不变）' },
      { cmd: 'update', label: '/update /u', desc: '检查并升级到最新版本' },
      { cmd: 'status', label: '/status /s', desc: '显示当前状态' },
      { cmd: 'reconnect', label: '/reconnect', desc: '重连飞书' },
    ].sort((a, b) => a.label.length - b.label.length || a.cmd.localeCompare(b.cmd));

    // 文本组（需带参数，不宜用按钮；以纯文本行展示）
    const textCommands = [
      { cmd: 'cd', label: '/cd <path>', desc: '切换工作目录' },
      { cmd: 'ls', label: '/ls [dir]', desc: '列出当前目录，可指定子目录' },
      { cmd: 'resume', label: '/resume /r [agent] [list|id|N]', desc: '列出或切换 Agent session' },
      {
        cmd: 'order',
        label: '/order /o save|list|edit',
        desc: '收藏指令 /order save，编辑指令 /order edit <id|N> <新文本>，指令可起别名（卡片上 ＋别名）',
      },
    ];

    const bodyElements: object[] = [];

    // 按钮组 — CardKit 2.0: column_set + column + button with behaviors
    // 2026-07-04 对齐修复（方案 A）：两列都用 width:'weighted' + 固定 weight。
    // 根因：每行独立 column_set + width:'auto' → 列宽随按钮/文本内容变化 →
    // 跨行不对齐（按钮列右边界参差）。改用 weighted 后，每行 column_set
    // 总宽相同（同级 body.elements），weight 比例一致，列宽跨行恒等。
    // 2026-07-05 手机排版修复：weight 1:3 → 2:3。1:3 时按钮列只占 25%，
    // 手机窄屏（~330px 可用）下约 82px，容不下 `/reconnect`（10 字符 ≈ 100px），
    // 按钮文字被截断成 "..."。改 2:3 后按钮列占 40% ≈ 132px，足够显示
    // 最长的 /reconnect，文本列仍占 60% 足以放下描述。
    for (const c of buttonCommands) {
      bodyElements.push({
        tag: 'column_set',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 2,
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: c.label },
                type: 'default',
                size: 'small',
                behaviors: [{ type: 'callback', value: { cmd: `help.${c.cmd}` } }],
              },
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
          '**Agent**\n通过 `/config` → 默认 Agent 切换：Claude / Codex / Opencode / Pi / Kimi',
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

  /** /status 实现（public：测试直接调用，替代 as any）。 */
  cmdStatus(ctx: CommandContext): CommandResult {
    const entry = this.sessionStore.get(ctx.userId);
    const cwd = entry?.cwd ?? '(未设置)';
    const sessionId = entry?.sessions?.get(this.config.defaultAgent) ?? '(无)';
    // 查 bridge.activeRuns 而不是默认 runner.isRunning —— 因为 per-workspace
    // runner 启动的 run 不会反映到默认 runner 状态。
    const running = cwd !== '(未设置)' && this.bridge.isBusyFor(cwd);

    const logger = getLogger();
    const pid = process.pid;
    const configDir = getConfigDir();
    const logFile =
      typeof logger.getCurrentLogFile === 'function' ? logger.getCurrentLogFile() : '';

    // 构建 agent 状态信息
    const agentLines: string[] = [];
    if (cwd !== '(未设置)') {
      const runner = this.bridge.getCurrentRunner(cwd);
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
      const defaultAgent = this.config.defaultAgent;
      let model = 'N/A';
      if (defaultAgent === 'claude') {
        model = this.config.claude.model;
      } else if (this.config.agents?.[defaultAgent as keyof typeof this.config.agents]) {
        const agentConfig = this.config.agents[defaultAgent as keyof typeof this.config.agents];
        model = (agentConfig as { model?: string }).model ?? 'N/A';
      }
      agentLines.push(`agent: \`${defaultAgent}\``);
      agentLines.push(`model: \`${model}\``);
    }

    const sessionCwd = this.sessionStore.getSessionCwd(ctx.userId, this.config.defaultAgent);
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

  private cmdPs(ctx: CommandContext): CommandResult {
    const entry = this.sessionStore.get(ctx.userId);
    const cwd = entry?.cwd;
    if (!cwd) return { text: '请先 /cd 设置工作目录' };
    const agentName = agentDisplayName(this.config.defaultAgent);
    return {
      text: this.bridge.isBusyFor(cwd) ? `有 ${agentName} 进程在运行` : '当前无进程在跑',
    };
  }

  private async cmdStop(ctx: CommandContext): Promise<CommandResult | null> {
    const stopped = await this.bridge.interruptCurrentRun({
      userId: ctx.userId,
      chatId: ctx.chatId,
    });
    return stopped ? null : { text: '当前没有运行中的进程' };
  }

  private async cmdExit(): Promise<CommandResult> {
    // Signal handle() to invoke exitHandler after the reply is sent.
    this.pendingExit = true;
    return { text: 'bridge 正在退出...' };
  }

  private cmdRestart(): CommandResult {
    if (!this.restartSpawner) {
      return { text: '当前环境不支持 /restart' };
    }
    try {
      // 先 spawn detached 继任者（持锁期间完成，子进程经 env 等本进程退出后
      // 再走正常锁 acquire），成功后才借 pendingExit 走 /exit 同款干净退出
      // 链路——spawn 失败则旧进程保持存活，不会两头落空。
      const pid = this.restartSpawner();
      this.pendingExit = true;
      return { text: `♻️ bridge 重启中（新进程 pid ${pid}），启动通知稍后送达…` };
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
  private async cmdUpdate(args: string[], ctx: CommandContext): Promise<CommandResult> {
    const checkOnly = args[0] === 'check';

    // 1. Version query（/update check 始终绕过缓存，/update 用 TTL 缓存）
    let current: string;
    let latest: string;
    try {
      const result = await this.updateFns.checkLatestVersion({
        cachePath: this.updateCachePath,
        bypassCache: checkOnly,
      });
      current = result.current;
      latest = result.latest;
    } catch (err) {
      return { text: `❌ 版本检查失败: ${(err as Error).message}` };
    }

    if (!this.updateFns.isNewer(current, latest)) {
      return { text: `✅ 已是最新版本 ${current}` };
    }

    if (checkOnly) {
      return { text: `📦 有新版本 ${latest} 可用（当前 ${current}），发送 /update 升级` };
    }

    // 2. Dev mode guard
    if (this.devMode) {
      return { text: '⚠️ 开发模式不支持自更新，请 git pull 后重新构建' };
    }

    // 3. Install (send intermediate status before the blocking operation)
    await this.bridge.sendResult({ text: `⬆️ 正在升级 ${current} → ${latest} ...` }, ctx);
    const installResult = await this.updateFns.runInstallLatest();

    if (!installResult.success) {
      return { text: `❌ 升级失败: ${installResult.error}` };
    }

    // 4. Report success (no auto-restart — user decides when to /restart)
    return { text: `✅ 升级成功 (${current} → ${latest})，发送 /restart 重启后生效` };
  }

  private cmdNew(ctx: CommandContext): CommandResult {
    // 只清 sessionId 保留 cwd — 否则 /new 之后 /resume 会提示"请先 /cd
    // 设置工作目录"，但用户的 workspace 还在。2026-06-21 复盘：用户
    // /new → /resume 后被误导以为需要重新 /cd。
    const agentName = agentDisplayName(this.config.defaultAgent);
    this.sessionStore.clearSessionId(ctx.userId, this.config.defaultAgent, {
      clearSessionCwd: true,
    });
    return { text: `已清空 ${agentName} session，下次消息将启动新对话` };
  }

  private cmdCd(args: string[], ctx: CommandContext): CommandResult {
    const target = args[0];
    if (!target) {
      const cwd = this.sessionStore.getCwd(ctx.userId) ?? '(未设置)';
      return { text: `当前目录: ${cwd}` };
    }

    // Resolve path (support ~, absolute, and relative paths)
    const currentCwd = this.sessionStore.getCwd(ctx.userId) ?? process.cwd();
    const expanded = target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;
    const resolved = path.resolve(currentCwd, expanded);

    if (!fs.existsSync(resolved)) {
      return { text: `路径不存在: ${resolved}` };
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { text: `不是目录: ${resolved}` };
    }

    // Canonicalize via realpath so it matches the symlink-resolved cwd that
    // Claude writes into JSONL (e.g. `/tmp` → `/private/tmp` on macOS).
    // Without this, a hand-typed unresolved path never matches any JSONL's
    // cwd field and the user's `/cd /tmp/foo` never finds their sessions.
    // TOCTOU: the directory may vanish between stat and realpath (review P2-1).
    // Reject gracefully instead of letting realpathSync throw into the queue
    // task's .catch (which only logs — the user gets no feedback). Mirrors
    // handleLsSwitch's realpath guard so /cd and ls.switch behave identically.
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
    } catch {
      return { text: `路径无效: ${resolved}` };
    }

    // Switch cwd with auto-resume and user feedback (shared with /ws use and ls.switch)
    return this.switchCwdAndNotify(ctx.userId, canonical, ctx);
  }

  private readSessionDisplayState(
    sessionId: string,
    cwd: string,
    opts?: { agentKind?: string; maxEvents?: number },
  ): {
    events: AgentSessionContentEvent[];
    usage?: SessionDisplayUsage;
    isActive: boolean;
    aiTitle?: string;
    recap?: string;
    displayTitle?: string;
    /** runId of the in-process activeRun, when activeRunning is true.
     * Used to bind the stop button to the real UUID runId (not sessionId),
     * since bridge.interruptCurrentRun matches on active.runId. */
    activeRunRunId?: string;
  } {
    // Use the appropriate session reader based on agentKind
    let reader = this.sessionReader;
    const agentKind = opts?.agentKind;
    if (agentKind && agentKind !== this.config.defaultAgent) {
      reader = this.sessionReaderRegistry.get(agentKind as AgentKind);
    }

    const { events, usage, aiTitle, recap, displayTitle } = reader.readSessionContent(
      sessionId,
      cwd,
      { maxEvents: opts?.maxEvents },
    );
    const activeRun = this.bridge.getActiveRunFor(cwd);
    // 只检查内存中的 activeRun 状态
    // 只有当 activeRun 存在且不是终态时，才认为任务仍在进行中
    const activeRunning =
      activeRun !== undefined &&
      activeRun.terminal !== 'done' &&
      activeRun.terminal !== 'error' &&
      activeRun.terminal !== 'interrupted' &&
      activeRun.terminal !== 'idle_timeout' &&
      activeRun.sessionId === sessionId;
    const activeUsage = activeRunUsage(activeRun);
    return {
      events,
      usage: activeRunning ? (activeUsage ?? usage) : usage,
      // 只使用内存中 activeRun 的状态
      isActive: activeRunning,
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
  private switchCwdAndNotify(
    userId: string,
    canonical: string,
    _ctx: CommandContext,
  ): CommandResult {
    this.sessionStore.setCwd(userId, canonical);
    // Auto-resume newest session if exists (P1-15: 读取失败不阻断切换，给可见提示)
    let newestSession: AgentSession | null;
    try {
      newestSession = this.sessionReader.getNewestSession(canonical);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `已切换到: ${canonical}\n（自动恢复失败: ${msg}）` };
    }
    if (newestSession) {
      this.sessionStore.setSessionIdAndCwd(
        userId,
        this.config.defaultAgent,
        newestSession.sessionId,
        canonical,
      );
      return this.buildAutoResumeCard(canonical, newestSession, _ctx);
    }
    return { text: `已切换到: ${canonical}` };
  }

  /** Build card for auto-resumed session with new session button */
  private buildAutoResumeCard(
    cwd: string,
    session: { sessionId: string; summary: string },
    _ctx: CommandContext,
  ): CommandResult {
    const agentName = agentDisplayName(this.config.defaultAgent);
    const {
      events: content,
      usage,
      isActive,
      aiTitle,
      recap,
      displayTitle,
      activeRunRunId,
    } = this.readSessionDisplayState(session.sessionId, cwd, { maxEvents: AUTO_RESUME_MAX_EVENTS });

    const actions = this.buildResumeActionButtons({
      isActive,
      activeRunRunId,
      cwd,
      compact: this.canCompactSession(this.config.defaultAgent, cwd)
        ? { sessionId: session.sessionId, agentKind: this.config.defaultAgent }
        : undefined,
      newSession: true,
    });

    const card = buildSessionHistoryCard(
      {
        sessionId: session.sessionId,
        cwd,
        displayTitle,
        aiTitle,
        recap,
        events: content,
        usage,
      },
      {
        agentKind: this.config.defaultAgent,
        headerText: `📂 \`${cwd}\`\n已恢复最近会话: **${session.sessionId}**`,
        title: `${isActive ? '⏳ 自动恢复会话（完成中）' : '🔁 自动恢复会话'} · ${agentName}`,
        usageResult: 'success',
        actions,
      },
    );

    return { card };
  }

  /**
   * Build card for config.save agent switch.
   * When the new agent has a restored session, renders a Resume card (mirrors
   * buildAutoResumeCard) with session history + stop/new buttons.
   * When the session was cleared, renders a compact notice card instead.
   */
  private buildConfigSwitchCard(
    switchResult: ConfigSwitchResult,
    ctx: CommandContext,
  ): CommandResult {
    const newAgent = switchResult.newAgent!;
    const agentName = agentDisplayName(newAgent);
    const cwd = this.sessionStore.getCwd(ctx.userId);
    const sessionId = switchResult.sessionId;

    // No cwd or no session → compact notice card (no new-session button: the
    // next message already starts a fresh session, a button would mislead
    // users into thinking a click is required)
    if (!cwd || !sessionId) {
      const elements: object[] = [markdownDiv(switchResult.notice!)];
      return {
        card: {
          schema: '2.0',
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: `🔀 切换到 ${agentName}` },
          },
          body: { elements },
        },
      };
    }

    // Has session → Resume card (mirrors buildAutoResumeCard)
    // Guard: if the session reader for the new agent is not available (e.g. agent
    // not registered), fall back to compact notice card to avoid NPE.
    const readerForNewAgent =
      newAgent === this.config.defaultAgent
        ? this.sessionReader
        : this.sessionReaderRegistry.get(newAgent);
    if (!readerForNewAgent) {
      // Fallback: compact notice card with the notice text
      const elements: object[] = [markdownDiv(switchResult.notice!)];
      elements.push({
        tag: 'column_set',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [newSessionButton()],
          },
        ],
      });
      return {
        card: {
          schema: '2.0',
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `🔀 切换到 ${agentName}` } },
          body: { elements },
        },
      };
    }

    const {
      events: content,
      usage,
      isActive,
      aiTitle,
      recap,
      displayTitle,
      activeRunRunId,
    } = this.readSessionDisplayState(sessionId, cwd, {
      agentKind: newAgent,
      maxEvents: AUTO_RESUME_MAX_EVENTS,
    });

    // Action buttons: stop (active) + new session
    const actions = this.buildResumeActionButtons({
      isActive,
      activeRunRunId,
      cwd,
      newSession: true,
    });

    const card = buildSessionHistoryCard(
      {
        sessionId,
        cwd,
        displayTitle,
        aiTitle,
        recap,
        events: content,
        usage,
      },
      {
        agentKind: newAgent,
        headerText: `📂 \`${cwd}\`\n已恢复会话: **${sessionId}**`,
        title: `${isActive ? '⏳ 切换 Agent（完成中）' : '🔀 切换 Agent'} · ${agentName}`,
        usageResult: 'success',
        emptyPlaceholder: '_该会话暂无新消息可显示（最后一条为用户输入）_',
        actions,
      },
    );

    return { card };
  }

  /**
   * Whether a session of the given agent kind can be compacted from a resume
   * card. Design doc §6.2-2: duck-typing — check if the runner has `runCompact`
   * (codex app-server, kimi acp), instead of hardcoding agentKind === 'codex'.
   */
  private canCompactSession(agentKind: string, cwd?: string): boolean {
    if (!cwd) return false;
    return this.bridge.hasRunCompact(cwd, agentKind as AgentKind);
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
  private buildResumeActionButtons(opts: {
    isActive: boolean;
    activeRunRunId?: string;
    cwd: string;
    compact?: { sessionId: string; agentKind: string };
    newSession?: boolean;
  }): object[] {
    const actions: object[] = [];
    if (opts.isActive) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '⏹ 终止' },
        type: 'danger',
        behaviors: [
          {
            type: 'callback',
            value: { cmd: 'stop', runId: opts.activeRunRunId, cwd: opts.cwd },
          },
        ],
      } as { tag: string; text: object; type: string; behaviors: object[] });
    }
    if (opts.compact && !opts.isActive) {
      actions.push(resumeCompactButton(opts.compact.sessionId, opts.compact.agentKind));
    }
    if (opts.newSession) {
      actions.push(
        newSessionButton() as { tag: string; text: object; type: string; behaviors: object[] },
      );
    }
    return actions;
  }

  private static readonly LS_PAGE_SIZE = 30;

  /** /ls 实现（public：测试直接调用，替代 as unknown as）。 */
  cmdLs(args: string[], ctx: CommandContext, offset = 0): CommandResult {
    const cwd = this.sessionStore.getCwd(ctx.userId);
    if (!cwd) {
      return { text: '请先使用 /cd <path> 设置工作目录' };
    }

    // args can be:
    // - [] : list current cwd
    // - [dirName] : list subdirectory if it exists
    let targetDir = cwd;

    if (args[0]) {
      // Expand tilde to home directory (path.resolve does not handle ~)
      if (args[0].startsWith('~')) {
        args[0] = path.join(os.homedir(), args[0].slice(1));
      }
      // path.resolve (not path.join) so absolute args[0] is honored as-is
      // instead of being concatenated onto cwd (which broke /ls card nav).
      const potentialDir = path.resolve(cwd, args[0]);
      if (!fs.existsSync(potentialDir)) {
        return { text: `ls: ${args[0]}: No such file or directory` };
      }
      if (!fs.statSync(potentialDir).isDirectory()) {
        return { text: `ls: ${args[0]}: Not a directory` };
      }
      targetDir = potentialDir;
    }

    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });

      // Separate directories and files
      const dirs = entries
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

      // Merge dirs and files for pagination, preserving type info
      const allItems: Array<{ name: string; isDir: boolean; size?: number }> = [
        ...dirs.map((d) => ({ name: d.name, isDir: true })),
        ...files.map((f) => ({
          name: f.name,
          isDir: false,
          size: fs.statSync(path.join(targetDir, f.name)).size,
        })),
      ];

      // Pagination calculations
      const totalCount = allItems.length;
      const totalPages = Math.max(1, Math.ceil(totalCount / CommandRouter.LS_PAGE_SIZE));
      const currentPage = Math.floor(offset / CommandRouter.LS_PAGE_SIZE) + 1;
      const pageItems = allItems.slice(offset, offset + CommandRouter.LS_PAGE_SIZE);
      const hasPagination = totalCount > CommandRouter.LS_PAGE_SIZE;

      // Check if we need to show parent directory button
      const parentDir = path.dirname(targetDir);
      const hasParent = parentDir !== targetDir;
      const isSubdir = targetDir !== cwd;

      // Build header with parent button
      const headerElements: object[] = [];
      if (hasParent) {
        headerElements.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '上级' },
          type: 'default',
          size: 'small',
          behaviors: [{ type: 'callback', value: { cmd: 'ls.browse', path: parentDir } }],
        });
      }
      // Show "返回" button when viewing a subdirectory
      if (isSubdir) {
        headerElements.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '返回' },
          type: 'default',
          size: 'small',
          behaviors: [{ type: 'callback', value: { cmd: 'ls.browse', path: cwd } }],
        });
      }
      headerElements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '刷新' },
        type: 'default',
        size: 'small',
        behaviors: [{ type: 'callback', value: { cmd: 'ls.refresh', path: targetDir, offset } }],
      });
      // Show "切换" button when viewing a subdirectory (to switch cwd to this directory)
      if (isSubdir) {
        headerElements.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '切换' },
          type: 'primary',
          size: 'small',
          behaviors: [{ type: 'callback', value: { cmd: 'ls.switch', path: targetDir } }],
        });
      }

      const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
      };

      // Helper to create directory button - use targetDir
      const dirButton = (name: string): object => ({
        tag: 'button',
        text: { tag: 'plain_text', content: `📁 ${name}` },
        type: 'default',
        behaviors: [
          { type: 'callback', value: { cmd: 'ls.browse', path: path.join(targetDir, name) } },
        ],
      });

      // Helper to create file button with size - use targetDir
      const fileButton = (name: string, size?: number): object => {
        const sizeStr = size !== undefined ? ` (${formatSize(size)})` : '';
        return {
          tag: 'button',
          text: { tag: 'plain_text', content: `📄 ${name}${sizeStr}` },
          type: 'default',
          size: 'small',
          behaviors: [
            { type: 'callback', value: { cmd: 'ls.file', path: path.join(targetDir, name) } },
          ],
        };
      };

      // Build each section's elements (no tabs - use section headers)
      // Note: div+elements is not supported in CardKit 2.0, use column_set instead
      const elements: object[] = [];

      // Status line showing directory contents count (with pagination info)
      const status = hasPagination
        ? `\n共 ${dirs.length} 目录, ${files.length} 文件 · 第 ${currentPage}/${totalPages} 页（共 ${totalCount} 项）`
        : `\n共 ${dirs.length} 目录, ${files.length} 文件`;

      // Header info + navigation buttons - show targetDir in header
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `\`${targetDir}\`${status}` } });
      elements.push({
        tag: 'column_set',
        columns: headerElements.map((e) => ({ tag: 'column', width: 'auto', elements: [e] })),
      });
      elements.push({ tag: 'hr' });

      // Section 1: Directories (show only items on current page)
      const pageDirs = pageItems.filter((i) => i.isDir);
      const pageFiles = pageItems.filter((i) => !i.isDir);

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**📂 目录 (${dirs.length})**` },
      });
      if (pageDirs.length > 0) {
        for (const d of pageDirs) {
          elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            columns: [{ tag: 'column', width: 'auto', elements: [dirButton(d.name)] }],
          });
        }
      } else if (dirs.length === 0) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: '无子目录' } });
      } else {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `（第 ${currentPage} 页无目录）` },
        });
      }
      elements.push({ tag: 'hr' });

      // Section 2: Files
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**📄 文件 (${files.length})**` },
      });
      if (pageFiles.length > 0) {
        for (const f of pageFiles) {
          elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            columns: [{ tag: 'column', width: 'auto', elements: [fileButton(f.name, f.size)] }],
          });
        }
      } else if (files.length === 0) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: '无文件' } });
      } else {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `（第 ${currentPage} 页无文件）` },
        });
      }

      // Pagination bar (only shown when there are more items than PAGE_SIZE)
      if (hasPagination) {
        const bar = paginationBar({
          cmd: 'ls.page',
          offset,
          pageSize: CommandRouter.LS_PAGE_SIZE,
          total: totalCount,
          extra: { path: targetDir },
          label: `**第 ${currentPage}/${totalPages} 页**（共 ${totalCount} 项）`,
        });
        elements.push({ tag: 'hr' });
        elements.push(bar);
      }

      return {
        card: {
          schema: '2.0',
          config: { wide_screen_mode: true, update_multi: true },
          header: {
            title: { tag: 'plain_text', content: `📁 ${path.basename(targetDir)}` },
            template: 'blue',
          },
          body: {
            elements,
          },
        },
      };
    } catch (err) {
      return { text: `读取目录失败: ${(err as Error).message}` };
    }
  }

  private cmdWs(args: string[], ctx: CommandContext, offset = 0): CommandResult {
    const sub = args[0]?.toLowerCase();

    switch (sub) {
      case 'save': {
        const name = args[1];
        if (!name) return { text: '用法: /ws save <name>' };
        const cwd = this.sessionStore.getCwd(ctx.userId);
        if (!cwd) return { text: '请先 /cd 设置工作目录' };
        this.workspaceStore.save(name, cwd);
        return { text: `已保存 workspace "${name}" -> ${cwd}` };
      }
      case 'use': {
        const name = args[1];
        if (!name) return { text: '用法: /ws use <name>' };
        const wsPath = this.workspaceStore.get(name);
        if (!wsPath) return { text: `workspace "${name}" 不存在` };
        if (!fs.existsSync(wsPath)) return { text: `路径不存在: ${wsPath}` };
        // Canonicalize via realpath so it matches Claude JSONL cwd (2026-06-21).
        // TOCTOU guard (review P2-1): mirror cmdCd — if the path vanishes
        // between existsSync and realpath, reply gracefully instead of
        // throwing into the queue task's silent .catch.
        let canonical: string;
        try {
          canonical = fs.realpathSync(wsPath);
        } catch {
          return { text: `路径无效: ${wsPath}` };
        }
        // Record usage timestamp AFTER successful path validation
        this.workspaceStore.touch(name);
        // Switch cwd with auto-resume and user feedback (shared with /cd and ls.switch)
        return this.switchCwdAndNotify(ctx.userId, canonical, ctx);
      }
      case 'remove': {
        const name = args[1];
        if (!name) return { text: '用法: /ws remove <name>' };
        if (!this.workspaceStore.has(name)) return { text: `workspace "${name}" 不存在` };
        this.workspaceStore.remove(name);
        return { text: `已删除 workspace "${name}"` };
      }
      case 'list':
      default: {
        const entries = this.workspaceStore.list();
        const currentCwd = this.sessionStore.getCwd(ctx.userId);
        const sortMode = this.wsSortPreference.get(ctx.userId) ?? 'recent';

        // Sort entries by the current preference (view concern, not stored)
        if (sortMode === 'recent') {
          // Most recently used first; same lastUsedAt → alphabetical by name (deterministic)
          entries.sort((a, b) => {
            if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
            return a.name.localeCompare(b.name);
          });
        } else {
          // Alphabetical by alias name
          entries.sort((a, b) => a.name.localeCompare(b.name));
        }

        // Pagination calculations (mirror cmdOrder): clamp stale/out-of-range
        // offsets so prev/next always step by WS_PAGE_SIZE.
        const totalCount = entries.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / WS_PAGE_SIZE));
        const maxOffset = Math.max(0, (totalPages - 1) * WS_PAGE_SIZE);
        const safeOffset = clampInt(offset, 0, maxOffset);
        const currentPage = Math.floor(safeOffset / WS_PAGE_SIZE) + 1;
        const pageEntries = entries.slice(safeOffset, safeOffset + WS_PAGE_SIZE);
        const hasPagination = totalCount > WS_PAGE_SIZE;

        // Build body elements: current cwd + workspace list with dividers
        const bodyElements: object[] = [];

        // Current working directory section
        bodyElements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `📂 当前工作目录：\`${currentCwd ?? '(未设置)'}\`` },
        });

        if (entries.length === 0) {
          bodyElements.push({ tag: 'hr' });
          bodyElements.push({
            tag: 'div',
            text: { tag: 'lark_md', content: '没有保存的 workspace' },
          });
        } else {
          // Sort mode indicator + toggle button: placed above the list so the user
          // sees "current mode" and "switch to X" before scanning entries.
          // On narrow (mobile) screens, the label and button must convey both
          // what-is-active and what-clicking-does to avoid ambiguity.
          const currentLabel = sortMode === 'recent' ? '🕐 最近使用' : '🔤 字母顺序';
          const switchLabel = sortMode === 'recent' ? '🔤 字母顺序' : '🕐 最近使用';
          bodyElements.push({ tag: 'hr' });
          bodyElements.push({
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                vertical_align: 'center',
                elements: [
                  {
                    tag: 'div',
                    text: { tag: 'lark_md', content: `排序：${currentLabel}` },
                  },
                ],
              },
              {
                tag: 'column',
                width: 'auto',
                elements: [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: `切换为 ${switchLabel}` },
                    type: 'default',
                    size: 'small',
                    behaviors: [{ type: 'callback', value: { cmd: 'ws.sort' } }],
                  },
                ],
              },
            ],
          });
          bodyElements.push({ tag: 'hr' });

          for (const entry of pageEntries) {
            bodyElements.push({
              tag: 'div',
              text: { tag: 'lark_md', content: `**${entry.name}** → \`${entry.path}\`` },
            });
            // Use column_set+column for 2.0 (action tag not supported in 2.0)
            bodyElements.push({
              tag: 'column_set',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      text: { tag: 'plain_text', content: '切换' },
                      type: 'primary',
                      size: 'small',
                      behaviors: [
                        {
                          type: 'callback',
                          value: { cmd: 'ws.use', name: entry.name, offset: safeOffset },
                        },
                      ],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      text: { tag: 'plain_text', content: '删除' },
                      type: 'danger',
                      size: 'small',
                      behaviors: [
                        {
                          type: 'callback',
                          value: { cmd: 'ws.remove', name: entry.name, offset: safeOffset },
                        },
                      ],
                    },
                  ],
                },
              ],
            });
            bodyElements.push({ tag: 'hr' });
          }
          bodyElements.pop();

          // Pagination bar — separate row below the list (not crowded with sort
          // toggle; mobile-friendly vertical layout).
          if (hasPagination) {
            const bar = paginationBar({
              cmd: 'ws.page',
              offset: safeOffset,
              pageSize: WS_PAGE_SIZE,
              total: totalCount,
              label: `**${currentPage}/${totalPages}**（${totalCount}）`,
              prevText: '⬅',
              nextText: '➡',
            });
            bodyElements.push({ tag: 'hr' });
            bodyElements.push(bar);
          }
        }

        const card = {
          schema: '2.0',
          config: { wide_screen_mode: true, update_multi: true },
          header: { title: { tag: 'plain_text', content: 'Workspaces' } },
          body: { elements: bodyElements },
        };
        return { card };
      }
    }
  }

  /**
   * L3: degraded card when a session's export is non-empty but unparseable
   * (truncated by opencode's pipe cap on huge sessions, or otherwise corrupt).
   * The session exists, so reuse listSessions metadata (title) instead of the
   * misleading "未找到". Reuses the same card-builder helpers (markdownDiv) as
   * the normal resume card; enforceCardBudget still applies at send time.
   */
  /**
   * /resume 核心实现（public：handleResumePage / handle / resume.use 共用，
   * 也是测试的直接 seam，避免测试用 @ts-expect-error 摸私有方法）。
   */
  /**
   * DSH /resume preset 一致性校验：返回 mismatch 详情，或 undefined（一致/不可判定）。
   *
   * session 的 preset 在创建时固定（§2.1）。通过 listSessions 拿到目标 session 的
   * agentPreset 与当前配置比对：不一致时不静默复用（返回提示），一致或查询失败
   * （无法判定）时不阻断，避免 DSH 离线导致 /resume 完全不可用。
   */
  private dshPresetMismatch(
    reader: AgentSessionReader,
    sessionId: string,
    cwd: string,
  ): { sessionPreset: string; currentPreset: string } | undefined {
    const currentPreset = this.config.agents?.dsh?.agentPreset;
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

  cmdResume(args: string[], ctx: CommandContext, offset = 0): CommandResult {
    const entry = this.sessionStore.get(ctx.userId);
    const cwd = entry?.cwd;

    // Valid agent kinds for the /resume [agent] [N] feature
    const VALID_AGENTS = CommandRouter.VALID_AGENTS;
    type ValidAgent = (typeof VALID_AGENTS)[number];

    // Parse arguments: /resume [agent] [N] or /resume [sessionId] or /resume [agent] [sessionId]
    let agentKind: ValidAgent = this.config.defaultAgent as ValidAgent;
    let limit: number | undefined;
    let sessionIdArg: string | undefined;

    if (args[0]) {
      if (VALID_AGENTS.includes(args[0] as ValidAgent)) {
        agentKind = args[0] as ValidAgent;
        if (args[1]) {
          if (/^\d+$/.test(args[1])) {
            limit = parseInt(args[1], 10);
          } else {
            sessionIdArg = args[1];
          }
        }
      } else if (/^\d+$/.test(args[0])) {
        limit = parseInt(args[0], 10);
      } else {
        sessionIdArg = args[0];
      }
    }

    // `/resume <sessionId>` — manually set session id (needs an existing cwd to bind to)
    if (sessionIdArg) {
      if (!entry || !cwd) return { text: '请先 /cd 设置工作目录' };

      const reader =
        agentKind !== this.config.defaultAgent
          ? this.sessionReaderRegistry.get(agentKind as AgentKind)
          : this.sessionReader;

      const verifyContent = reader.readSessionContent(sessionIdArg, cwd);

      // If session doesn't exist, reject the write
      if (
        verifyContent.events.length === 0 &&
        !verifyContent.usage &&
        !verifyContent.aiTitle &&
        !verifyContent.recap &&
        !verifyContent.displayTitle
      ) {
        return {
          text: `未找到 session ${sessionIdArg}（当前目录: ${cwd}）。请确认该 session 属于此目录，或先 /cd 到正确目录。`,
        };
      }

      // DSH preset 一致性校验（§6 风险 1）：session 的 preset 在创建时固定，
      // 若与当前配置不符，直接复用会让后续 run 报 agent-preset-conflict。
      // 不静默复用——明确提示用户，由用户决定是否继续（配置里手动改/清 preset）。
      if (agentKind === 'dsh' && this.config.defaultAgent === 'dsh') {
        const presetMismatch = this.dshPresetMismatch(reader, sessionIdArg, cwd);
        if (presetMismatch) {
          return {
            text:
              `⚠️ 该 DSH session 的 preset 是「${presetMismatch.sessionPreset}」，与当前配置「${presetMismatch.currentPreset}」不一致。\n` +
              `preset 在 session 创建时固定，无法中途切换（DSH 返回 agent-preset-conflict）。\n` +
              `继续恢复将在下次 run 失败。请在 /config 中把预设模式改回「${presetMismatch.sessionPreset}」后重试，或保持当前配置并发新消息新建会话。`,
          };
        }
      }

      // L3: 校验通过后才写入
      this.sessionStore.setSessionId(ctx.userId, agentKind, sessionIdArg, cwd);

      const {
        events: content,
        usage,
        isActive,
        aiTitle,
        recap,
        displayTitle,
        activeRunRunId,
      } = this.readSessionDisplayState(sessionIdArg, cwd, {
        agentKind,
        maxEvents: AUTO_RESUME_MAX_EVENTS,
      });

      // Action buttons: stop (active) + compact (capable runner, not running) + new session
      const actions = this.buildResumeActionButtons({
        isActive,
        activeRunRunId,
        cwd,
        compact: this.canCompactSession(agentKind, cwd)
          ? { sessionId: sessionIdArg, agentKind }
          : undefined,
        newSession: true,
      });

      const card = buildSessionHistoryCard(
        {
          sessionId: sessionIdArg,
          cwd,
          displayTitle,
          aiTitle,
          recap,
          events: content,
          usage,
        },
        {
          agentKind,
          headerText: `📂 \`${cwd}\`\n会话: **${sessionIdArg}**`,
          title: `${isActive ? '⏳ 恢复会话（完成中）' : '🔁 恢复会话'} · ${agentDisplayName(agentKind)}`,
          usageResult: 'success',
          emptyPlaceholder: '_该会话暂无新消息可显示（最后一条为用户输入）_',
          actions,
        },
      );

      return { card };
    }

    // `/resume` or `/resume list` or `/resume <N>` — list sessions for the current cwd as a card
    // Use agentKind to select the appropriate sessionReader
    if (!cwd) return { text: '请先 /cd 设置工作目录' };
    const pageSize = clampInt(limit ?? RESUME_PAGE_SIZE, 1, RESUME_PAGE_SIZE);
    let reader: AgentSessionReader;
    // Use this.sessionReader when agentKind matches default, otherwise get from registry
    if (agentKind === this.config.defaultAgent) {
      reader = this.sessionReader;
    } else {
      reader = this.sessionReaderRegistry.get(agentKind);
    }

    // Fetch the requested page. If the offset is stale (sessions added/removed
    // since the page was rendered), clamp it to the last valid page start and
    // re-fetch so the card never shows a misaligned/empty page.
    let pageOffset = offset;
    let pageResult: { sessions: AgentSession[]; total: number };
    try {
      pageResult = reader.listSessions(cwd, { limit: pageSize, offset: pageOffset });
      // 末页起点对齐页边界（(总页数-1)*pageSize，如 25 条/页 20 → offset 20），
      // 这样越界 offset clamp 后 prev/next 仍按 pageSize 步长移动，不会错位。
      const maxOffset = Math.max(0, Math.ceil(pageResult.total / pageSize) - 1) * pageSize;
      if (pageOffset < 0 || pageOffset > maxOffset) {
        pageOffset = clampInt(pageOffset, 0, maxOffset);
        pageResult = reader.listSessions(cwd, { limit: pageSize, offset: pageOffset });
      }
    } catch (err) {
      // P1-15: 读取失败必须给用户可见反馈，而不是误导性的「没有 session 记录」
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `读取 ${agentDisplayName(agentKind)} session 列表失败: ${msg}` };
    }
    const { sessions: allSessions, total } = pageResult;

    if (allSessions.length === 0) {
      const agentName = agentDisplayName(agentKind);
      const hint =
        agentKind === this.config.defaultAgent
          ? `\n提示：可使用 /resume <agent> 切换查看其他 Agent 的 session`
          : '';
      return { text: `当前目录没有 ${agentName} session 记录\n${cwd}${hint}` };
    }

    // Pre-fetch aiTitle/recap/displayTitle only for the first few rows —
    // full reads are expensive (whole-file JSONL scan). Remaining rows fall
    // back to the lightweight summary already returned by listSessions.
    const sessionMeta = new Map<
      string,
      { aiTitle?: string; recap?: string; displayTitle?: string }
    >();
    const prefetchCount = Math.min(RESUME_CONTENT_PREFETCH, allSessions.length);
    for (const s of allSessions.slice(0, prefetchCount)) {
      // Use the same reader as the listSessions call above
      const content = reader.readSessionContent(s.sessionId, cwd);
      sessionMeta.set(s.sessionId, {
        aiTitle: content.aiTitle,
        recap: content.recap,
        displayTitle: content.displayTitle,
      });
    }

    const now = Date.now();
    function formatRelativeTime(mtimeMs: number): string {
      const diffSec = Math.floor((now - mtimeMs) / 1000);
      if (diffSec < 60) return '刚刚';
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
      if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} 天前`;
      return new Date(mtimeMs).toLocaleDateString('zh-CN');
    }

    const elements: object[] = [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `📂 当前工作目录：\`${cwd}\`` },
      },
    ];

    // Get current sessionId for the agent being listed
    const currentId = entry?.sessions?.get(agentKind) ?? '';

    for (const s of allSessions) {
      // Only mark as current if we're listing the defaultAgent's sessions
      const isCurrent = agentKind === this.config.defaultAgent && s.sessionId === currentId;
      const timeStr = formatRelativeTime(s.mtime);
      const buttonText = isCurrent ? '✓ 当前会话' : '恢复此会话';
      const meta = sessionMeta.get(s.sessionId);
      // Title priority:
      // 1. Prefetched displayTitle (aiTitle or last user message) keeps its
      //    original label (AI 标题 / 最近输入).
      // 2. Otherwise the lightweight summary renders under the neutral
      //    "会话摘要" label — summary is the first user message, not the
      //    last input, so "最近输入" would be semantically wrong.
      // 3. Placeholder summaries (no user message) render no title section
      //    at all — never leak '(无摘要)'/'(no user message)'/'New Session'.
      const summaryIsPlaceholder = RESUME_SUMMARY_PLACEHOLDERS.has(s.summary.trim());
      const prefetchedTitle = meta?.displayTitle;
      // aiTitle 不能单独作为"预取标题"键：若 displayTitle 缺失（理论上 opencode
      // info.title 非空但 export 无 user text），标题兜底是 summary，label 必须
      // 是中性"会话摘要"而不是"最近输入"（Review R3 P2-1 边缘分支）。
      const titleText = prefetchedTitle ?? (summaryIsPlaceholder ? '' : s.summary);
      const titleLabel = prefetchedTitle
        ? meta?.aiTitle
          ? 'AI 标题'
          : '最近输入'
        : summaryIsPlaceholder
          ? ''
          : '会话摘要';
      const sections: string[] = [];
      if (titleText) {
        sections.push(
          `🏷️ **${titleLabel}**\n${titleText.slice(0, 80)}${titleText.length > 80 ? '...' : ''}`,
        );
      }
      if (meta?.recap) {
        sections.push(
          `📝 **Recap**\n${meta.recap.slice(0, 60)}${meta.recap.length > 60 ? '...' : ''}`,
        );
      }
      const infoStr = sections.length > 0 ? '\n' + sections.join('\n──\n') : '';

      elements.push({ tag: 'hr' });

      // Both current and non-current sessions get a button for visual consistency
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${s.sessionId}**${infoStr}\n⏱ ${timeStr}${isCurrent ? '  •' : ''}`,
        },
      });
      elements.push({
        tag: 'column_set',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: buttonText },
                type: isCurrent ? 'default' : 'primary',
                disabled: isCurrent,
                behaviors: [
                  {
                    type: 'callback',
                    value: { cmd: 'resume.use', sessionId: s.sessionId, agent: agentKind },
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    // Pagination bar (only shown when there are more sessions than pageSize)
    if (total > pageSize) {
      const totalPages = Math.ceil(total / pageSize);
      const currentPage = Math.floor(pageOffset / pageSize) + 1;

      const bar = paginationBar({
        cmd: 'resume.page',
        offset: pageOffset,
        pageSize,
        total,
        extra: { agent: agentKind, pageSize },
        label: `第 ${currentPage}/${totalPages} 页 · 共 ${total} 个会话`,
      });
      elements.push({ tag: 'hr' });
      elements.push(bar);
    }

    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `🔁 恢复历史会话 · ${agentDisplayName(agentKind)}`,
        },
      },
      body: { elements },
    };
    return { card };
  }

  private cmdActive(_args: string[], _ctx: CommandContext, offset = 0): CommandResult {
    // List all active runs from bridge memory (not from file system scan)
    // New semantics (2026-07-20): only shows runs started by THIS bridge process

    const activeRuns = this.bridge.getActiveRuns();
    const activeBashRuns = this.bridge.getActiveBashRuns();

    if (activeRuns.length === 0 && activeBashRuns.length === 0) {
      return { text: '当前没有正在进行中的任务' };
    }

    // Build CardKit 2.0 card showing memory-based active runs
    return this.buildActiveCardFromMemory(activeRuns, activeBashRuns, offset);
  }

  /**
   * Build CardKit 2.0 /active card from bridge memory (not file system).
   * Shows only runs that were started by THIS bridge process.
   * Paginates with ACTIVE_PAGE_SIZE (default 20) items per page.
   */
  private buildActiveCardFromMemory(
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
    const safeOffset = Math.max(0, Math.min(offset, Math.max(0, totalCount - 1)));
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const currentPage = Math.floor(safeOffset / pageSize) + 1;

    // Slice: distribute offset across agent runs first, then bash runs
    const elements: object[] = [];

    // Page info
    if (totalPages > 1) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**第 ${currentPage}/${totalPages} 页** （共 ${totalCount} 项）`,
        },
      });
    }

    let remaining = pageSize;
    let skipped = safeOffset;

    // Agent runs section
    if (activeRuns.length > 0 && skipped < activeRuns.length && remaining > 0) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: '## 🤖 Agent 任务' } });
      const start = skipped;
      const end = Math.min(start + remaining, activeRuns.length);
      for (let i = start; i < end; i++) {
        const run = activeRuns[i];
        const statusLabel = run.terminal === 'running' ? '运行中' : '处理中';

        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `**📂 ${run.cwd.split('/').pop() ?? run.cwd}**` },
        });
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `> session: ${run.sessionId.slice(0, 12)}...  \n> 状态: ${statusLabel}`,
          },
        });
        // Stop button - CardKit 2.0 with behaviors callback
        elements.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '⏹ 停止' },
          type: 'danger',
          size: 'small',
          behaviors: [{ type: 'callback', value: { cmd: 'stop', runId: run.runId, cwd: run.cwd } }],
        });
        elements.push({ tag: 'hr' });
      }
      remaining -= end - start;
      skipped = 0;
    } else {
      skipped -= activeRuns.length;
    }

    // Bash runs section
    if (activeBashRuns.length > 0 && skipped < activeBashRuns.length && remaining > 0) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: '## 💻 Bash 命令' } });
      const start = skipped;
      const end = Math.min(start + remaining, activeBashRuns.length);
      for (let i = start; i < end; i++) {
        const run = activeBashRuns[i];
        const statusLabel = run.terminal === 'running' ? '运行中' : '处理中';

        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `**\`${run.command}\`**` },
        });
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `> 目录: ${run.cwd}  \n> 状态: ${statusLabel}` },
        });
        // Stop button - CardKit 2.0 with behaviors callback
        elements.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '⏹ 停止' },
          type: 'danger',
          size: 'small',
          behaviors: [{ type: 'callback', value: { cmd: 'stop', runId: run.runId, cwd: run.cwd } }],
        });
        elements.push({ tag: 'hr' });
      }
    }

    // Pagination buttons
    if (totalPages > 1) {
      const paginationButtons: object[] = [];
      if (currentPage > 1) {
        const prevOffset = (currentPage - 2) * pageSize;
        paginationButtons.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '◀ 上一页' },
          type: 'default',
          size: 'small',
          behaviors: [{ type: 'callback', value: { cmd: 'active.page', offset: prevOffset } }],
        });
      }
      if (currentPage < totalPages) {
        const nextOffset = currentPage * pageSize;
        paginationButtons.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '下一页 ▶' },
          type: 'primary',
          size: 'small',
          behaviors: [{ type: 'callback', value: { cmd: 'active.page', offset: nextOffset } }],
        });
      }
      elements.push({
        tag: 'column_set',
        columns: paginationButtons.map((btn) => ({
          tag: 'column',
          width: 'auto',
          elements: [btn],
        })),
      });
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

  private async cmdReconnect(): Promise<CommandResult> {
    try {
      await this.bridge.reconnect();
      return { text: '已重连飞书' };
    } catch {
      return { text: '重连失败，请检查网络和配置' };
    }
  }

  private async cmdConfig(args: string[], ctx: CommandContext): Promise<CommandResult> {
    // Ensure probe cache is populated before building the card.
    await probeAllAgents();

    // 动态清单预取（DSH 模型/预设目录）：卡渲染前拉取，失败回退兜底清单
    await this.prefetchConfigCardCatalogs();

    // Check if this is a direct set command: /config <key> <value>
    // Command-style set: immediate write to disk, clear pendingConfig
    if (args.length >= 2) {
      const key = args[0];
      const value = args.slice(1).join(' ');
      try {
        const oldDefaultAgent = this.config.defaultAgent;
        // P2-23：直写前若 pendingConfig 存在未保存差异，提示用户被丢弃的条数，
        // 避免静默清空导致用户在卡片上的修改无反馈丢失。差异必须在 setConfigValue
        // 之前计算——直写本身也会改变 config，不应计入「被丢弃的未保存修改」。
        const discarded = this.pendingConfig
          ? Object.keys(this.diffConfig(this.config, this.pendingConfig)).length
          : 0;
        this.config = setConfigValue(this.configPath, this.config, key, value);
        // P1-6：直写路径与 config.save 卡片路径共用运行时传播（idleTimeout /
        // clearRunners / syncAgentChoices / defaultAgent 切换）。key 经 mapAgentKey
        // 归一化，pi./codex./opencode./kimi. 命中 agents.* 判定；claude. 与
        // defaultAgent 不再漏判。
        const switchResult = this.propagateConfigSave(
          oldDefaultAgent,
          { [mapAgentKey(key)]: value },
          ctx,
        );
        this.pendingConfig = null; // 命令式写盘后清空暂存，避免不一致
        // 2026-08-13: agent 切换时额外发送 Resume 卡片
        if (switchResult.notice) {
          const switchCard = this.buildConfigSwitchCard(switchResult, ctx);
          // 文本路径返回 config card，Resume card 通过 bridge 异步发送
          void this.bridge.sendResult(switchCard, ctx);
        }
        const card = this.buildConfigCard();
        if (discarded > 0 && card.card && typeof card.card === 'object') {
          const body = (card.card as { body?: { elements?: unknown[] } }).body;
          if (body && Array.isArray(body.elements)) {
            body.elements.unshift({
              tag: 'div',
              text: { tag: 'lark_md', content: `⚠️ 已丢弃 ${discarded} 项未保存修改` },
            });
          }
        }
        return card;
      } catch (err) {
        return { text: `设置失败: ${(err as Error).message}` };
      }
    }

    // Default: show interactive config card - initialize pendingConfig if needed
    this.ensurePendingConfig();
    return this.buildConfigCard();
  }

  /**
   * DSH /config 卡片构建前异步预取模型/预设目录（§4.2 动态清单）。
   * 只在 defaultAgent 为 dsh 时生效；其他 agent 无 prefetch 钩子直接跳过。
   * 预取失败不阻断——DshConfigBuilder 内部已回退固定兜底清单。
   */
  private async prefetchConfigCardCatalogs(): Promise<void> {
    if (this.config.defaultAgent !== 'dsh') return;
    const builder = getConfigBuilder('dsh');
    const dshConf = getAgentConfig(this.config, 'dsh');
    await builder.prefetch?.(dshConf?.host);
  }

  /** Build an interactive config card with CardKit 2.0 tabs + batch save */
  buildConfigCard(): CommandResult {
    // 使用 pendingConfig（若存在）或当前 config
    const displayConfig = this.pendingConfig ?? this.config;

    // 定义字段分组：defaultAgent 选择器 + 该 agent 的配置字段 + idle.watchdogMinutes +
    // output/logging。stopGraceMs 等实现细节走 YAML，不在卡片暴露。

    // 根据 defaultAgent 构建完整的 Agent 配置字段组
    // 使用 agent config builder 获取该 agent 的配置字段
    const defaultAgent = displayConfig.defaultAgent ?? 'claude';
    const configBuilder = getConfigBuilder(defaultAgent);

    // Build defaultAgent selector with availability annotations.
    // Direct inline construction (not via ConfigField) so that text (display label)
    // and value (agentKind for config storage) can differ — uninstalled agents get
    // a "⚠️ (未安装)" suffix in the label while the value stays clean.
    // 固定展示顺序（Codex → Claude → OpenCode → Pi → Kimi），
    // 明确未安装的 agent 排到后面（getCachedAvailability === false）。
    const allAgents = sortAgentsForDisplay(listRegisteredAgents(), getCachedAvailability);
    const agentOptions = allAgents.map((kind) => {
      const available = getCachedAvailability(kind);
      const label =
        available === false ? `${agentDisplayName(kind)} ⚠️ (未安装)` : agentDisplayName(kind);
      return { text: { tag: 'plain_text' as const, content: label }, value: kind };
    });
    const selectedAgent = displayConfig.defaultAgent ?? 'claude';
    const agentSelector = {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 2,
          vertical_align: 'center',
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: '默认 Agent' } }],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 3,
          vertical_align: 'center',
          elements: [
            {
              tag: 'select_static',
              placeholder: { tag: 'plain_text', content: '请选择' },
              options: agentOptions,
              initial_option: selectedAgent,
              behaviors: [{ type: 'callback', value: { cmd: 'config.set', key: 'defaultAgent' } }],
            },
          ],
        },
      ],
    };

    // Agent config fields — no longer include defaultAgent as a ConfigField
    // (it's rendered inline above with text/value separation).
    const agentConfigFieldsNoSelector = configBuilder.buildFields(displayConfig);

    const tabs: ConfigTab[] = [
      {
        id: 'agent',
        label: `🤖 ${agentDisplayName(defaultAgent)}`,
        fields: agentConfigFieldsNoSelector,
      },
      {
        id: 'idle',
        label: '⏱️ 空闲',
        fields: [{ key: 'idle.watchdogMinutes', label: '空闲超时(分钟, 0关闭)', type: 'input' }],
      },
      {
        id: 'output',
        label: '📤 输出',
        fields: [
          { key: 'output.showThinking', label: '显示思考过程', type: 'boolean' },
          { key: 'output.showToolUse', label: '显示工具调用', type: 'boolean' },
          { key: 'output.showToolResult', label: '显示工具结果', type: 'boolean' },
        ],
      },
      {
        id: 'logging',
        label: '📝 日志',
        fields: [
          {
            key: 'logging.level',
            label: '日志级别',
            type: 'select',
            options: ['debug', 'info', 'warn', 'error'],
          },
        ],
      },
    ];

    // 使用共享渲染模块构建卡片
    const card = buildConfigCardFromTabs(tabs, displayConfig);

    // Inject the agent selector as the first element in the agent tab section,
    // right after the "**🤖 ..." header, so text/value can differ for uninstalled agents.
    // NOTE: findIndex relies on the agent tab header starting with "**🤖" — if the
    // tab label format changes, this fallback will fire and the selector moves to top.
    const body = (card as { body?: { elements?: unknown[] } }).body;
    if (body && Array.isArray(body.elements)) {
      const headerIdx = body.elements.findIndex(
        (el) =>
          typeof el === 'object' &&
          el !== null &&
          (el as { tag?: string; text?: { tag?: string; content?: string } }).tag === 'div' &&
          (el as { text?: { tag?: string; content?: string } }).text?.tag === 'lark_md' &&
          ((el as { text?: { tag?: string; content?: string } }).text?.content ?? '').startsWith(
            '**🤖',
          ),
      );
      if (headerIdx >= 0) {
        body.elements.splice(headerIdx + 1, 0, agentSelector);
      } else {
        getLogger().warn('[buildConfigCard] agent tab header not found, falling back to unshift');
        body.elements.unshift(agentSelector);
      }
    }

    return { card };
  }

  /** /order 实现（public：测试直接调用，替代 as unknown as）。 */
  cmdOrder(args: string[], _ctx: CommandContext, offset = 0): CommandResult {
    const sub = args[0]?.toLowerCase();

    // /order — list orders (CardKit 2.0 with pagination)
    if (!sub || sub === 'list') {
      this.orderStore.reload();
      const allOrders = this.orderStore.get();

      const elements: object[] = [];
      if (allOrders.length === 0) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: '暂无指令' } });
      } else {
        // Pagination calculations
        const totalCount = allOrders.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / ORDER_PAGE_SIZE));
        // Clamp offset to last page boundary to avoid empty pages
        const maxOffset = Math.max(0, (totalPages - 1) * ORDER_PAGE_SIZE);
        const safeOffset = clampInt(offset, 0, maxOffset);
        const currentPage = Math.floor(safeOffset / ORDER_PAGE_SIZE) + 1;
        const pageOrders = allOrders.slice(safeOffset, safeOffset + ORDER_PAGE_SIZE);
        const hasPagination = totalCount > ORDER_PAGE_SIZE;

        for (let i = 0; i < pageOrders.length; i++) {
          const order = pageOrders[i];
          const displayText =
            order.text.length > 100 ? order.text.slice(0, 97) + '...' : order.text;

          // 文字在上方（有别名时用 `$name` 前缀标识触发词）
          elements.push({
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: order.alias ? `\`$${order.alias}\` ${displayText}` : displayText,
            },
          });

          // 操作行：左侧别名按钮（无别名显示 ＋别名，有别名点击可改），
          // 右侧「删除指令」按钮。两列均 weighted 1:1，跨行对齐。
          const leftColumn: object[] = order.alias
            ? [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: `$${order.alias}` },
                  type: 'default',
                  size: 'small',
                  behaviors: [
                    {
                      type: 'callback',
                      value: { cmd: 'order.aliasEdit', orderId: order.id, offset: safeOffset },
                    },
                  ],
                },
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '✕' },
                  type: 'default',
                  size: 'small',
                  behaviors: [
                    {
                      type: 'callback',
                      value: {
                        cmd: 'order.aliasRemove',
                        orderId: order.id,
                        aliasName: order.alias,
                        offset: safeOffset,
                      },
                    },
                  ],
                },
              ]
            : [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '＋别名' },
                  type: 'default',
                  size: 'small',
                  behaviors: [
                    {
                      type: 'callback',
                      value: { cmd: 'order.aliasEdit', orderId: order.id, offset: safeOffset },
                    },
                  ],
                },
              ];

          elements.push({
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                elements: leftColumn,
              },
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                vertical_align: 'center',
                elements: [
                  {
                    tag: 'column_set',
                    columns: [
                      {
                        tag: 'column',
                        width: 'auto',
                        elements: [
                          {
                            tag: 'button',
                            text: { tag: 'plain_text', content: '▶ 执行' },
                            type: 'primary',
                            size: 'small',
                            behaviors: [
                              {
                                type: 'callback',
                                value: { cmd: 'order.exec', orderId: order.id },
                              },
                            ],
                          },
                        ],
                      },
                      {
                        // 编辑：弹蓝色 header 输入卡（CardKit 2.0 input + ✓ 提交），
                        // 镜像 order.aliasEdit 流程。order.textEdit 是 control-only action
                        // （isImmediateAction 注册），不 spawn agent。
                        tag: 'column',
                        width: 'auto',
                        elements: [
                          {
                            tag: 'button',
                            text: { tag: 'plain_text', content: '编辑' },
                            type: 'default',
                            size: 'small',
                            behaviors: [
                              {
                                type: 'callback',
                                value: {
                                  cmd: 'order.textEdit',
                                  orderId: order.id,
                                  offset: safeOffset,
                                },
                              },
                            ],
                          },
                        ],
                      },
                      {
                        tag: 'column',
                        width: 'auto',
                        elements: [
                          {
                            tag: 'button',
                            text: { tag: 'plain_text', content: '删除' },
                            type: 'danger',
                            size: 'small',
                            behaviors: [
                              {
                                type: 'callback',
                                value: {
                                  cmd: 'order.delete',
                                  orderId: order.id,
                                  offset: safeOffset,
                                },
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          });

          // 非最后一项，添加分隔线
          if (i < pageOrders.length - 1) {
            elements.push({ tag: 'hr' });
          }
        }

        // Pagination bar (only shown when there are more items than ORDER_PAGE_SIZE)
        if (hasPagination) {
          const bar = paginationBar({
            cmd: 'order.page',
            offset: safeOffset,
            pageSize: ORDER_PAGE_SIZE,
            total: totalCount,
            label: `**第 ${currentPage}/${totalPages} 页**（共 ${totalCount} 条）`,
          });
          elements.push({ tag: 'hr' });
          elements.push(bar);
        }
      }

      return {
        card: {
          schema: '2.0',
          config: { wide_screen_mode: true, update_multi: true },
          header: { title: { tag: 'plain_text', content: '📋 指令' }, template: 'turquoise' },
          body: { elements },
        },
      };
    }

    // /order alias — CLI 别名管理（卡片是主入口，命令是备选）：
    //   /order alias add <orderId|N> <name>   — 给某条指令绑定别名
    //   /order alias rm <orderId|N>           — 移除某条指令的别名
    //   /order alias list                     — 列出已绑定的别名（并入列表卡片）
    if (sub === 'alias') {
      const op = args[1];
      if (op === 'add') {
        const target = args[2];
        const name = args[3];
        if (!target || !name) {
          return { text: '用法: /order alias add <orderId|序号> <别名名>' };
        }
        return this.cmdOrderAliasAdd(target, name);
      }
      if (op === 'rm') {
        const target = args[2];
        if (!target) {
          return { text: '用法: /order alias rm <orderId|序号>' };
        }
        return this.cmdOrderAliasRemove(target);
      }
      if (!op || op === 'list') {
        // 别名管理列表并入列表卡片
        return this.cmdOrder([], _ctx, offset);
      }
      return {
        text: '用法: /order alias [add <orderId|序号> <别名名> | rm <orderId|序号> | list]',
      };
    }

    // /order save <text>
    if (sub === 'save') {
      const text = args.slice(1).join(' ');
      if (!text) {
        return { text: '用法: /order save <指令文本>' };
      }
      try {
        this.orderStore.save(text);
        return { text: `✅ 已保存指令: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}` };
      } catch (err) {
        return { text: `保存失败: ${(err as Error).message}` };
      }
    }

    // /order edit <orderId|序号> <新文本> — CLI 备选路径（卡片是主入口）。
    // 与 /order save / alias add|rm 对称；复用 resolveOrderTarget。
    // 与卡片路径（handleOrderTextInput）对齐 trim 语义，避免「卡片 trim、CLI 不 trim」
    // 两条入口对同一文本存出不同结果。
    if (sub === 'edit') {
      const target = args[1];
      const newText = args.slice(2).join(' ').trim();
      if (!target || !newText) {
        return { text: '用法: /order edit <orderId|序号> <新文本>' };
      }
      const order = this.resolveOrderTarget(target);
      if (!order) return { text: `指令不存在: ${target}` };
      try {
        this.orderStore.updateText(order.id, newText);
        const preview = newText.length > 50 ? newText.slice(0, 50) + '...' : newText;
        return { text: `✅ 已更新指令: ${preview}` };
      } catch (err) {
        return { text: `保存失败: ${(err as Error).message}` };
      }
    }

    return {
      text: '用法: /order [list|save <text>|edit <orderId|序号> <新文本>|alias add <orderId|序号> <别名名>|alias rm <orderId|序号>]',
    };
  }

  /** /order alias add：按 orderId 或列表序号（1 基）解析目标指令并绑定别名。 */
  private cmdOrderAliasAdd(target: string, name: string): CommandResult {
    const order = this.resolveOrderTarget(target);
    if (!order) return { text: `指令不存在: ${target}` };
    try {
      this.orderStore.setAlias(order.id, name);
      return { text: `✅ 已给指令绑定别名 $${name}` };
    } catch (err) {
      return { text: `保存失败: ${(err as Error).message}` };
    }
  }

  /** /order alias rm：按 orderId 或列表序号（1 基）移除指令的别名。 */
  private cmdOrderAliasRemove(target: string): CommandResult {
    const order = this.resolveOrderTarget(target);
    if (!order) return { text: `指令不存在: ${target}` };
    if (!order.alias) return { text: '该指令没有别名' };
    // 先读别名名再解绑：setAlias(undefined) 会 delete 同一对象引用上的 alias 字段。
    const aliasName = order.alias;
    this.orderStore.setAlias(order.id, undefined);
    return { text: `✅ 已移除别名 $${aliasName}` };
  }

  /** 将 `/order alias add|rm` 的目标解析为 order：优先 orderId 精确匹配，回退列表序号（1 基）。 */
  private resolveOrderTarget(target: string): OrderEntry | undefined {
    const all = this.orderStore.get();
    const byId = all.find((o) => o.id === target);
    if (byId) return byId;
    const n = Number(target);
    if (Number.isInteger(n) && n >= 1 && n <= all.length) return all[n - 1];
    return undefined;
  }
}
