import type { SessionStore, SessionReaderRegistry } from '../session/index.js';
import type { AppConfig } from '../config/index.js';
import type { Bridge, CommandContext, CommandResult } from '../bridge/index.js';
import type { AgentBinding } from '../bridge/queue-manager.js';
import { WorkspaceStore } from '../workspace/index.js';
import { OrderStore, type OrderEntry } from '../order/index.js';
import { resolveAlias } from '../order/alias-resolve.js';
import type { AgentSessionReader } from '../session-contract.js';
import { getLogger } from '../logger/index.js';

/** /config 打开时登记的后台目录探测槽位。 */
interface ConfigOpenRefreshSlot {
  /** 探测点火前的目录签名；落地后比对，没变化就不补刷卡片。 */
  before: string;
  prefetch: Promise<unknown>;
}
import type { CloneSession } from '../clone.js';
import { stripPlaceholders } from '../inbound/placeholder.js';
import {
  checkLatestVersion as defaultCheckLatestVersion,
  compareVersions as defaultCompareVersions,
  runInstallLatest as defaultRunInstallLatest,
  type VersionCheckResult,
  type InstallResult,
} from '../update/index.js';

/** Config card builder - delegates to per-agent builders */
import * as sessionActions from './actions/session-actions.js';
import * as queueActions from './actions/queue-actions.js';
import * as lsActions from './actions/ls-actions.js';
import * as orderActions from './actions/order-actions.js';
import * as configActions from './actions/config-actions.js';
import {
  createConfigRenderState,
  scheduleConfigRender,
  flushConfigRender,
  rememberConfigCard,
} from './actions/config-render.js';
import * as commandActions from './actions/command-actions.js';
import type { CardActionPayload, CardActionResponse } from './actions/shared.js';
import { CONFIG_EXIT_FLUSH_BUDGET_MS } from './actions/shared.js';
export type { CardActionPayload } from './actions/shared.js';

/** Max events to read for auto-resume and /resume cards.
 * Limits events at the read stage so enforceCardBudget rarely needs to truncate.
 * Chosen to be under the 28KB card budget for typical events (~2KB each). */

/**
 * 可 unref 的 sleep：用于「等一件事做完，但不让进程为了等它而多活着」。
 * 与 `src/common/sleep.ts` 的差别只在 unref——退出路径上冲刷已落地时，
 * 普通 setTimeout 会把进程多钉住整个预算。
 */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 飞书会把极短间隔连发的多条消息合并成一条换行分隔的消息：用户侧看是两条消息，
 * 本端收到的却是 `/a\n/b`。命令执行是「一条消息一条」，首行之外的内容不会作为
 * 独立命令执行。命中时返回首行之外的原始内容（即被忽略的部分），未命中返回 null。
 * 绝对路径参数（如 `/cd /tmp`）与命令同处首行，不会误判。
 */
function findMergedCommandTail(message: string): string | null {
  const lines = message.split('\n');
  if (lines.length < 2) return null;
  const tail = lines.slice(1).join('\n').trim();
  if (!tail) return null;
  const hasSlashLine = lines.slice(1).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 1 && trimmed.startsWith('/') && !trimmed.startsWith('/ ');
  });
  return hasSlashLine ? tail : null;
}

/** 人类可读字节数（B/KB/MB/GB）；/ls 列表与单文件卡共用。 */

/**
 * /order 列表页大小；指令超过此数量时显示分页导航栏。
 * 实测：每行 2 个元素（div + column_set，行间 hr），20 行 + 分页栏
 * = 61 个 body 元素，触发飞书 ErrCode 11310 "element exceeds the limit"
 * （21+ 条指令时第 1 页必炸）。改为 15 行：3*15 - 1 + 2 = 46 个元素，留足余量。
 * 别名并卡后每行变 3 个元素（文本 div + 操作 column_set + hr），
 * 从 15 降为 8：3*8 - 1 + 2 = 25 个元素，仍在余量内，同时保证手机窄屏
 * 每条指令的操作控件（执行/别名/删除）不被挤压。
 */
/**
 * /ws 列表页大小。从 15 降为 5：头部 2 + 5 行 × 3（div + column_set + hr）+
 * 底栏排序 1 + 分页栏 2 ≈ 20 个 body 元素，远低于单卡 60 元素上限（ErrCode 11310），
 * 留足余量。
 */

/** /resume 列表页内全量预取（readSessionContent）的行数上限；其余行用轻量 summary 兜底。 */
/**
 * Reader summary 占位符（trim 后匹配）。各 reader 在"无 user 消息"时返回的
 * 兜底文案不同（claude/pi `(无摘要)`、codex `(no user message)`、kimi
 * `New Session`、空串），都不是真实输入，不得渲染成行标题。
 */
/**
 * 列表卡单行预览：压平空白、去掉反引号，再按字符截断。
 *
 * 为什么去反引号：agent 的输出里 `code` 很常见，截断点落在一对反引号中间时
 * 后半张卡片的 markdown 会被当成代码块渲染（lark_md 不闭合就不回退）。
 */

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
 * ws.remove   — delete cwd alias only
 * resume.use  — set sessionId + agent for correct reader routing
 * help.*      — read-only help commands
 * order.delete — delete order only
 * order.exec is intercepted by index.ts at the enqueue boundary
 * (resolveOrderExecForQueue → router.handle), never reaching this dispatcher.
 */
