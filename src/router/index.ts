import type { SessionStore, SessionReaderRegistry } from '../session/index.js';
import type { AppConfig } from '../config/index.js';
import type { Bridge, CommandContext, CommandResult } from '../bridge/index.js';
import type { AgentBinding } from '../bridge/queue-manager.js';
import { WorkspaceStore } from '../workspace/index.js';
import { OrderStore, type OrderEntry } from '../order/index.js';
import { resolveAlias } from '../order/alias-resolve.js';
import type { AgentKind } from '../agent-kinds.js';
import type { AgentSessionContentEvent, AgentSessionReader } from '../session-contract.js';
import { getLogger } from '../logger/index.js';
import { logConfigPerf } from '../common/config-perf.js';

/** /config 打开时登记的后台目录探测槽位。 */
interface ConfigOpenRefreshSlot {
  /** 探测点火前的目录签名；落地后比对，没变化就不补刷卡片。 */
  before: string;
  prefetch: Promise<unknown>;
}
import type { CloneSession } from '../clone.js';
import { stripPlaceholders } from '../inbound/placeholder.js';
import type { SessionDisplayUsage } from '../card/usage-format.js';
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
} from './actions/config-render.js';
import * as commandActions from './actions/command-actions.js';
import type { CardActionPayload, CardActionResponse } from './actions/shared.js';
import type { ConfigSwitchResult } from './actions/shared.js';
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

type CardActionMethod =
  | 'cardLsFile'
  | 'handleLsRefresh'
  | 'handleLsBrowse'
  | 'handleLsSwitch'
  | 'handleLsPage'
  | 'handleLsFilter'
  | 'handleWsPage'
  | 'handleWsFilter'
  | 'handleWsUse'
  | 'handleWsSort'
  | 'handleWsRemove'
  | 'handleResumeUse'
  | 'handleResumePage'
  | 'handleActivePage'
  | 'handleNewSession'
  | 'handleCardStop'
  | 'handleJobKill'
  | 'handleQueueCancel'
  | 'handleQueueImmediate'
  | 'handleQueueDiagnose'
  | 'handleQueueEdit'
  | 'handleQueueInput'
  | 'handleOrderDelete'
  | 'handleOrderPage'
  | 'handleOrderAliasEdit'
  | 'handleOrderAliasInput'
  | 'handleOrderAliasRemove'
  | 'handleOrderTextEdit'
  | 'handleOrderTextInput'
  | 'enqueueConfigAction'
  | 'handleCompact'
  | 'handleResumeCompact'
  | 'handleStopSession';

type CardActionArgStyle = 'path' | 'ctxOnly' | 'voidCall' | 'returnCall';

type CardActionInvoker = (
  ...args: unknown[]
) => Promise<CardActionResponse | void> | CardActionResponse | void;

const CARD_ACTION_SPECS = new Map<string, { method: CardActionMethod; args: CardActionArgStyle }>([
  ['ls.file', { method: 'cardLsFile', args: 'path' }],
  ['ls.refresh', { method: 'handleLsRefresh', args: 'voidCall' }],
  ['ls.browse', { method: 'handleLsBrowse', args: 'voidCall' }],
  ['ls.switch', { method: 'handleLsSwitch', args: 'voidCall' }],
  ['ls.page', { method: 'handleLsPage', args: 'returnCall' }],
  ['ls.filter', { method: 'handleLsFilter', args: 'returnCall' }],
  ['ws.page', { method: 'handleWsPage', args: 'returnCall' }],
  ['ws.filter', { method: 'handleWsFilter', args: 'returnCall' }],
  ['ws.use', { method: 'handleWsUse', args: 'returnCall' }],
  ['ws.sort', { method: 'handleWsSort', args: 'returnCall' }],
  ['ws.remove', { method: 'handleWsRemove', args: 'returnCall' }],
  ['resume.use', { method: 'handleResumeUse', args: 'voidCall' }],
  ['resume.page', { method: 'handleResumePage', args: 'returnCall' }],
  ['active.page', { method: 'handleActivePage', args: 'returnCall' }],
  ['new-session', { method: 'handleNewSession', args: 'ctxOnly' }],
  ['stop', { method: 'handleCardStop', args: 'voidCall' }],
  ['job.kill', { method: 'handleJobKill', args: 'voidCall' }],
  ['queue.cancel', { method: 'handleQueueCancel', args: 'voidCall' }],
  ['queue.immediate', { method: 'handleQueueImmediate', args: 'voidCall' }],
  ['queue.diagnose', { method: 'handleQueueDiagnose', args: 'voidCall' }],
  ['queue.edit', { method: 'handleQueueEdit', args: 'voidCall' }],
  ['queue.input', { method: 'handleQueueInput', args: 'returnCall' }],
  ['order.delete', { method: 'handleOrderDelete', args: 'returnCall' }],
  ['order.page', { method: 'handleOrderPage', args: 'returnCall' }],
  ['order.aliasEdit', { method: 'handleOrderAliasEdit', args: 'returnCall' }],
  ['order.aliasInput', { method: 'handleOrderAliasInput', args: 'returnCall' }],
  ['order.aliasRemove', { method: 'handleOrderAliasRemove', args: 'returnCall' }],
  ['order.textEdit', { method: 'handleOrderTextEdit', args: 'returnCall' }],
  ['order.textInput', { method: 'handleOrderTextInput', args: 'returnCall' }],
  ['config.set', { method: 'enqueueConfigAction', args: 'returnCall' }],
  ['config.input', { method: 'enqueueConfigAction', args: 'returnCall' }],
  ['config.refresh', { method: 'enqueueConfigAction', args: 'returnCall' }],
  ['config.save', { method: 'enqueueConfigAction', args: 'returnCall' }],
  ['compact', { method: 'handleCompact', args: 'voidCall' }],
  ['resume.compact', { method: 'handleResumeCompact', args: 'voidCall' }],
  ['stop.session', { method: 'handleStopSession', args: 'voidCall' }],
]);

