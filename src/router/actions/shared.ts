// 命令路由的共享原语：模块级纯函数、卡片回调类型与常量。
// index.ts 与 actions/* 同层消费，避免 actions 运行时反向 import index.ts 成环。
import { clampInt } from '../../common/clamp.js';
import {
  parseJumpOffset,
  PAGE_JUMP_INVALID_HINT,
  SEARCH_INPUT_NAME,
} from '../../card/card-helpers.js';
import { AGENT_KINDS } from '../../agent-kinds.js';
import type { AgentKind } from '../../agent-kinds.js';
import type { SessionStore } from '../../session/index.js';
import { agentDisplayName } from '../../card/card-shared.js';

/** Payload carried by a card button click. */
export interface CardActionPayload {
  cmd: string;
  path?: string;
  name?: string;
  runId?: string;
  /** 终态卡「停止」的目标后台任务 id（DSH job/list 的 jobId）。 */
  jobId?: string;
  sessionId?: string;
  /** 目标工作目录（queue.* 卡片动作定位队列；stop 等卡片回传执行目录）。 */
  cwd?: string;
  messageId?: string;
  userId?: string;
  chatId?: string;
  key?: string;
  /** /ls 与 /resume 列表分页起点（条目数）。 */
  offset?: number;
  /**
   * `/ls` 浏览起点（本次 `/ls <dir>` 指定的目录；省略时 = cwd）。
   * 卡片上的「返回」按钮回到这里，而不是回到会话工作目录。
   */
  root?: string;
  /**
   * `/ls` 浏览痕：上级目录的原页码（只记录离开时不在第 1 页的目录）。
   * 「上级」/「返回」据此回到进入子目录时所在的那页。服务端零状态，随卡片
   * callback value 传递。
   */
  trail?: Array<{ path: string; offset: number }>;
  /** `/ls` 进入子目录时来源目录的当前页（条目 offset），写入新卡的 trail。 */
  from?: number;
  /** /resume 列表的 agent 类型。 */
  agent?: string;
  /** /resume 列表页大小覆盖。 */
  pageSize?: number;
  /**
   * /ws 与 /ls 列表的关键词筛选（空/缺省 = 无筛选）。服务端零状态：只随卡片
   * callback value 传递，且仅在非空时注入，旧卡片 payload 形态不变。
   */
  q?: string;
  /**
   * 「清除筛选」按钮标记。按钮 callback 不带 input_value，但显式标记比依赖
   * 「读不到输入值」更稳（部分客户端可能把输入框残值一并回传）。
   */
  clearQuery?: boolean;
  option?: string;
  formValue?: Record<string, unknown>;
  /** CardKit 2.0 input 组件提交（键盘回车/完成键）时回传的输入值 */
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
export interface CardActionResponse {
  toast?: {
    type: 'success' | 'info' | 'error' | 'warning' | 'loading';
    content: string;
  };
  [key: string]: unknown;
}

/**
 * 归一化卡片分页参数：clamp pageSize 到 [1,maxPageSize]，offset 归整为
 * 非负整数并对齐到页边界。非数字 payload（如 'abc'）不得产生 NaN slice。
 *
 * 「跳转页码」输入框（paginationBar 内置）的提交值优先于 offset；非法输入
 * 返回 `error` 文案，调用方应回错误 toast 且不刷新卡片。
 *
 * resume.page / active.page 共用，避免两处重复实现分页归一化。
 */
export function normalizePageArgs(
  value: { pageSize?: unknown; offset?: unknown; inputValue?: unknown },
  maxPageSize: number,
): { pageSize: number; alignedOffset: number; error?: string } {
  const rawPageSize = Number(value.pageSize);
  const pageSize = Number.isFinite(rawPageSize)
    ? clampInt(Math.trunc(rawPageSize), 1, maxPageSize)
    : maxPageSize;
  const jump = parseJumpOffset(value.inputValue, pageSize);
  if (jump === null) {
    return { pageSize, alignedOffset: 0, error: PAGE_JUMP_INVALID_HINT };
  }
  if (jump !== undefined) {
    return { pageSize, alignedOffset: Math.floor(jump / pageSize) * pageSize };
  }
  const rawOffset = Number(value.offset);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  return { pageSize, alignedOffset: Math.floor(offset / pageSize) * pageSize };
}

/** /active 卡片每页显示的最大条目数（agent run + bash run 合计）。 */
export const ACTIVE_PAGE_SIZE = 20;

/** 卡片 cardAction payload 缺字段的统一报错文案（原先 12 处手写且已漂移出两种前缀）。 */
export const CARD_PAYLOAD_MISSING = '⚠️ 卡片 payload 缺少必要信息';

export function payloadOffset(value: { offset?: number }): number {
  return Math.max(0, Math.trunc(Number(value.offset) || 0));
}

/**
 * 搜索框提交值单源读取：`inputValue` 主路（CardKit 2.0 input 提交（键盘回车/
 * 完成键）经 raw `action.input_value` 回传，SDK normalizer 会丢弃
 * `action.input_value`，依赖 connector 的 includeRawEvent）+
 * `formValue[searchInput]` 回退。空串/纯空白一律归一为 undefined = 清除筛选，
 * 不是报错也不是无操作。「清除筛选」按钮带 `clearQuery`，直接短路为 undefined。
 */
export function searchQueryFrom(value: CardActionPayload): string | undefined {
  if (value.clearQuery) return undefined;
  const raw = value.inputValue ?? (value.formValue?.[SEARCH_INPUT_NAME] as string | undefined);
  return raw?.trim() || undefined;
}

export interface ConfigSwitchResult {
  /** 切换通知文案（未切换 agent 时为 undefined） */
  notice: string | undefined;
  /** 切换后的新 agent（仅 agent 切换时有值） */
  newAgent?: AgentKind;
  /** 切换后恢复/使用的 sessionId（空串 = 已清空，undefined = 未切换 agent） */
  sessionId?: string;
}

export interface DefaultAgentSwitchOutcome {
  notice: string | undefined;
  newAgent: AgentKind | undefined;
  sessionId: string | undefined;
}

/**
 * 回执里的工作区行（`📁 <cwd>`，无 cwd 落 `(未设置)` 占位）。「下一条消息
 * 从哪儿开新对话」类回执（/new 与 agent 切换的清空分支）共用此格式，避免
 * 两处各写一份文案后漂移。
 */
export function workspaceLine(sessionStore: SessionStore, userId: string): string {
  // 空串同样是「未设置」：SessionStore 为任何写过的用户建条目，cwd 缺省是 ''，
  // 只判 undefined 会把 `📁 ` 发到用户面前。
  const cwd = sessionStore.getCwd(userId);
  return `📁 ${cwd || '(未设置)'}`;
}

/**
 * 「开新会话」的统一入口（/new 命令与 run 卡「✨ 新会话」按钮共用）：
 * 清当前 agent 的会话绑定（含 per-agent sessionCwd；主 cwd 保留——/new 后
 * /resume 仍能用原工作目录），返回带工作区的回执文案。
 *
 * 两条触发路径必须走这里，回执不允许再分叉（§9.19：按操作语义分类，
 * 不按触发方式分类）。
 */
export function applyNewSession(
  sessionStore: SessionStore,
  agentKind: AgentKind,
  userId: string,
): string {
  sessionStore.clearSessionId(userId, agentKind, { clearSessionCwd: true });
  return `已创建新 ${agentDisplayName(agentKind)} 会话，下一条消息将开始全新对话\n${workspaceLine(sessionStore, userId)}`;
}

/**
 * 记住并同步刷新的 config 卡片数上限。一次 /config 会话里用户实际会交互的
 * 卡片只有最近一两张，5 张足够覆盖；无上限会让长跑进程的 Set 随卡片数增长。
 */
export const MAX_CONFIG_CARDS = 5;

/**
 * config 回调响应的目标预算（ms）。飞书要求卡片回调 3 秒内响应；扣掉
 * message-handlers 的 flush 等待与网络往返，router 侧最多占 1.5s。
 *
 * 卡片动作把网络写全部移进后台渲染队列后，这个数只用于埋点里的
 * `budget_exceeded` 标记（验证回调链里是否还有意外阻塞），不再用于
 * `Promise.race` 抢占响应——抢占会留下一个仍在后台跑的 tail 传染后续动作。
 */
export const CONFIG_CALLBACK_BUDGET_MS = 1_500;

/** 后台渲染队列的合并窗口（ms）：连点期间的多次草稿变更合并成一次 PATCH 扇出。 */
export const CONFIG_RENDER_DEBOUNCE_MS = 250;

/** `/c` 打开时等待动态目录预取的上限（ms）：超时立即用缓存/兜底清单出卡。 */
export const CONFIG_OPEN_PREFETCH_BUDGET_MS = 200;

/**
 * `config.save` 切换 Agent 的持久化通知在回调内发送的上限（ms）。
 *
 * 这条通知是本回调里唯一的网络写（锚定契约要求它是持久消息，不走后台渲染
 * 队列）。没有预算时，网络长尾会把回调拖过飞书 3 秒上限——而写盘已经完成，
 * 用户看到的是「超时未响应」。超时后通知转后台补发（见 sendSwitchNotice）。
 */
export const CONFIG_SWITCH_NOTICE_BUDGET_MS = 1_200;

/**
 * 退出前冲刷后台渲染队列的上限（ms）。`/exit`、`/restart` 之前不该丢掉已经
 * 算好的兄弟卡 PATCH，但进程必须能退出去——网络卡住时不等。
 */
export const CONFIG_EXIT_FLUSH_BUDGET_MS = 800;

export const APPROVAL_AGENT_KINDS: string[] = ['codex', 'kimi', 'opencode'];

export function touchesAgentsSubtree(keys: readonly string[], kind: string): boolean {
  return keys.some((k) => k === `agents.${kind}` || k.startsWith(`agents.${kind}.`));
}

/**
 * 本次改动是否触及某个 agent 的配置——两种键形态都要认：现行 `agents.<kind>[.*]`
 * 与历史的顶层 `<kind>[.*]`（claude 至今是顶层键）。判定曾抄在三处（agent 变更检测 /
 * agentChoices 同步 / approval 热推），每加一个 agent 都得记得改三遍，与
 * AGENT_KINDS 名单漂移是同一种事故，这里收成一处。
 */
export function touchesAgentConfig(keys: readonly string[], kind: string): boolean {
  return (
    touchesAgentsSubtree(keys, kind) || keys.some((k) => k === kind || k.startsWith(`${kind}.`))
  );
}

export function computeHasAgentConfigChange(changedKeys: string[]): boolean {
  if (changedKeys.includes('defaultAgent')) return true;
  for (const kind of AGENT_KINDS) {
    if (touchesAgentConfig(changedKeys, kind)) return true;
  }
  return false;
}

export function computeHasApprovalConfigChange(changedKeys: string[]): boolean {
  for (const kind of APPROVAL_AGENT_KINDS) {
    if (touchesAgentConfig(changedKeys, kind)) return true;
  }
  return changedKeys.includes('agents.dsh.permissionPreset');
}

/**
 * defaultAgent 切换时的 session 迁移（Step 0-3）。抽为模块级命名函数，
 * 避免其内部分支与判定闭包计入外层 propagateConfigSave 的 CC。
 */
export function applyDefaultAgentSwitch(
  sessionStore: SessionStore,
  userId: string,
  oldDefaultAgent: AgentKind,
  newAgent: AgentKind,
): DefaultAgentSwitchOutcome {
  // Step 0: 在清空 old 之前计算「用户活动」基线差（arrival 基线）：
  const oldSessionId = sessionStore.getSessionId(userId, oldDefaultAgent);
  const oldArrivalSessionId = sessionStore.getArrivalSessionId(userId, oldDefaultAgent);
  const userChangedOld = (oldSessionId ?? '') !== (oldArrivalSessionId ?? '');

  // Step 1: 保存旧 agent 的 session 到 previousSessions（如果有）
  if (oldSessionId) {
    sessionStore.setPreviousSessionId(userId, oldDefaultAgent, oldSessionId);
  }

  // Step 2: 清除旧 agent 的 session（保存后清除，为新会话腾出空间）
  sessionStore.clearSessionId(userId, oldDefaultAgent);

  // Step 2.5: 显式选择判定
  const newSessionId = sessionStore.getSessionId(userId, newAgent);
  const newArrivalSessionId = sessionStore.getArrivalSessionId(userId, newAgent);
  const userSelectedNew = !!newSessionId && (newSessionId ?? '') !== (newArrivalSessionId ?? '');

  // Step 3: 恢复判定
  const previousSessionId = sessionStore.getPreviousSessionId(userId, newAgent);
  const canRestore = !!previousSessionId && !userChangedOld;

  if (userSelectedNew) {
    sessionStore.setArrivalSessionId(userId, newAgent, newSessionId);
    const newAgentName = agentDisplayName(newAgent);
    return {
      notice: `已切换到 ${newAgentName}，已使用所选 session，sessionId: ${newSessionId}`,
      newAgent,
      sessionId: newSessionId!,
    };
  }
  if (canRestore) {
    sessionStore.setSessionId(userId, newAgent, previousSessionId);
    sessionStore.clearPreviousSessionId(userId, newAgent);
    sessionStore.setArrivalSessionId(userId, newAgent, previousSessionId);
    const newAgentName = agentDisplayName(newAgent);
    return {
      notice: `已切换到 ${newAgentName}，将继续之前的 session，sessionId: ${previousSessionId}`,
      newAgent,
      sessionId: previousSessionId,
    };
  }
  sessionStore.clearSessionId(userId, newAgent, { clearSessionCwd: true });
  sessionStore.setArrivalSessionId(userId, newAgent, '');
  const newAgentName = agentDisplayName(newAgent);
  // 清空分支 = 「下一条消息在此工作区开新对话」，回执与 /new 同形（含 📁 工作区）。
  // 恢复/显式选择分支不加：它们的 Resume 卡 header 已有 `📂 <cwd>` 行，再加
  // 一行 📁 会让同一个目录在卡上出现两遍。
  return {
    notice: `已切换到 ${newAgentName}，session 已清空，下次消息将启动新对话\n${workspaceLine(sessionStore, userId)}`,
    newAgent,
    sessionId: '',
  };
}

/**
 * DSH 会话边界变更（preset/host）共用的 notice 计算。返回更新后的 notice；
 * 条件不满足时原样返回 currentNotice，等价于原闭包「不修改」的语义。
 */
export function parkDshSessionBoundaryNotice(
  sessionStore: SessionStore,
  userId: string,
  defaultAgent: AgentKind,
  changed: boolean,
  label: string,
  currentNotice: string | undefined,
): string | undefined {
  if (!changed || defaultAgent !== 'dsh' || currentNotice) return currentNotice;
  const oldSessionId = sessionStore.getSessionId(userId, 'dsh');
  if (oldSessionId) {
    sessionStore.setPreviousSessionId(userId, 'dsh', oldSessionId);
    sessionStore.clearSessionId(userId, 'dsh');
    return `DSH ${label} 已变更，旧会话已停放到恢复槽（可 /resume 校验后恢复），下次消息将新建会话`;
  }
  return `DSH ${label} 已变更，下次消息将新建会话`;
}