export function isImmediateAction(cmd: string): boolean {
  // help.* wildcard: any command starting with "help."
  if (cmd.startsWith('help.')) return true;
  // 名单在 APPROVAL_ACTION_SPECS 之后定义（模块初始化完成后才可能被调用）。
  return IMMEDIATE_ACTION_CMDS.has(cmd);
}

/** propagateConfigSave 返回的结构化切换结果 */

/**
 * 审批卡片动作表驱动（cmd → 必填校验/bridge 调用/成功与失败 toast）。
 * 原先 7 段同构的「校验→try→bridge 调用→成功 toast→catch→失败 toast」收敛于此。
 */
interface ApprovalActionSpec {
  missing: (value: CardActionPayload) => boolean;
  missingToast: string;
  run: (bridge: Bridge, value: CardActionPayload) => Promise<unknown>;
  successToast: string;
  toastType?: 'success' | 'info';
  /** 缺省走 CommandRouter.answerFailureToast（答案类操作的重复投递语义）。 */
  failureToast?: (msg: string) => CardActionResponse;
}

const QUESTION_INDEX_PRESENT = (v: CardActionPayload) => v.questionIndex !== undefined;

const APPROVAL_ACTION_SPECS: Record<string, ApprovalActionSpec> = {
  'approval.respond': {
    missing: (v) => !v.runId || v.requestId === undefined || !v.decision || !v.nonce,
    missingToast: '缺少审批响应参数',
    run: (bridge, v) =>
      bridge.handleApprovalRespond({
        runId: v.runId!,
        requestId: v.requestId!,
        decision: v.decision!,
        nonce: v.nonce!,
      }),
    successToast: '审批已提交',
    failureToast: (msg) => {
      // 审批已过期：给用户明确反馈，不静默不误导（否则点了允许无任何反馈）。
      const content = /state=expired/.test(msg)
        ? '⏰ 审批已过期，无法响应'
        : `审批响应失败：${msg}`;
      return { toast: { type: 'error', content } };
    },
  },
  'approval.toggle': {
    missing: (v) => !v.runId || v.requestId === undefined || !v.permId,
    missingToast: '缺少权限切换参数',
    run: (bridge, v) =>
      bridge.handleApprovalToggle({
        runId: v.runId!,
        requestId: v.requestId!,
        permId: v.permId!,
        selected: v.selected ?? true,
      }),
    successToast: '已切换',
    toastType: 'info',
    failureToast: (msg) => ({ toast: { type: 'error', content: `权限切换失败：${msg}` } }),
  },
  'approval.answer': {
    missing: (v) =>
      !v.runId || v.requestId === undefined || !QUESTION_INDEX_PRESENT(v) || !v.option || !v.nonce,
    missingToast: '缺少问题答案参数',
    run: (bridge, v) =>
      bridge.handleApprovalAnswer({
        runId: v.runId!,
        requestId: v.requestId!,
        questionIndex: v.questionIndex!,
        option: v.option!,
        nonce: v.nonce!,
      }),
    successToast: '已选择',
  },
  'approval.answerSubmit': {
    missing: (v) => !v.runId || v.requestId === undefined || !QUESTION_INDEX_PRESENT(v) || !v.nonce,
    missingToast: '缺少提交参数',
    run: (bridge, v) =>
      bridge.handleApprovalAnswerSubmit({
        runId: v.runId!,
        requestId: v.requestId!,
        questionIndex: v.questionIndex!,
        nonce: v.nonce!,
      }),
    successToast: '答案已提交',
  },
  'approval.answerCustom': {
    missing: (v) =>
      !v.runId ||
      v.requestId === undefined ||
      !QUESTION_INDEX_PRESENT(v) ||
      !v.nonce ||
      !v.inputValue,
    missingToast: '缺少答案文本参数',
    run: (bridge, v) =>
      bridge.handleApprovalAnswerCustom({
        runId: v.runId!,
        requestId: v.requestId!,
        questionIndex: v.questionIndex!,
        text: v.inputValue!,
        nonce: v.nonce!,
      }),
    successToast: '答案已提交',
  },
  'approval.answerNote': {
    missing: (v) =>
      !v.runId ||
      v.requestId === undefined ||
      !QUESTION_INDEX_PRESENT(v) ||
      !v.nonce ||
      !v.inputValue,
    missingToast: '缺少补充说明参数',
    run: (bridge, v) =>
      bridge.handleApprovalAnswerNote({
        runId: v.runId!,
        requestId: v.requestId!,
        questionIndex: v.questionIndex!,
        text: v.inputValue!,
        nonce: v.nonce!,
      }),
    successToast: '补充说明已保存',
  },
  'approval.planFeedback': {
    missing: (v) => !v.runId || v.requestId === undefined || !v.nonce || !v.inputValue,
    missingToast: '缺少修改意见参数',
    run: (bridge, v) =>
      bridge.handleApprovalPlanFeedback({
        runId: v.runId!,
        requestId: v.requestId!,
        text: v.inputValue!,
        nonce: v.nonce!,
      }),
    successToast: '修改意见已保存',
    failureToast: (msg) => ({ toast: { type: 'error', content: `修改意见保存失败：${msg}` } }),
  },
};