type CommandMethod =
  | 'cmdHelp'
  | 'cmdStatus'
  | 'cmdPs'
  | 'cmdStop'
  | 'cmdExit'
  | 'cmdRestart'
  | 'cmdNew'
  | 'cmdCd'
  | 'cmdLs'
  | 'cmdDownload'
  | 'cmdWs'
  | 'cmdResume'
  | 'cmdActive'
  | 'cmdConfig'
  | 'cmdOrder'
  | 'cmdUpdate'
  | 'cmdClone';

type CommandArgStyle = 'none' | 'ctxOnly' | 'argsCtx';

type CommandInvoker = (...args: unknown[]) => Promise<CommandResult | null> | CommandResult | null;

const COMMAND_SPECS = new Map<string, { method: CommandMethod; args: CommandArgStyle }>([
  ['help', { method: 'cmdHelp', args: 'none' }],
  ['h', { method: 'cmdHelp', args: 'none' }],
  ['status', { method: 'cmdStatus', args: 'ctxOnly' }],
  ['s', { method: 'cmdStatus', args: 'ctxOnly' }],
  ['ps', { method: 'cmdPs', args: 'ctxOnly' }],
  ['stop', { method: 'cmdStop', args: 'ctxOnly' }],
  ['t', { method: 'cmdStop', args: 'ctxOnly' }],
  ['exit', { method: 'cmdExit', args: 'none' }],
  ['quit', { method: 'cmdExit', args: 'none' }],
  ['e', { method: 'cmdExit', args: 'none' }],
  ['restart', { method: 'cmdRestart', args: 'none' }],
  ['new', { method: 'cmdNew', args: 'ctxOnly' }],
  ['cd', { method: 'cmdCd', args: 'argsCtx' }],
  ['ls', { method: 'cmdLs', args: 'argsCtx' }],
  ['download', { method: 'cmdDownload', args: 'argsCtx' }],
  ['d', { method: 'cmdDownload', args: 'argsCtx' }],
  ['ws', { method: 'cmdWs', args: 'argsCtx' }],
  ['resume', { method: 'cmdResume', args: 'argsCtx' }],
  ['r', { method: 'cmdResume', args: 'argsCtx' }],
  ['active', { method: 'cmdActive', args: 'argsCtx' }],
  ['config', { method: 'cmdConfig', args: 'argsCtx' }],
  ['c', { method: 'cmdConfig', args: 'argsCtx' }],
  ['order', { method: 'cmdOrder', args: 'argsCtx' }],
  ['o', { method: 'cmdOrder', args: 'argsCtx' }],
  ['update', { method: 'cmdUpdate', args: 'argsCtx' }],
  ['u', { method: 'cmdUpdate', args: 'argsCtx' }],
  ['clone', { method: 'cmdClone', args: 'argsCtx' }],
]);