// ===========================================================================
// 命令名单单一事实源
// 直返语义（cardAction 同步返回 toast 给飞书回调，index.ts 控制层据此不经
// 队列直接处理）与即时语义（绕串行队列 enqueueImmediate，§9.6）正交，两个
// 独立清单只共享审批命令名来源（APPROVAL_ACTION_SPECS keys）——历史上同一
// 份知识四份拷贝曾两次漂移（order.textInput 漏 immediate、answer 家族漏直返）。
// ===========================================================================

/** 审批命令名清单（APPROVAL_ACTION_SPECS keys，handleCardAction 分发共用）。 */
export const APPROVAL_ACTION_CMDS: readonly string[] = Object.keys(APPROVAL_ACTION_SPECS);

/**
 * 直返命令：点击后同步返回 toast / card 给飞书回调，不经队列。
 * index.ts 控制层直返清单的唯一来源（勿在别处复制名单）。
 */
export const DIRECT_RETURN_CMDS: ReadonlySet<string> = new Set([
  'queue.input',
  'order.aliasInput',
  'order.aliasRemove',
  'order.textInput',
  'config.set',
  'config.input',
  'config.refresh',
  'config.save',
  ...APPROVAL_ACTION_CMDS,
]);

/** 即时命令清单（绕串行队列 enqueueImmediate）。 */
const IMMEDIATE_ACTION_CMDS: ReadonlySet<string> = new Set([
  'new-session',
  'stop',
  'ls.file',
  'ls.refresh',
  'ls.browse',
  'ls.switch',
  'ls.page', // control operation: paginate only, never spawns claude
  'ls.filter', // control operation: refilter the /ls list only
  'resume.page', // control operation: paginate only, never spawns claude
  'active.page', // control operation: paginate active card
  'ws.page', // control operation: paginate /ws list only
  'ws.filter', // control operation: refilter the /ws list only
  'ws.remove',
  'ws.sort', // control operation: toggle sort mode only
  'resume.use',
  'ws.use',
  'queue.immediate',
  'queue.cancel',
  'queue.diagnose',
  'queue.edit',
  'queue.input',
  // 终态卡「停止后台任务」：纯远程 job/kill 请求，不产生 agent 工作（§9.19
  // 控制操作免排队）。排进串行队列会等当前 run 结束才杀任务——stop 类按钮
  // 排队正是 §9.6 要防的形态，且排队期间还占 lane 多出一张排队卡。
  'job.kill',
  // 恢复卡「终止」取消宿主轮次，与 stop 同类：排队会等当前 run 结束才执行，
  // 队列满时还会被拒收（终止请求丢失）。
  'stop.session',
  'order.delete',
  'order.page',
  'order.aliasEdit',
  'order.aliasInput',
  'order.aliasRemove',
  'order.textEdit',
  'order.textInput',
  'config.set',
  'config.input',
  'config.refresh',
  'config.save',
  // 审批响应/权限切换必须即时触达在途 run（同 stop 类控制动作）。若走串行
  // 队列会排在等待审批的 run 之后形成死锁：run 不结束审批不执行，run 结束
  // coordinator 已删响应空转（approval.respond 落进排队卡、审批永不生效）。
  ...APPROVAL_ACTION_CMDS,
]);

/**
 * 会话 / cwd / agent 变更类卡片动作（单源）。这些动作会改写 sessionStore 的
 * sessionId / cwd / defaultAgent，必须与入站装配器的 700ms 静默窗口定序：
 * 控制层（index.ts）在执行它们之前先 flush 该 user/chat 的装配窗口，保证窗口内
 * 先到的文本消息在本动作之前 commit（绑定动作前的旧状态）。否则窗口内消息会
 * 漂移到动作之后的新状态（输入「重新构建」后立即点「新会话」，
 * 消息落到新会话）。
 *
 * 文本命令（/new、/cd、/resume、/config）已由 index.ts 命令分支先 flush，
 * 不在此列——只有卡片动作绕过了该分支。
 */
export const SESSION_MUTATING_ACTION_CMDS: ReadonlySet<string> = new Set([
  'new-session',
  'resume.use',
  'ls.switch',
  'ws.use',
  'config.save',
]);

/**
 * 会产生压缩工作的卡片动作（单源）。这类条目占用 lane 时必须自报身份：
 * 排队卡写明「正在执行: 🗜 Compact」而不是「前面还有 0 条」，并且期间禁用
 * 「立即执行」——该按钮走 interruptCurrentRun，会连带中断正在跑的压缩
 * （Compact 占 lane 期间新消息的排队卡自相矛盾，且按钮
 * 一点就会杀掉压缩）。同时它们也不允许编辑（预览不是用户文本）。
 */
export const COMPACT_ACTION_CMDS: ReadonlySet<string> = new Set(['compact', 'resume.compact']);

/** 单源：payload.offset → 钳位 offset（原先 9 处逐字副本）。 */

/** 本次改动是否落进 `agents.<kind>` 子树。 */

// ===========================================================================
// cardAction 分发单源
// 大 switch 的决策点全部收敛到模块顶层 Map：value 是私有 handler 方法名 +
// 参数风格。方法名以字面量联合约束（拼错编译期即红），调用发生在类体内，
// private 方法因此仍可访问；外层函数里不再堆几十个 case / 内部闭包。
// 用 Map 而非对象字面量：constructor/toString 这类 cmd 会命中 Object.prototype。
// ===========================================================================

type CardActionHandler = (
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
) => Promise<CardActionResponse | void> | CardActionResponse | void;

const CARD_ACTION_SPECS = new Map<string, CardActionHandler>([
  ['ls.file', (host, value, ctx) => lsActions.cardLsFile(host, value.path, ctx)],
  ['ls.refresh', (host, value, ctx) => lsActions.handleLsRefresh(host, value, ctx)],
  ['ls.browse', (host, value, ctx) => lsActions.handleLsBrowse(host, value, ctx)],
  ['ls.switch', (host, value, ctx) => lsActions.handleLsSwitch(host, value, ctx)],
  ['ls.page', (host, value, ctx) => lsActions.handleLsPage(host, value, ctx)],
  ['ls.filter', (host, value, ctx) => lsActions.handleLsFilter(host, value, ctx)],
  ['ws.page', (host, value, ctx) => orderActions.handleWsPage(host, value, ctx)],
  ['ws.filter', (host, value, ctx) => orderActions.handleWsFilter(host, value, ctx)],
  ['ws.use', (host, value, ctx) => orderActions.handleWsUse(host, value, ctx)],
  ['ws.sort', (host, value, ctx) => orderActions.handleWsSort(host, value, ctx)],
  ['ws.remove', (host, value, ctx) => orderActions.handleWsRemove(host, value, ctx)],
  ['resume.use', (host, value, ctx) => sessionActions.handleResumeUse(host, value, ctx)],
  ['resume.page', (host, value, ctx) => sessionActions.handleResumePage(host, value, ctx)],
  ['active.page', (host, value, ctx) => sessionActions.handleActivePage(host, value, ctx)],
  ['new-session', (host, _value, ctx) => sessionActions.handleNewSession(host, ctx)],
  ['stop', (host, value, ctx) => sessionActions.handleCardStop(host, value, ctx)],
  ['job.kill', (host, value, ctx) => sessionActions.handleJobKill(host, value, ctx)],
  ['queue.cancel', (host, value, ctx) => queueActions.handleQueueCancel(host, value, ctx)],
  ['queue.immediate', (host, value, ctx) => queueActions.handleQueueImmediate(host, value, ctx)],
  ['queue.diagnose', (host, value, ctx) => queueActions.handleQueueDiagnose(host, value, ctx)],
  ['queue.edit', (host, value, ctx) => queueActions.handleQueueEdit(host, value, ctx)],
  ['queue.input', (host, value, ctx) => queueActions.handleQueueInput(host, value, ctx)],
  ['order.delete', (host, value, ctx) => orderActions.handleOrderDelete(host, value, ctx)],
  ['order.page', (host, value, ctx) => orderActions.handleOrderPage(host, value, ctx)],
  ['order.aliasEdit', (host, value, ctx) => orderActions.handleOrderAliasEdit(host, value, ctx)],
  ['order.aliasInput', (host, value, ctx) => orderActions.handleOrderAliasInput(host, value, ctx)],
  [
    'order.aliasRemove',
    (host, value, ctx) => orderActions.handleOrderAliasRemove(host, value, ctx),
  ],
  ['order.textEdit', (host, value, ctx) => orderActions.handleOrderTextEdit(host, value, ctx)],
  ['order.textInput', (host, value, ctx) => orderActions.handleOrderTextInput(host, value, ctx)],
  ['config.set', (host, value, ctx) => configActions.enqueueConfigAction(host, value, ctx)],
  ['config.input', (host, value, ctx) => configActions.enqueueConfigAction(host, value, ctx)],
  ['config.refresh', (host, value, ctx) => configActions.enqueueConfigAction(host, value, ctx)],
  ['config.save', (host, value, ctx) => configActions.enqueueConfigAction(host, value, ctx)],
  ['compact', (host, value, ctx) => host.bridge.handleCompactAction(value, ctx)],
  ['resume.compact', (host, value, ctx) => host.bridge.handleResumeCompact(value, ctx)],
  ['stop.session', (host, value, ctx) => host.bridge.handleStopSession(value, ctx)],
]);

type CommandHandler = (
  host: CommandRouter,
  args: string[],
  ctx: CommandContext,
) => Promise<CommandResult | null> | CommandResult | null;