/** 命令名 → 命令方法查表分发；无匹配时返回与旧 default 分支一致的文案。 */
function dispatchCommand(
  router: CommandRouter,
  cmd: string | undefined,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult | null> | CommandResult | null {
  const spec = COMMAND_SPECS.get(cmd ?? '');
  if (!spec) {
    return { text: `未知命令 /${cmd}，输入 /help 查看可用命令` };
  }
  const handler = (router as unknown as Record<CommandMethod, CommandInvoker>)[spec.method];
  if (spec.args === 'none') {
    return handler.call(router);
  }
  if (spec.args === 'ctxOnly') {
    return handler.call(router, ctx);
  }
  return handler.call(router, args, ctx);
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
   * 的卡片更新、taskIndex 的取消判据全部按这个 key 做 lookup）。复用卡片 id
   * 会让同 key 的多条任务互相顶替：位置显示命中最早那条兄弟、第一条开始时删掉
   * 索引导致其余兄弟被判「已撤销」静默丢弃（连点 Compact
   * 三次 → 三张排队卡都显示「第 1 位」、两张永久停在「等待中」，只压缩一次）。
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
              this.rememberConfigCard(messageId);
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
    const spec = CARD_ACTION_SPECS.get(value.cmd);
    if (spec) {
      // Map 查表取出的是未绑定方法，必须显式 .call(this, ...) 保留类实例上下文。
      const handler = this[spec.method] as unknown as CardActionInvoker;
      if (spec.args === 'path') {
        await handler.call(this, value.path, ctx);
        return;
      }
      if (spec.args === 'ctxOnly') {
        await handler.call(this, ctx);
        return;
      }
      // voidCall 对应原 switch 的 `await this.xxx(...); return;`，丢弃返回值。
      if (spec.args === 'voidCall') {
        await handler.call(this, value, ctx);
        return;
      }
      return handler.call(this, value, ctx);
    }
    if (value.cmd.startsWith('help.')) {
      await this.handleHelpAction(value, ctx);
      return;
    }
    await this.handleUnknownCardAction(value, ctx);
    return;
  }

  /**
   * resume.use: 从 /resume 列表卡切换到所选会话。
   */
  async handleResumeUse(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    return sessionActions.handleResumeUse(this, value, ctx);
  }

  /** new-session: 清空当前会话绑定，下一条消息开始全新对话。 */
  async handleNewSession(ctx: CommandContext): Promise<void> {
    return sessionActions.handleNewSession(this, ctx);
  }

  /** compact: 对当前会话发起压缩（bridge 收口）。 */
  async handleCompact(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    return sessionActions.handleCompact(this, value, ctx);
  }

  /** resume.compact: 对 /resume 选中的历史会话发起压缩（bridge 收口）。 */
  async handleResumeCompact(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    return sessionActions.handleResumeCompact(this, value, ctx);
  }

  /** stop.session: 恢复卡上的「终止」——取消指定 session 的宿主 turn。 */
  async handleStopSession(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    return sessionActions.handleStopSession(this, value, ctx);
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
  /** queue.* 卡片动作通用守卫：cwd/messageId 缺失时回复错误并返回 null。 */
  async queuePayloadOrReply(
    value: { cwd?: string; messageId?: string },
    ctx: CommandContext,
  ): Promise<{ cwd: string; messageId: string } | null> {
    return queueActions.queuePayloadOrReply(this, value, ctx);
  }

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

  /**
   * Handle queue.cancel: remove this message from the queue.
   */
  async handleQueueCancel(
    value: { cwd?: string; messageId?: string },
    ctx: CommandContext,
  ): Promise<void> {
    return queueActions.handleQueueCancel(this, value, ctx);
  }

  /**
   * Handle queue.immediate: stop current run, clear queue before this message, execute this message immediately.
   * Instead of asking user to resend, we keep the target task in queue and let it execute.
   */
  /**
   * 把「执行编辑后的内容」注册成原队列槽位的一次性 replacement（复用入队时
   * 捕获的 binding + 恢复 lane cwd，否则编辑后重跑的 run 会丢 cwd 与绑定）。
   *
   * 重新入队不行：`enqueue` 只能追加到 promise 链尾部，会把编辑任务甩到
   * 后来者后面，违背「立即执行 = 下一个就跑」。三个调用点都必须在任何 await
   * 之前注册——begin 路径消费 replacement 的时机不可预测（见
   * handleQueueImmediate 步骤 1.5 的竞态说明）。
   */
  registerEditedReplacement(
    cwd: string,
    messageId: string,
    content: string,
    binding: AgentBinding | undefined,
    ctx: CommandContext,
  ): void {
    return queueActions.registerEditedReplacement(this, cwd, messageId, content, binding, ctx);
  }

  async handleQueueImmediate(
    value: { cwd?: string; messageId?: string },
    ctx: CommandContext,
  ): Promise<void> {
    return queueActions.handleQueueImmediate(this, value, ctx);
  }

  /**
   * 清掉排在目标之前的所有排队任务，返回实际清除条数。
   *
   * 两条红线：
   * - 目标可能在 interruptCurrentRun 等待期间已经接跑（链并发前进），那时它已不在
   *   快照里，剩下的全部排在它**后面**——清除必须在目标位置之前停下，不得越界删掉
   *   用户没要求清除的任务。
   * - 移除循环必须整体同步：队列链在任何 await 处都会推进（卡片 PATCH 也算），
   *   一旦让出事件循环，用户要求清除的任务可能趁撤销卡还在路上就跑起来了。
   *   撤销卡片由 `removeFromQueue` 统一触发（fire-and-forget）。
   */
  clearTasksAheadOfTarget(cwd: string, messageId: string): number {
    return queueActions.clearTasksAheadOfTarget(this, cwd, messageId);
  }

  /**
   * `queue.immediate` 的终态反馈（唯一出口）。
   *
   * 承诺必须与真实调度一致：目标只有确实是停止后的下一个，才可以把它的卡翻成
   * 「执行中」并说「将立即执行」；在途接跑/被撤销/被抢先/远程停止未确认四种状态
   * 各给各的文案（把没发生的事说成发生了，比沉默更糟——用户会据文案决定要不要重发）。
   */
  async reportImmediateOutcome(opts: {
    cwd: string;
    messageId: string;
    ctx: CommandContext;
    removedCount: number;
    stopped: boolean;
    stopUnconfirmed: boolean;
    agentKind?: AgentKind;
  }): Promise<void> {
    return queueActions.reportImmediateOutcome(this, opts);
  }

  /**
   * Handle queue.diagnose: show diagnostic info for why message is queuing.
   */
  async handleQueueDiagnose(
    value: { cwd?: string; messageId?: string; userId?: string; chatId?: string },
    ctx: CommandContext,
  ): Promise<void> {
    return queueActions.handleQueueDiagnose(this, value, ctx);
  }

  /**
   * Handle queue.edit: show input field for editing the queued message.
   */
  async handleQueueEdit(
    value: { cwd?: string; messageId?: string },
    ctx: CommandContext,
  ): Promise<void> {
    return queueActions.handleQueueEdit(this, value, ctx);
  }

  /**
   * Handle queue.input: update the queued message with new content.
   * Returns a CardActionResponse carrying both a toast (immediate feedback,
   * no separate message sent) and a `card` field so Feishu renders the
   * updated queue card in place, closing the edit form. A toast-only response
   * leaves the card stuck in the edit state (Feishu keeps the pre-click card
   * when the callback response has no `card` field).
   */
  async handleQueueInput(
    value: {
      cwd?: string;
      messageId?: string;
      inputValue?: string;
      formValue?: Record<string, unknown>;
    },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return queueActions.handleQueueInput(this, value, ctx);
  }

  /**
   * 分页卡动作的 offset 解析：优先读取「跳转页码」输入框（paginationBar 内置
   * 的 CardKit 2.0 input），未输入则回退 `payload.offset`（上一页/下一页按钮）。
   * 非法页码返回 `{ error }`，调用方应回错误 toast 且不刷新卡片。
   */
  pagingOffset(
    value: CardActionPayload,
    defaultPageSize: number,
  ): { offset: number } | { error: string } {
    return lsActions.pagingOffset(this, value, defaultPageSize);
  }

  /**
   * Handle ls.switch: switch cwd to target directory after path validation.
   */
  async handleLsSwitch(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    return lsActions.handleLsSwitch(this, value, ctx);
  }

  /**
   * Handle ls.refresh: reload current directory.
   */
  async handleLsRefresh(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    return lsActions.handleLsRefresh(this, value, ctx);
  }

  /**
   * ls 卡片动作的统一出口：命令返回 card 时原地刷新；只返回 text（目录读取
   * 失败等）时必须把文案发给用户，不能对 `card.card!` 传 undefined——那样
   * updateCardInPlace 失败后 sendResult({card:undefined}) 也直接返回 false，
   * 用户点了按钮没有任何反馈、真实错误被吞掉。
   */
  async refreshLsCard(result: CommandResult, ctx: CommandContext): Promise<void> {
    return lsActions.refreshLsCard(this, result, ctx);
  }

  /**
   * Handle ls.page: paginate to a specific offset.
   */
  async handleLsPage(value: CardActionPayload, ctx: CommandContext): Promise<CardActionResponse> {
    return lsActions.handleLsPage(this, value, ctx);
  }

  /**
   * Handle ls.filter: 按搜索框提交的关键词重新渲染当前目录卡。
   *
   * offset 恒重置为 0（新筛选从第 1 页开始）。路径校验与 TOCTOU 兜底照
   * handleLsPage——校验失败只回错误 toast，绝不动卡片（否则用户看到一张空卡）。
   * ls.browse / ls.switch 的 value 里刻意不带 q，换目录即清除筛选。
   */
  async handleLsFilter(value: CardActionPayload, ctx: CommandContext): Promise<CardActionResponse> {
    return lsActions.handleLsFilter(this, value, ctx);
  }

  /**
   * Handle resume.page: paginate the /resume session list in place.
   * Mirrors handleLsPage — updates the same card, never sends a new one.
   */
  async handleResumePage(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    return sessionActions.handleResumePage(this, value, ctx);
  }

  /**
   * Handle active.page: paginate the /active run list in place.
   * Mirrors handleResumePage — updates the same card, never sends a new one.
   */
  async handleActivePage(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    return sessionActions.handleActivePage(this, value, ctx);
  }

  /**
   * Handle ls.browse: browse directory without switching cwd.
   */
  async handleLsBrowse(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    return lsActions.handleLsBrowse(this, value, ctx);
  }

  /**
   * Handle stop card action: interrupt current run.
   */
  async handleCardStop(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    return sessionActions.handleCardStop(this, value, ctx);
  }

  /**
   * Handle a terminal card's 「停止」 on one background job.
   *
   * 任务跨 run 生命周期，所以卡片按钮是唯一入口；失败必须给出可读原因
   * （任务已自行结束、服务重启后快照被回收），不能点了没反应。
   */
  async handleJobKill(value: CardActionPayload, ctx: CommandContext): Promise<void> {
    return sessionActions.handleJobKill(this, value, ctx);
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
    return orderActions.resolveOrderExecForQueue(this, orderId);
  }

  /**
   * 铸造一个排队条目身份 key（唯一铸造点）。
   *
   * 调用方：order.exec 文本钩子（resolveOrderExecForQueue）与入口层
   * （index.ts）的非即时卡片动作入队。卡片 messageId 只能当「回复目标」
   * （`taskMeta.feishuReplyTo`），不得当队列 key —— 理由见
   * `queueTaskKeyCounter` 字段注释。
   */
  mintQueueTaskKey(kind: string, id?: string): string {
    return queueActions.mintQueueTaskKey(this, kind, id);
  }
  /**
   * 单源：重建 order/ws 列表卡（不投递，card 进 callback 响应体用）。
   * `q` 只服务 ws 卡的关键词筛选；order 卡无此功能，不透传。
   */
  rebuildListCard(
    kind: 'order' | 'ws',
    offset: number,
    ctx: CommandContext,
    q?: string,
  ): object | undefined {
    return orderActions.rebuildListCard(this, kind, offset, ctx, q);
  }

  /**
   * 单源：「重建列表卡 → updateCardInPlace」原地刷新骨架（列表卡删除/
   * 翻页/移除/排序/筛选动作共用）。返回重建后的卡片；无卡时返回 undefined 且跳过更新。
   */
  async refreshListCard(
    kind: 'order' | 'ws',
    value: { offset?: number; q?: string },
    ctx: CommandContext,
  ): Promise<object | undefined> {
    return orderActions.refreshListCard(this, kind, value, ctx);
  }

  /**
   * 单源：order 三个 input handler（aliasInput/aliasRemove/textInput）
   * 的公共骨架——校验 orderId → reload+find → mutate → 成功后 toast + raw 卡。
   * mutate 返回 error 时仅回 error toast，不重渲染。
   * 注意：本 helper 只服务「toast + card 进响应体」语义（飞书需用响应体原地
   * 替换 pre-click 编辑卡）；updateCardInPlace 原地刷新走 refreshListCard。
   */
  async mutateOrderAndRefreshCard(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
    opts: { missingToast: string },
    mutate: (order: OrderEntry) => { ok: true; toast: string } | { ok: false; error: string },
  ): Promise<CardActionResponse | void> {
    return orderActions.mutateOrderAndRefreshCard(this, value, ctx, opts, mutate);
  }

  /**
   * Handle order.delete: remove the order and update card in place.
   */
  async handleOrderDelete(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return orderActions.handleOrderDelete(this, value, ctx);
  }

  /**
   * Handle order.page: paginate the /order list in place.
   * Mirrors handleLsPage — updates the same card, never sends a new one.
   */
  async handleOrderPage(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    return orderActions.handleOrderPage(this, value, ctx);
  }

  /**
   * Handle order.aliasEdit: 展示别名编辑卡（input，回车/完成键提交）。
   * 有别名时预填；提交 `order.aliasInput` 处理（含校验与唯一性）。
   */
  /**
   * order 编辑卡公共骨架：payload 校验 → 查指令 → 构造 input 编辑卡 → 原地更新。
   * handleOrderAliasEdit / handleOrderTextEdit 原先各持一份 ~90% 相同的 4 段结构。
   */
  async showOrderEditCard(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
    opts: {
      title: string;
      hint: string;
      inputName: string;
      placeholder: string;
      defaultValue: string;
      inputCmd: 'order.aliasInput' | 'order.textInput';
      maxLength?: number;
    },
  ): Promise<CardActionResponse | void> {
    return orderActions.showOrderEditCard(this, value, ctx, opts);
  }

  /** 编辑卡的公共取件：重读 store 并按 orderId 定位（alias/text 两个编辑 handler 共用）。 */
  findOrderForEdit(orderId?: string) {
    return orderActions.findOrderForEdit(this, orderId);
  }

  async handleOrderAliasEdit(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return orderActions.handleOrderAliasEdit(this, value, ctx);
  }

  /**
   * Handle order.aliasInput: 提交别名（绑/改/解绑），随后重渲染 /order 列表卡。
   * 留空 = 解绑；非空按命名规则 + 全局唯一校验，失败仅 toast 不重渲染。
   */
  async handleOrderAliasInput(
    value: {
      orderId?: string;
      offset?: number;
      inputValue?: string;
      formValue?: Record<string, unknown>;
    },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return orderActions.handleOrderAliasInput(this, value, ctx);
  }

  /** Handle order.aliasRemove: 删除某条指令的别名并原地重渲染列表卡。 */
  async handleOrderAliasRemove(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return orderActions.handleOrderAliasRemove(this, value, ctx);
  }

  /**
   * Handle order.textEdit: 展示指令文本编辑卡（input，回车/完成键提交）。
   * 预填当前 text（完整内容，不截断——input 组件有自有滚动条）；
   * 提交 `order.textInput` 处理（trim + 长度校验 + OrderStore.updateText）。
   * 完全镜像 handleOrderAliasEdit 的 4 段结构（reload → find → 构造 editCard →
   * updateCardInPlace）。
   */
  async handleOrderTextEdit(
    value: { orderId?: string; offset?: number },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return orderActions.handleOrderTextEdit(this, value, ctx);
  }

  /**
   * Handle order.textInput: 提交指令文本编辑。校验 orderId → OrderStore.updateText
   * （store 内部统一 trim + 空/超长校验）。成功 toast + 原地重渲染列表卡（同
   * handleOrderAliasInput 语义：toast-only 响应会让飞书停留在 pre-click 编辑卡，
   * 必须把 card 放进 callback 响应体）；失败仅 error toast。
   * 保留 usedAt / alias / createdAt（OrderStore.updateText 只动 text 字段）。
   */
  async handleOrderTextInput(
    value: {
      orderId?: string;
      offset?: number;
      inputValue?: string;
      formValue?: Record<string, unknown>;
    },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return orderActions.handleOrderTextInput(this, value, ctx);
  }

  /**
   * Handle ws.use card action: switch to the cwd, then refresh the /ws
   * list card in place so "recent" sort order is immediately visible.
   *
   * Unlike the command-line `/ws use` (which returns text), the card action
   * uses toast + inplace refresh for a cleaner UX (matching ws.remove/ws.sort).
   * If auto-resume produces a card, it is sent as a separate reply.
   */
  async handleWsUse(
    value: { name?: string; offset?: number; q?: string },
    ctx: CommandContext,
  ): Promise<CardActionResponse> {
    return orderActions.handleWsUse(this, value, ctx);
  }

  /**
   * Handle ws.remove: remove the cwd alias and refresh the /ws list card
   * in place (mirrors handleOrderDelete). Without this the stale alias would
   * remain visible on the card the user just clicked.
   */
  async handleWsRemove(
    value: { name?: string; offset?: number; q?: string },
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return orderActions.handleWsRemove(this, value, ctx);
  }

  /**
   * Handle ws.page: paginate the /ws list in place.
   * Mirrors handleOrderPage — updates the same card, never sends a new one.
   */
  async handleWsPage(value: CardActionPayload, ctx: CommandContext): Promise<CardActionResponse> {
    return orderActions.handleWsPage(this, value, ctx);
  }

  /**
   * Handle ws.filter: 按搜索框提交的关键词重新渲染列表卡。
   * offset 恒重置为 0（新筛选从第 1 页开始）；提交空串 = 清除筛选。
   */
  async handleWsFilter(value: CardActionPayload, ctx: CommandContext): Promise<CardActionResponse> {
    return orderActions.handleWsFilter(this, value, ctx);
  }

  /**
   * Handle ws.sort: toggle sort preference and refresh the /ws list card.
   * Sort preference is memory-only (not persisted); restart resets to 'recent'.
   */
  async handleWsSort(value: CardActionPayload, ctx: CommandContext): Promise<CardActionResponse> {
    return orderActions.handleWsSort(this, value, ctx);
  }

  /**
   * `ls.file` card button: send file to Feishu, rejecting if > 30MB.
   */
  async cardLsFile(target: string | undefined, ctx: CommandContext): Promise<void> {
    return lsActions.cardLsFile(this, target, ctx);
  }

  /**
   * 校验并发送本地文件到飞书（≤30MB）。成功返回 null（文件已发出），失败返回
   * 错误 CommandResult 由调用方展示。
   *
   * `/download` 与 `ls.file` 卡片按钮共用，避免两处重复 30MB/存在性校验。
   */
  async deliverFileToFeishu(resolved: string, ctx: CommandContext): Promise<CommandResult | null> {
    return lsActions.deliverFileToFeishu(this, resolved, ctx);
  }

  // --- PendingConfig 辅助方法 ---

  /** 确保 pendingConfig 已初始化（从当前 config 克隆） */
  ensurePendingConfig(): void {
    return configActions.ensurePendingConfig(this);
  }

  /**
   * 记住一张 config 卡片 messageId（有界：超限丢最早的一张）。
   * 无 messageId 的调用（测试/文本路径）不登记。
   */
  rememberConfigCard(messageId: string | undefined): void {
    return configActions.rememberConfigCard(this, messageId);
  }

  /**
   * 把当前草稿刷到所有已知 config 卡片上（后台渲染队列调用）。
   * 被点击的卡由回调响应体的 `card` 字段原地替换，这里只刷兄弟卡；
   * `excludeMessageId` 跳过它，避免同消息重复 PATCH 触发飞书 230429。
   * 返回各段耗时与成功 PATCH 数，供 `event=render` 埋点。
   */
  async refreshConfigCards(excludeMessageId?: string): Promise<configActions.ConfigRefreshStats> {
    return configActions.refreshConfigCards(this, excludeMessageId);
  }

  /** 调度后台渲染（同步返回，不等待任何网络写）。 */
  scheduleConfigRender(req: import('./actions/config-render.js').ConfigRenderRequest): void {
    scheduleConfigRender(this, req);
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
        logConfigPerf('render', {
          skipped: true,
          merged: 0,
          patches: 0,
          t_build_ms: 0,
          t_patch_ms: 0,
        });
        return;
      }
      this.scheduleConfigRender({
        ctx,
        refreshCatalogs: false,
        skipRemember: true,
      });
    });
  }

  /**
   * 把一次字段变更交给当前 agent 的 config builder（处理 provider→model 这类
   * 依赖关系），逐条写进草稿。`config.set`（下拉）与 `config.input`（输入框提交）
   * 共用同一套应用逻辑。apply 段只做内存操作，卡片由响应体 + 后台队列更新。
   */
  async applyConfigFieldChange(
    key: string,
    newValue: string,
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return configActions.applyConfigFieldChange(this, key, newValue, ctx);
  }

  /**
   * 串行化 config.* 卡片回调（修复连击卡死 bug）。
   *
   * CardKit 2.0 input/button 回调经 `enqueueImmediate` 分发，不进 bridge 的
   * 串行队列；多次快速点击下拉/文本框会并发读写 `pendingConfig` 并同时调
   * `updateCardInPlace` → 两个 patch 请求乱序到达飞书，后到达的 patch（点击 1
   * 的旧卡片）覆盖先到达的 patch（点击 2 的新卡片），用户看到控件卡死。
   *
   * 此方法把所有 config.* 动作串成一个 Promise chain：每个动作等前一个动作
   * 的 `updateCardInPlace` 完全 settle 后再读 `pendingConfig`。
   */
  enqueueConfigAction(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return configActions.enqueueConfigAction(this, value, ctx);
  }

  /** 实际的 config.* 分发逻辑（在串行队列内执行） */
  /** config.* 卡片动作分发（public：测试直接调用，替代 as unknown as）。 */
  async dispatchConfigAction(
    value: CardActionPayload,
    ctx: CommandContext,
  ): Promise<CardActionResponse | void> {
    return configActions.dispatchConfigAction(this, value, ctx);
  }

  /** 设置嵌套属性值（仅修改内存对象，不写盘） */
  /** 在 pendingConfig 上按 dot-separated key 设置嵌套值（config 卡片编辑用）。 */
  setNestedValue(target: AppConfig, key: string, value: unknown): void {
    return configActions.setNestedValue(this, target, key, value);
  }

  diffConfig(original: AppConfig, pending: AppConfig): Record<string, string | undefined> {
    return configActions.diffConfig(this, original, pending);
  }

  /**
   * config 写盘后的运行时传播（自 config.save 卡片路径抽出，卡片保存与
   * `/config <key> <value>` 文本直写两条路径共用）。
   *
   * 1. bridge 运行时值同步：setConfig + idle watchdog timeout；
   * 2. agent 配置或 defaultAgent 变更 → clearRunners（否则 runner 缓存继续用旧
   *    配置值，/status 与真实 run 自相矛盾）；
   * 3. defaultAgent 切换 → 旧 agent session 存 previousSessions、新 agent 恢复
   *    或清空（等效 /new）；
   * 4. 当前 agent 配置变更 → syncAgentChoices 并原子写盘（禁裸同步写盘，
   *    写一半崩溃会截断 config.yaml 导致 bridge 起不来）。
   *
   * @param updates 以 config 路径形式给出的变更 key（卡片路径来自 diffConfig；
   *   直写路径传 mapAgentKey(key)，保证 pi./codex./opencode./kimi. 命中 agents.*）。
   * @returns 结构化切换结果（含 notice 文案 + 新 agent/sessionId 信息）
   */
  propagateConfigSave(
    oldDefaultAgent: AgentKind,
    updates: Record<string, string | undefined>,
    ctx: CommandContext,
  ): ConfigSwitchResult {
    return configActions.propagateConfigSave(this, oldDefaultAgent, updates, ctx);
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

  // --- Command implementations ---

  cmdHelp(): CommandResult {
    return commandActions.cmdHelp(this);
  }

  /** /status 实现（public：测试直接调用，替代 as any）。 */
  cmdStatus(ctx: CommandContext): CommandResult {
    return commandActions.cmdStatus(this, ctx);
  }

  cmdPs(ctx: CommandContext): CommandResult {
    return commandActions.cmdPs(this, ctx);
  }

  async cmdStop(ctx: CommandContext): Promise<CommandResult | null> {
    return commandActions.cmdStop(this, ctx);
  }

  async cmdExit(): Promise<CommandResult> {
    return commandActions.cmdExit(this);
  }

  cmdRestart(): CommandResult {
    return commandActions.cmdRestart(this);
  }

  /**
   * /update: check for newer version and upgrade if available.
   * /update check: only check, don't upgrade.
   *
   * Flow: check version → if newer, install → report success (no auto-restart).
   */
  async cmdUpdate(args: string[], ctx: CommandContext): Promise<CommandResult> {
    return commandActions.cmdUpdate(this, args, ctx);
  }

  /**
   * /clone [name] — 复制分身：进入 clone 状态机（发二维码、等扫码、自动绑定）。
   * 全程由 CloneSession 自己经 connector 发消息（含二维码图片），故返回 null。
   */
  async cmdClone(args: string[], ctx: CommandContext): Promise<CommandResult | null> {
    return commandActions.cmdClone(this, args, ctx);
  }

  cmdNew(ctx: CommandContext): CommandResult {
    return commandActions.cmdNew(this, ctx);
  }

  cmdCd(args: string[], ctx: CommandContext): CommandResult {
    return commandActions.cmdCd(this, args, ctx);
  }

  readSessionDisplayState(
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
    return commandActions.readSessionDisplayState(this, sessionId, cwd, opts);
  }

  /**
   * Shared logic for switching cwd with user feedback.
   * Used by cmdCd, cmdWs use, and handleLsSwitch to ensure consistent behavior:
   * 1. Set cwd (and clear sessionId per §9.1)
   * 2. Auto-resume newest session if available
   * 3. Return appropriate CommandResult (auto-resume card or plain text)
   */
  switchCwdAndNotify(userId: string, canonical: string, _ctx: CommandContext): CommandResult {
    return commandActions.switchCwdAndNotify(this, userId, canonical, _ctx);
  }

  /** Build card for auto-resumed session with new session button */
  buildAutoResumeCard(
    cwd: string,
    session: { sessionId: string; summary: string },
    _ctx: CommandContext,
  ): CommandResult {
    return commandActions.buildAutoResumeCard(this, cwd, session, _ctx);
  }

  /**
   * Shared body of the two "resume-like" cards（cwd 切换后的 auto-resume 与
   * config.save 换 agent）：两者都是同一序列 readSessionDisplayState →
   * buildResumeActionButtons → buildSessionHistoryCard，差异仅 4 处——
   * Compact 按钮（仅 auto-resume，canCompactSession 门控）、标题文案、
   * headerText 的「已恢复…会话」行与可选尾部行、空会话占位——全部参数化，
   * 共享序列只留一份（Clean Code DRY）。
   */
  buildResumeLikeCard(opts: {
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
  }): CommandResult {
    return commandActions.buildResumeLikeCard(this, opts);
  }

  /**
   * Build card for config.save agent switch.
   * When the new agent has a restored session, renders a Resume card (shared
   * body via buildResumeLikeCard) with session history + stop/new buttons.
   * When the session was cleared, renders a compact notice card instead.
   */
  buildConfigSwitchCard(switchResult: ConfigSwitchResult, ctx: CommandContext): CommandResult {
    return configActions.buildConfigSwitchCard(this, switchResult, ctx);
  }

  /**
   * Whether a session of the given agent kind can be compacted from a resume
   * card. duck-typing — check if the runner has `runCompact`
   * (codex app-server, kimi acp), instead of hardcoding agentKind === 'codex'.
   */
  canCompactSession(agentKind: string, cwd?: string): boolean {
    return commandActions.canCompactSession(this, agentKind, cwd);
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
  buildResumeActionButtons(opts: {
    isActive: boolean;
    activeRunRunId?: string;
    cwd: string;
    compact?: { sessionId: string; agentKind: string };
    /** 宿主侧仍有 turn：绑定 sessionId/cwd/agent，走 session/cancel。 */
    hostStop?: { sessionId: string; agentKind: string; cwd: string };
    newSession?: boolean;
  }): object[] {
    return commandActions.buildResumeActionButtons(this, opts);
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
   * @param trail   上级目录原页码（「上级/返回」回到进入子目录时所在页）。
   *                省略 = 上级都从第 1 页开始。
   */
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

  /**
   * `/download <path>`（别名 `/d`）：把本地文件直接发送到飞书。
   *
   * 路径解析与 `/ls` 一致：`~` 展开到 home；相对路径基于当前 cwd（无 cwd 时
   * 必须给绝对路径）。成功时文件本身即回复，返回 null（不额外发文本）。
   */
  async cmdDownload(args: string[], ctx: CommandContext): Promise<CommandResult | null> {
    return commandActions.cmdDownload(this, args, ctx);
  }

  cmdWs(args: string[], ctx: CommandContext, offset = 0, q?: string): CommandResult {
    return commandActions.cmdWs(this, args, ctx, offset, q);
  }

  /**
   * DSH /resume preset 一致性校验：返回 mismatch 详情，或 undefined（一致/不可判定）。
   *
   * session 的 preset 在创建时固定（§2.1）。通过 listSessions 拿到目标 session 的
   * agentPreset 与当前配置比对：不一致时不静默复用（返回提示），一致或查询失败
   * （无法判定）时不阻断，避免 DSH 离线导致 /resume 完全不可用。
   */
  dshPresetMismatch(
    reader: AgentSessionReader,
    sessionId: string,
    cwd: string,
  ): { sessionPreset: string; currentPreset: string } | undefined {
    return commandActions.dshPresetMismatch(this, reader, sessionId, cwd);
  }

  cmdResume(args: string[], ctx: CommandContext, offset = 0): CommandResult {
    return commandActions.cmdResume(this, args, ctx, offset);
  }

  cmdActive(_args: string[], _ctx: CommandContext, offset = 0): CommandResult {
    return commandActions.cmdActive(this, _args, _ctx, offset);
  }

  /**
   * Build CardKit 2.0 /active card from bridge memory (not file system).
   * Shows only runs that were started by THIS bridge process.
   * Paginates with ACTIVE_PAGE_SIZE (default 20) items per page.
   */
  buildActiveCardFromMemory(
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
    return commandActions.buildActiveCardFromMemory(this, activeRuns, activeBashRuns, offset);
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
  appendActiveCardSection<T extends { runId: string; cwd: string; terminal: string }>(
    elements: object[],
    runs: T[],
    title: string,
    renderRows: (run: T, statusLabel: string) => object[],
    remaining: number,
    skipped: number,
  ): { remaining: number; skipped: number } {
    return commandActions.appendActiveCardSection(
      this,
      elements,
      runs,
      title,
      renderRows,
      remaining,
      skipped,
    );
  }

  async cmdConfig(args: string[], ctx: CommandContext): Promise<CommandResult> {
    return configActions.cmdConfig(this, args, ctx);
  }

  /**
   * 卡片构建前的动态清单预取。
   *
   * - **DSH**：`/config` 打开时强制刷新模型/预设目录，Web UI 刚新增的 provider
   *   立即可见；失败回退固定兜底清单。
   * - **CodeBuddy**：模型清单只随 ACP `session/new` 下发，且目录是
   *   f(登录态, 区域)。这里按账号指纹（`settings.json` 的 mtime+size）决定是否
   *   重探：切换 CodeBuddy 登录后第一次打开 `/config` 就能看到新模型，而不是
   *   等下一条消息 401 才被动重建。指纹/区域变化时顺带重置持久 sessionId 与
   *   runner（它们绑在旧身份上，不重置会在失效端点重放 401）。
   *
   * 预取失败不阻断——两个 builder 内部都有兜底（DSH 固定清单、CodeBuddy 文本输入）。
   */
  async prefetchConfigCardCatalogs(force = false, ctx?: CommandContext): Promise<void> {
    return configActions.prefetchConfigCardCatalogs(this, force, ctx);
  }

  /** Build an interactive config card with CardKit 2.0 tabs + batch save */
  buildConfigCard(): CommandResult {
    return configActions.buildConfigCard(this);
  }

  /** /order 实现（public：测试直接调用）。 */
  cmdOrder(args: string[], ctx: CommandContext, offset = 0): CommandResult {
    return commandActions.cmdOrder(this, args, ctx, offset);
  }

  resolveOrderTarget(target: string): OrderEntry | undefined {
    return orderActions.resolveOrderTarget(this, target);
  }
}