const COMMAND_SPECS = new Map<string, CommandHandler>([
  ['help', (host) => commandActions.cmdHelp(host)],
  ['h', (host) => commandActions.cmdHelp(host)],
  ['status', (host, _args, ctx) => commandActions.cmdStatus(host, ctx)],
  ['s', (host, _args, ctx) => commandActions.cmdStatus(host, ctx)],
  ['ps', (host, _args, ctx) => commandActions.cmdPs(host, ctx)],
  ['stop', (host, _args, ctx) => commandActions.cmdStop(host, ctx)],
  ['t', (host, _args, ctx) => commandActions.cmdStop(host, ctx)],
  ['exit', (host) => commandActions.cmdExit(host)],
  ['quit', (host) => commandActions.cmdExit(host)],
  ['e', (host) => commandActions.cmdExit(host)],
  ['restart', (host) => commandActions.cmdRestart(host)],
  ['new', (host, _args, ctx) => commandActions.cmdNew(host, ctx)],
  ['cd', (host, args, ctx) => commandActions.cmdCd(host, args, ctx)],
  ['ls', (host, args, ctx) => commandActions.cmdLs(host, args, ctx)],
  ['download', (host, args, ctx) => commandActions.cmdDownload(host, args, ctx)],
  ['d', (host, args, ctx) => commandActions.cmdDownload(host, args, ctx)],
  ['ws', (host, args, ctx) => commandActions.cmdWs(host, args, ctx)],
  ['resume', (host, args, ctx) => commandActions.cmdResume(host, args, ctx)],
  ['r', (host, args, ctx) => commandActions.cmdResume(host, args, ctx)],
  ['active', (host, args, ctx) => commandActions.cmdActive(host, args, ctx)],
  ['config', (host, args, ctx) => configActions.cmdConfig(host, args, ctx)],
  ['c', (host, args, ctx) => configActions.cmdConfig(host, args, ctx)],
  ['order', (host, args, ctx) => commandActions.cmdOrder(host, args, ctx)],
  ['o', (host, args, ctx) => commandActions.cmdOrder(host, args, ctx)],
  ['update', (host, args, ctx) => commandActions.cmdUpdate(host, args, ctx)],
  ['u', (host, args, ctx) => commandActions.cmdUpdate(host, args, ctx)],
  ['clone', (host, args, ctx) => commandActions.cmdClone(host, args, ctx)],
]);

/** 命令名 → 命令处理函数查表分发；无匹配时返回与旧 default 分支一致的文案。 */
function dispatchCommand(
  router: CommandRouter,
  cmd: string | undefined,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult | null> | CommandResult | null {
  const handler = COMMAND_SPECS.get(cmd ?? '');
  if (!handler) {
    return { text: `未知命令 /${cmd}，输入 /help 查看可用命令` };
  }
  return handler(router, args, ctx);
}

export class CommandRouter {
  sessionStore: SessionStore;
  /** 飞书桥接实例（public：测试直接访问断言，替代 as unknown as）。 */
  bridge: Bridge;
  /** 当前配置（public：测试直接读取断言，替代 as unknown as）。 */
  config: AppConfig;
  /** 配置文件的绝对路径（public：/config 保存链路与测试共用）。 */
  configPath: string;
  workspaceStore: WorkspaceStore;
  orderStore: OrderStore;
  exitHandler: () => void;
  pendingExit = false;
  /**
   * Spawns the detached replacement bridge process (same argv/config dir) and
   * returns its pid. Injected from index.ts; /restart is unavailable without it.
   */
  restartSpawner?: () => number;
  /**
   * 冲刷装配器窗口内未提交的入站 turn（/exit、/restart 干净退出前调用，
   * 避免静默期窗口内的内容丢失）。index.ts 注入。
   */
  flushInbound?: () => Promise<void>;
  idleTimeoutMs: number;
  /** Dev mode flag: --dev means the bridge was started from source (bun src/index.ts). */
  devMode: boolean;
  /** Cache file for version checks (<configDir>/update-cache.json). */
  updateCachePath?: string;

  /** 复制分身状态机（/clone 入口 + 活跃期消息拦截）。 */
  cloneSession?: CloneSession;
  /** Injected update functions (for testability; defaults to real implementation). */
  updateFns: {
    checkLatestVersion: (opts?: {
      cachePath?: string;
      bypassCache?: boolean;
    }) => Promise<VersionCheckResult>;
    compareVersions: (current: string, latest: string) => -1 | 0 | 1 | null;
    runInstallLatest: () => Promise<InstallResult>;
  };
  /** /config 卡片编辑暂存区（public：测试直接读取断言，替代 as unknown as）。 */
  pendingConfig: AppConfig | null = null;
  /**
   * /config 后台渲染队列状态（合并窗口 + 串行 tail）。回调链不等待它：
   * 被点击的卡由回调响应体原地替换，兄弟卡 PATCH 在这里串行合并。
   */
  configRenderState = createConfigRenderState();
  /**
   * `/c` 打开时目录预取超预算转后台的那条 Promise（链式保留）。
   * 卡片发送（拿到 messageId 并登记）之后才接上刷卡片：否则预取先落地时，
   * 新卡还没登记，后台渲染会漏掉它——DSH 新增 provider 后打开 `/c` 看不到新目录。
   *
   * 链式而不是覆盖：正常路径上槽位在卡片发出后立刻就被消费，但在发送抛异常等
   * 失败路径上槽位会跨命令留存，此时新的预取不得把旧的挤掉（挤掉只是少一次补刷，
   * 但「谁被丢掉」不可预测）。
   */
  pendingConfigOpenRefresh: ConfigOpenRefreshSlot | undefined;
  /**
   * 已见过的 /config 卡片 messageId（有界，最近的在最后）。
   *
   * 草稿（pendingConfig）是全局一份：/config 文本命令重开卡片时沿用同一份草稿
   * （这是既有语义，不改）。但**视图**是每张卡一份 —— 只刷新被点击的那张，其余
   * 卡片就停在旧视图上：用户在旧卡上看到的和点保存实际提交的是两套内容。
   * 这里记住所有交互过的 config 卡，任何一次编辑/保存
   * 后把草稿刷到每张卡，保证「看到的就是会保存的」。
   */
  configCardIds = new Set<string>();
  /**
   * 排队条目身份 key 的唯一铸造计数器（order.exec 与卡片动作共用）。
   *
   * 一张飞书卡片可以被点击 N 次，卡片 messageId 与入队动作是 1:N；而排队
   * 条目的身份必须与「一次入队动作」1:1（queuedTasks 的定位、queueCardMessages
   * 的卡片更新、begin 路径的取消判据全部按这个 key 做 lookup）。复用卡片 id
   * 会让同 key 的多条任务互相顶替：位置显示与撤销都命中最早那条兄弟，卡片更新
   * 互相覆盖（连点 Compact 三次 → 三张排队卡都显示「第 1 位」，撤销/执行态
   * 落到错误条目）。
   *
   * Date.now() 不够（两次同步调用可落在同一毫秒）；计数器与时间无关，恒唯一。
   */
  queueTaskKeyCounter = 0;
  /**
   * Per-user sort preference for /ws list (memory-only, not persisted).
   * Default 'recent' (most recently used first), can toggle to 'alpha'.
   */
  wsSortPreference = new Map<string, 'recent' | 'alpha'>();
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
   * 串行化 config.* 卡片回调。
   * CardKit 2.0 input/button 回调经 `enqueueImmediate` 分发，**不进串行队列**，
   * 多次快速点击下拉/文本框会并发读写 `pendingConfig` 并同时调
   * `updateCardInPlace` → Feishu API 乱序到达，控件卡死在某个状态。
   * 此 Promise chain 把所有 config.* 动作串成一个执行链，保证后到的动作
   * 等前一个动作的卡片 patch 完成后再读 `pendingConfig`。
   */
  configActionQueue: Promise<void> = Promise.resolve();

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
    /** 复制分身状态机（/clone；index.ts 构造注入，未注入时命令回报不可用）。 */
    cloneSession?: CloneSession;
    /** Override update functions for testability. */
    updateFns?: {
      checkLatestVersion?: (opts?: {
        cachePath?: string;
        bypassCache?: boolean;
      }) => Promise<VersionCheckResult>;
      compareVersions?: (current: string, latest: string) => -1 | 0 | 1 | null;
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
    this.cloneSession = opts.cloneSession;
    this.updateFns = {
      checkLatestVersion: opts.updateFns?.checkLatestVersion ?? defaultCheckLatestVersion,
      compareVersions: opts.updateFns?.compareVersions ?? defaultCompareVersions,
      runInstallLatest: opts.updateFns?.runInstallLatest ?? defaultRunInstallLatest,
    };
  }

  /**
   * Resolve the active session reader for the current defaultAgent.
   * The reader is fetched from the registry each time to reflect config changes.
   */
  get sessionReader(): AgentSessionReader {
    return this.sessionReaderRegistry.get(this.config.defaultAgent);
  }

  /**
   * 注入入站装配器的冲刷回调（/exit、/restart 干净退出前调用，
   * 避免静默期窗口内未提交的 turn 丢失）。index.ts 在构造后接线。
   */
  setInboundFlusher(flush: () => Promise<void>): void {
    this.flushInbound = flush;
  }

  /**
   * Route a message: if it starts with /, handle as command; if it starts with !, execute as bash; otherwise forward to Claude.
   *
   * 命令识别前置条件（`inbound-unified-input-design.md` §5.6）：
   * 裸前缀判定会被结构占位符命中 —— SDK 把富文本里的图片渲染成 `![image](img_v3_…)`，
   * 首字符恰好是 `!`，整段用户消息被当 shell 命令执行（`executeBash "[image](img_v3_…"`）。
   * 因此命令前缀只在「调用方声明纯文本 + 剥离占位符后非空且无占位符 + 首字符是 / 或 !」
   * 三条同时成立时生效，其余一律按文本转发。
   */
  async handle(
    message: string,
    ctx: CommandContext,
    opts?: { cwdOverride?: string; binding?: AgentBinding; allowCommandPrefix?: boolean },
  ): Promise<CommandResult | null> {
    const trimmed = message.trim();
    // 双保险：任何调用点都必须先剥离结构占位符，再判命令前缀
    //（index.ts 传 allowCommandPrefix = rawContentType === 'text'，但那层不是唯一入口）。
    const guard = stripPlaceholders(trimmed);
    // 默认 true：order.exec 等既有内部调用点传的是用户已确认的指令文本，
    // 且剥离后无占位符 —— 默认放行不改变它们的语义（见 command-guard.test.ts）。
    const allowCommandPrefix = opts?.allowCommandPrefix ?? true;
    const commandEligible = allowCommandPrefix && guard.kinds.length === 0 && guard.clean !== '';
    const startsWithBang = commandEligible && guard.clean.startsWith('!');
    const startsWithSlash = commandEligible && guard.clean.startsWith('/');
    getLogger().info(
      `[router] handle message="${message.slice(0, 50)}..." trimmed="${trimmed.slice(0, 50)}..." startsWithSlash=${startsWithSlash} startsWithBang=${startsWithBang}`,
    );

    // 复制分身流程活跃期：一切消息（含命令）交给 clone 状态机处理，
    // 不转发 coding agent、不进命令分发（index.ts 已在入队前拦截，这里
    // 兜住 order.exec 等其他 router.handle 入口）。
    if (this.cloneSession?.isActive()) {
      await this.cloneSession.handleMessage(trimmed, ctx);
      return null;
    }

    if (startsWithSlash) {
      const result = await this.executeCommand(guard.clean, ctx);
      if (result) {
        // 只有 /config 卡需要登记：其他命令保持两参数调用，避免改变
        // 既有调用形式（测试与代调用方均按两参数断言）。
        if (result.trackConfigCard) {
          await this.bridge.sendResult(result, ctx, {
            onCardSent: (messageId) => {
              // /config 卡片发送成功后即登记：deferred 目录刷新（cmdConfig 超预算
              // 转后台的预取）与后续 config.* 兄弟卡扇出才能覆盖这张刚打开的卡。
              rememberConfigCard(this, messageId);
            },
          });
          this.consumeConfigOpenRefresh(ctx);
        } else {
          await this.bridge.sendResult(result, ctx);
        }
      }
      if (this.pendingExit) {
        // 干净退出前冲刷装配器窗口内未提交的入站 turn，避免静默期窗口内的内容丢失。
        await this.flushInbound?.();
        // 后台渲染队列里的兄弟卡 PATCH 同样是未完成的工作：直接退出会让其它
        // 配置卡停在旧草稿上。给一个短预算，网络慢就不等（进程要能退出去）。
        await Promise.race([this.flushConfigRender(), sleepUnref(CONFIG_EXIT_FLUSH_BUDGET_MS)]);
        this.exitHandler();
      }
      return result;
    }

    // Handle bang commands (!command)
    if (startsWithBang) {
      const cmd = guard.clean.slice(1).trim();
      if (!cmd) {
        await this.bridge.sendResult({ text: '请输入要执行的命令，例如 !ls' }, ctx);
        return null;
      }
      await this.bridge.executeBash(cmd, ctx);
      return null;
    }

    // Forward to Claude (pass the enqueue-time cwd through so the
    // run uses the same cwd as the serial queue lane, even if /cd ran while
    // the message was queued)
    // 剥离占位符后再转发：agent 只该看到用户文本（附图已转成 attachments 块，
    // 那是装配器生成的协议块，stripPlaceholders 会原样保留）。
    await this.bridge.forwardToClaude(guard.clean, ctx, opts);
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
    // 审批家族以 APPROVAL_ACTION_SPECS keys 为单一来源分发
    // （原 7 个 case 与 spec keys 是同一份知识的两份拷贝，已两次漂移）。
    if (APPROVAL_ACTION_CMDS.includes(value.cmd)) {
      return this.handleApprovalAction(value, ctx);
    }
    const handler = CARD_ACTION_SPECS.get(value.cmd);
    if (handler) {
      return handler(this, value, ctx);
    }
    if (value.cmd.startsWith('help.')) {
      await this.handleHelpAction(value, ctx);
      return;
    }
    await this.handleUnknownCardAction(value, ctx);
    return;
  }

  /**
   * Help card buttons: help.<cmd> → execute /<cmd>.
   * /exit、/restart 等命令通过 pendingExit 表达"回复送达后退出"。
   * handle() 在 sendResult 后消费它；help.* 按钮点击走 handleCardAction，
   * 必须同样消费，否则点击 /restart 按钮 spawn 成功后旧进程不退出，
   * 新进程撞单例锁退出 → 重启两头落空（2026-08-01 红绿 anchor 锁定）。
   */
  async handleHelpAction(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    const subCmd = value.cmd.slice(5); // e.g. "status", "ps", "stop"
    const result = await this.executeCommand(`/${subCmd}`, ctx);
    if (result) {
      await this.bridge.sendResult(result, ctx);
    }
    if (this.pendingExit) {
      await this.flushInbound?.();
      this.exitHandler();
    }
  }

  /**
   * Design constraint: miss paths must reply via bridge.sendResult —
   * don't silently swallow unknown card actions.
   */
  async handleUnknownCardAction(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    getLogger().warn(`[router] unknown card action: ${value.cmd}`);
    await this.bridge.sendResult({ text: `⚠️ 未知的卡片操作: ${value.cmd}` }, ctx);
  }

  /**
   * Handle approval-related card actions.
   * Routes to the appropriate bridge method based on value.cmd.
   * Returns a toast response for immediate user feedback.
   */
  /** 答案类操作的统一失败反馈：重复投递（同一 nonce 第二次点击）是已生效的
   *  中性事件，报 error 会误导（首次点击实际已成功）。 */
  answerFailureToast(msg: string): CardActionResponse {
    if (/already submitted \(duplicate nonce\)/.test(msg)) {
      return { toast: { type: 'info', content: '该选项已处理，请勿重复点击' } };
    }
    return { toast: { type: 'error', content: `答案提交失败：${msg}` } };
  }

  async handleApprovalAction(
    value: CardActionPayload,
    _ctx: CommandContext,
  ): Promise<CardActionResponse> {
    const spec = APPROVAL_ACTION_SPECS[value.cmd];
    if (!spec) {
      return { toast: { type: 'error', content: '未知的审批操作' } };
    }
    if (spec.missing(value)) {
      return { toast: { type: 'error', content: spec.missingToast } };
    }
    try {
      await spec.run(this.bridge, value);
      return { toast: { type: spec.toastType ?? 'success', content: spec.successToast } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return spec.failureToast ? spec.failureToast(msg) : this.answerFailureToast(msg);
    }
  }

  /** 测试/关停用：冲刷合并窗口并等待后台渲染队列排空。 */
  async flushConfigRender(): Promise<void> {
    return flushConfigRender(this);
  }

  /**
   * 登记一次 `/c` 的后台目录预取：预取落地且卡片已发出后再补刷一次。
   * 多次登记链在一起，不会互相覆盖。
   */
  trackConfigOpenRefresh(prefetch: Promise<unknown>, before: string): void {
    const previous = this.pendingConfigOpenRefresh;
    const current = prefetch.catch((err: unknown) => {
      // 失败保留上次成功清单，签名不变则不补刷；这里只落日志。
      getLogger().warn(`[router] /config 后台模型清单预取失败: ${(err as Error).message}`);
    });
    this.pendingConfigOpenRefresh = {
      // 连开多次 /c 时保留最早的基线：期间任何一次目录变化都该补刷。
      before: previous?.before ?? before,
      prefetch: previous ? Promise.all([previous.prefetch, current]) : current,
    };
  }

  /**
   * 只在 `/config` 卡片发出后消费预取槽位：别的命令的结果不代表面板已就位，
   * 提前消费会用无上下文命令的时机触发一次空刷。
   */
  private consumeConfigOpenRefresh(ctx: CommandContext): void {
    const slot = this.pendingConfigOpenRefresh;
    if (!slot) return;
    this.pendingConfigOpenRefresh = undefined;
    // 预取落地后比一次目录签名：清单没变就一次 PATCH 都不发。稳态下省掉
    // 最多 5 张卡的网络写，也避开飞书 230429 单消息更新频限。
    void slot.prefetch.then(() => {
      const after = configActions.captureCatalogSignature(this);
      if (after === slot.before) {
        return;
      }
      scheduleConfigRender(this, {
        ctx,
        refreshCatalogs: false,
        skipRemember: true,
      });
    });
  }

  async executeCommand(message: string, ctx: CommandContext): Promise<CommandResult | null> {
    const parts = message.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    // 飞书会把短间隔连发的消息合并成一条换行分隔的消息（见 findMergedCommandTail）。
    // 先提示被忽略的内容，再照常执行第一条命令，避免第二条被静默丢弃。
    const mergedTail = findMergedCommandTail(message);
    if (mergedTail) {
      await this.bridge.sendResult(
        {
          text:
            `⚠️ 已忽略：${mergedTail}\n` +
            '一条消息只能执行一条命令\n' +
            '如果发得太快，也可能被飞书合并成一条消息',
        },
        ctx,
      );
    }

    return dispatchCommand(this, cmd, args, ctx);
  }

  // --- 测试与入口层使用的公开 seam ---
  // 路由表已直接调用 actions 函数；这里只保留测试/入口真正调用的少数入口，
  // 不再为每个卡片动作维护一层同名转发。

  cmdHelp(): CommandResult {
    return commandActions.cmdHelp(this);
  }

  cmdStatus(ctx: CommandContext): CommandResult {
    return commandActions.cmdStatus(this, ctx);
  }

  cmdOrder(args: string[], ctx: CommandContext, offset = 0): CommandResult {
    return commandActions.cmdOrder(this, args, ctx, offset);
  }

  cmdWs(args: string[], ctx: CommandContext, offset = 0, q?: string): CommandResult {
    return commandActions.cmdWs(this, args, ctx, offset, q);
  }

  cmdLs(
    args: string[],
    ctx: CommandContext,
    offset = 0,
    rootDir?: string,
    q?: string,
    trail?: Array<{ path: string; offset: number }>,
  ): CommandResult {
    return commandActions.cmdLs(this, args, ctx, offset, rootDir, q, trail);
  }

  cmdResume(args: string[], ctx: CommandContext, offset = 0): CommandResult {
    return commandActions.cmdResume(this, args, ctx, offset);
  }

  cmdActive(_args: string[], _ctx: CommandContext, offset = 0): CommandResult {
    return commandActions.cmdActive(this, _args, _ctx, offset);
  }

  resolveOrderExecForQueue(orderId: string): { orderText: string; internalKey: string } | null {
    return orderActions.resolveOrderExecForQueue(this, orderId);
  }

  mintQueueTaskKey(kind: string, id?: string): string {
    return queueActions.mintQueueTaskKey(this, kind, id);
  }

  buildConfigCard(): CommandResult {
    return configActions.buildConfigCard(this);
  }

  prefetchConfigCardCatalogs(force = false, ctx?: CommandContext): Promise<void> {
    return configActions.prefetchConfigCardCatalogs(this, force, ctx);
  }

  ensurePendingConfig(): void {
    configActions.ensurePendingConfig(this);
  }

  setNestedValue(target: AppConfig, key: string, value: unknown): void {
    configActions.setNestedValue(this, target, key, value);
  }

  diffConfig(original: AppConfig, pending: AppConfig): Record<string, string | undefined> {
    return configActions.diffConfig(this, original, pending);
  }

  dispatchConfigAction(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return configActions.dispatchConfigAction(this, value, ctx);
  }
}
