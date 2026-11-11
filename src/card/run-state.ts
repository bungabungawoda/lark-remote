import type {
  AgentEvent,
  AssistantEvent,
  BackgroundJobRoster,
  BackgroundJobsEvent,
  RunStatusEvent,
  UserEvent,
  PlanEvent,
  FileChangeEvent,
  ResultEvent,
  ApprovalView,
  TurnStartedEvent,
  TurnDiffEvent,
  FinalAnswerEvent,
  NoticeEvent,
  SessionInfoEvent,
  ToolHint,
  GoalView,
} from '../runner/index.js';
import { keepTail, frontOmissionMarker, FRONT_OMISSION_MARKER_RE } from '../common/truncate.js';
import { asRecord } from '../common/tool-summary.js';
import type { UsageSnapshot } from '../session-contract.js';

const MAX_REASONING_CHARS = 4_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_TOOL_DETAIL_CHARS = 3_000;
const MAX_BLOCKS = 24;

export type RunTerminal =
  | 'running'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'interrupted'
  | 'idle_timeout'
  /**
   * 本轮 turn 已结束，但会话的 goal 仍 active：宿主会自动开始下一轮，任务没有
   * 完成，卡片不得写"完成"。与 done 的差别只在语义与渲染，
   * 卡片同样停止更新。
   */
  | 'goal_continuing';

/**
 * 已收尾的 run 终态集合（卡片不再更新）。
 *
 * 单一来源：事件消费守卫、可压缩记账白名单、Compact 按钮可见性三处共用，
 * 禁止各自再抄一份字面量——三处漂移过一次（goal_continuing 只进白名单不进
 * 按钮判据），新增终态时必漏一处的风险是结构性的。
 */
const RUN_TERMINAL_STATES = [
  'done',
  'error',
  'interrupted',
  'idle_timeout',
  'goal_continuing',
] as const;

export type RunFinalTerminal = (typeof RUN_TERMINAL_STATES)[number];

/** 该状态是否已收尾（非 running/finalizing）。 */
export function isRunTerminal(terminal: RunTerminal): terminal is RunFinalTerminal {
  return (RUN_TERMINAL_STATES as readonly RunTerminal[]).includes(terminal);
}

/** 仍在推进的两个状态（`RunTerminal` 的非终态部分）。 */
type RunActiveTerminal = 'running' | 'finalizing';

/**
 * 该状态是否仍在推进（running 或 finalizing）。
 *
 * `finalizing` 是「result 已到、进程还在收尾」的非终态：卡片仍要处理事件、
 * 仍要显示停止按钮。这个判据此前在 card/bridge 里逐字抄了四处，与
 * `isRunTerminal` 互为反义却各写各的——收在这儿与终态判据并排。
 */
export function isRunActive(terminal: RunTerminal): terminal is RunActiveTerminal {
  return terminal === 'running' || terminal === 'finalizing';
}

export type RunFooter = 'thinking' | 'tool_running' | 'streaming' | null;
/** 中断来源（interrupted 终态的原因），供卡片如实归因。 */
type InterruptedReason = 'approval_timeout' | 'user_stop' | 'approval_cancelled';
type ToolStatus = 'running' | 'ok' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  /**
   * cached parse of `input` (the truncated string) into a record, so
   * `tool-render.ts`'s `asRecord` does not re-`JSON.parse` on every render.
   * Computed once at store time in `reduceAssistantEvent` from the SAME
   * truncated string that the old per-render `asRecord` parsed — so a
   * truncation-broken JSON still yields `null` here (preserving the "over-cap
   * input renders no summary" behavior). `undefined` means "not computed"
   * (ToolEntries built outside the reduce path fall back to parsing `input`).
   */
  parsedInput?: Record<string, unknown> | null;
  output?: string;
  status: ToolStatus;
  startedAt?: string;
  completedAt?: string;
  /** 工具渲染 hint（turn_diff 首见时携带；渲染层只消费不推断）。 */
  toolHint?: ToolHint;
  /** 工具原始 title（ACP kind 映射后与 name 不同时存在；渲染做副标题）。 */
  summary?: string;
}

export type RunBlock =
  | {
      kind: 'thinking';
      /** app-server item id; exec-mode blocks leave it undefined. */
      itemId?: string;
      content: string;
      active: boolean;
      timestamp?: string;
      completedAt?: string;
    }
  | {
      kind: 'text';
      itemId?: string;
      content: string;
      timestamp?: string;
      completedAt?: string;
      archivedAnswer?: true;
    }
  | { kind: 'tool'; tool: ToolEntry }
  | {
      kind: 'plan';
      itemId?: string;
      content: string;
      active: boolean;
      timestamp?: string;
      completedAt?: string;
    }
  | {
      kind: 'file_change';
      itemId?: string;
      path: string;
      operation: 'create' | 'edit' | 'delete' | 'read';
      diff?: string;
      timestamp?: string;
      completedAt?: string;
    };

/** 运行期通知（warning / 重路由 / 压缩提示）。保留到达时间，渲染层可将其
 *  按时间线插入内容流当普通消息；无时间戳时兜底置于内容流末尾。 */
export interface RunNotice {
  level: 'info' | 'warn' | 'error';
  code?: string;
  text: string;
  timestamp?: string;
}

interface FinalAnswerState {
  content: string;
  timestamp?: string;
  complete: boolean;
  source: 'protocol' | 'inferred';
}

/**
 * 一张 run 卡的状态。用量字段（context/tokens/cache/累计/推理）一律来自
 * `UsageSnapshot` 单源——原先在这里、`FinishMeta`、`usage-format` 和桥侧各抄
 * 一份（§9.21「五处一致」靠人记），加一个字段要改四遍。
 */
export interface RunState extends UsageSnapshot {
  runId: string;
  terminal: RunTerminal;
  footer: RunFooter;
  /** 本 run 开始时间（epoch ms）：状态行的「⏱ 12s」由它算出。 */
  startedAt?: number;
  /** 本 run 结束时间（epoch ms）：终态后耗时定格，不再随渲染时刻增长。 */
  finishedAt?: number;
  blocks: RunBlock[];
  /**
   * The answer the user is waiting for. Kept outside `blocks` so progress
   * traffic cannot evict or consume its display budget.
   */
  finalAnswer?: FinalAnswerState;
  sessionId?: string;
  resultSubtype?: 'success' | 'error' | 'interrupted';
  /** interrupted 终态的中断来源；undefined = 未归类（渲染默认文案）。 */
  interruptedReason?: InterruptedReason;
  errorMsg?: string;
  idleTimeoutMinutes?: number;
  plan?: string; // accumulated from PlanEvent (Codex)
  /** 实际生效模型（system.init 携带；失败兜底 synthetic init 为 ''，渲染须容忍）。 */
  model?: string;
  /** 本次 run 花费（USD，result 事件 total_cost_usd）。 */
  costUsd?: number;
  /** 本次 run 积分（result 事件 total_credits，qoder 原样显示；qoder 无 USD 口径）。 */
  credits?: number;
  /** Agent 身份（建 state 时盖章；用量区极简判定等渲染读取）。 */
  agentKind?: string;
  /** 运行期通知（warning / 重路由 / 压缩提示），按到达顺序。 */
  notices?: RunNotice[];
  /** 被 MAX_BLOCKS 静默丢弃的早期块计数（>0 时渲染「已省略 N 个早期步骤」）。 */
  omittedBlocks?: number;
  /** 会话标题（ACP session_info_update.title）。 */
  sessionTitle?: string;
  /** 当前模式（ACP current_mode_update.currentModeId）。 */
  mode?: string;
  /** Codex 操作类型：'turn' 表示普通 run，'compaction' 表示 compact 运行。 */
  operationKind?: 'turn' | 'compaction';
  /**
   * 待审批请求列表（app-server 模式）。同一 turn 内并发多个审批
   * 时全部渲染，避免后到者顶掉先到者的按钮（单槽会丢 UI，只能等超时 cancel）。
   */
  approvals?: Array<{ view: ApprovalView; expired?: boolean }>;
  /**
   * 审批是否曾过期（桥侧 timer 触发，approval_expired 事件置位）。
   * 独立于 approvals 数组持久保存：cancel 送达后 server 会回
   * approval_resolved，把对应审批条目从数组移除，但过期原因必须活到
   * 终态渲染（否则标记被消费后卡片误报「已被用户终止」）。
   */
  approvalExpired?: boolean;
  /**
   * 运行期状态投影（DSH `session/control` 的 contextPressure / sessionStats）。
   *
   * 只在 running/finalizing 渲染成状态行的一条（终态卡有权威 summary，不再
   * 重复）。字段缺省 = 该维度暂无数据。
   */
  liveStatus?: {
    contextUsed?: number;
    contextLimit?: number;
    steps?: number;
    toolMs?: number;
  };
  /**
   * run 结束时仍在后台运行的任务。跨 turn 生命周期：卡片必须说清楚"这一轮
   * 结束了，但还有东西在跑"，并给出逐个停止的入口。
   *
   * 收尾之后这份名单仍会被 `syncBackgroundJobs` 更新（宿主会继续推送任务
   * 生命周期），所以它是"最后一次观测到的名单"，不是"收尾那一刻的名单"。
   */
  backgroundJobs?: BackgroundJobRoster[];
  /**
   * 会话级长期目标（DSH goal）。跨 turn 生命周期：goal 仍 active 时，本轮结束
   * 只是"一轮结束"，宿主会自动续跑，卡片必须显示目标是什么、跑到第几轮。
   */
  goal?: GoalView;
  /**
   * goal 是否被成功观测过。`false` = 探测失败，渲染层不得据此断言"没有目标/
   * 已完成"（把读不到当成没有，就退回了"任务在跑、卡片写完成"的旧缺陷）。
   */
  goalKnown?: boolean;
}

/** 终态卡片的一次性元信息；用量部分与 `RunState` 同源（`UsageSnapshot`）。 */
export interface FinishMeta extends UsageSnapshot {
  resultSubtype?: 'success' | 'error' | 'interrupted';
  /** 中断来源：由桥侧在 finish 时显式传入（/stop → user_stop、审批卡取消 → approval_cancelled）。 */
  interruptedReason?: InterruptedReason;
  errorMsg?: string;
  idleTimeoutMinutes?: number;
}

export function createInitialRunState(runId: string, opts?: { agentKind?: string }): RunState {
  return {
    runId,
    terminal: 'running',
    footer: 'thinking',
    // agent 身份盖章一次（桥建 session 时已知），用量区极简判定等渲染直接读。
    ...(opts?.agentKind ? { agentKind: opts.agentKind } : {}),
    // 状态行的耗时口径：从 run 状态建立那一刻算起（卡片首帧即开始计时）。
    startedAt: Date.now(),
    blocks: [],
  };
}

export function reduceRunState(state: RunState, event: AgentEvent): RunState {
  const next = reduceRunStateInner(state, event);
  if (next === state) return next;
  // 每次迁移后归一：**只有最新一条 text 块**免于存储窗口——它是「输出」，
  // 随时会被提升成最终回答；更早的正文退回进度窗口（内存与元素预算不变）。
  const blocks = capStaleTextBlocks(next.blocks);
  return blocks === next.blocks ? next : { ...next, blocks };
}

// ── 内联分支归约器（模块顶层命名函数）──────────────────────────────────────
// 原来 goal_state / approval_* 五个分支直接写在 reduceRunStateInner 里，连同
// 内部 .map/.filter 箭头闭包一起把 CC 顶到 29。抽成命名函数后外层只留查表。

function reduceGoalStateEvent(state: RunState, event: AgentEvent): RunState {
  const e = event as Extract<AgentEvent, { type: 'goal_state' }>;
  // 覆盖写：每次观测都是宿主的整份快照（phase/轮次/目标全文），不做增量。
  return { ...state, goal: e.goal ?? undefined, goalKnown: e.known };
}

function reduceApprovalRequestedEvent(state: RunState, event: AgentEvent): RunState {
  const e = event as Extract<AgentEvent, { type: 'approval_requested' }>;
  const approvals = state.approvals ?? [];
  const next = { view: e.view, expired: false };
  let idx = -1;
  for (let i = 0; i < approvals.length; i++) {
    if (approvals[i].view.requestId === e.requestId) {
      idx = i;
      break;
    }
  }
  if (idx >= 0) {
    // 同一 requestId 重复到达：原地替换，保持槽位顺序。
    const replaced = approvals.slice();
    replaced[idx] = next;
    return { ...state, approvals: replaced };
  }
  return { ...state, approvals: [...approvals, next] };
}

function reduceApprovalResolvedEvent(state: RunState, event: AgentEvent): RunState {
  const e = event as Extract<AgentEvent, { type: 'approval_resolved' }>;
  const current = state.approvals ?? [];
  const approvals: Array<{ view: ApprovalView; expired?: boolean }> = [];
  for (const a of current) {
    if (a.view.requestId !== e.requestId) approvals.push(a);
  }
  return { ...state, approvals };
}

function reduceApprovalViewUpdatedEvent(state: RunState, event: AgentEvent): RunState {
  const e = event as Extract<AgentEvent, { type: 'approval_view_updated' }>;
  const current = state.approvals ?? [];
  const approvals: Array<{ view: ApprovalView; expired?: boolean }> = [];
  for (const a of current) {
    approvals.push(a.view.requestId === e.requestId ? { ...a, view: e.view } : a);
  }
  return { ...state, approvals };
}

function reduceApprovalExpiredEvent(state: RunState, event: AgentEvent): RunState {
  const e = event as Extract<AgentEvent, { type: 'approval_expired' }>;
  const current = state.approvals ?? [];
  const approvals: Array<{ view: ApprovalView; expired?: boolean }> = [];
  for (const a of current) {
    approvals.push(a.view.requestId === e.requestId ? { ...a, expired: true } : a);
  }
  return { ...state, approvalExpired: true, approvals };
}

type RunStateReducer = (state: RunState, event: AgentEvent) => RunState;

/**
 * event.type → 归约器。用 Map 而非对象字面量：`constructor`/`toString` 这类
 * 事件名会命中 Object.prototype。
 *
 * 表里的归约器各自持有窄事件参数（如 `ResultEvent`），而查表调用处按
 * `event.type` 精确路由后传入的运行时值一定是该窄类型；这里用一次整体类型
 * 断言把「窄参数函数」装进统一签名的表，运行时零影响（不改变任何行为）。
 */
const EVENT_REDUCERS = new Map<string, RunStateReducer>([
  ['system', reduceSystemEvent],
  ['run_status', reduceRunStatusEvent],
  ['goal_state', reduceGoalStateEvent],
  ['background_jobs', reduceBackgroundJobsEvent],
  ['result', reduceResultEvent],
  ['final_answer', reduceFinalAnswerEvent],
  ['assistant', reduceAssistantEvent],
  ['user', reduceToolResultEvent],
  ['plan', reducePlanEvent],
  ['file_change', reduceFileChangeEvent],
  ['notice', reduceNoticeEvent],
  ['session_info', reduceSessionInfoEvent],
  ['turn_started', reduceTurnStartedEvent],
  ['turn_diff', reduceTurnDiffEvent],
  ['approval_requested', reduceApprovalRequestedEvent],
  ['approval_resolved', reduceApprovalResolvedEvent],
  ['approval_view_updated', reduceApprovalViewUpdatedEvent],
  ['approval_expired', reduceApprovalExpiredEvent],
] as unknown as ReadonlyArray<[string, RunStateReducer]>);

/** 单事件 → 单次状态迁移。窗口后置裁剪统一由 `reduceRunState` 做，这里不管。 */
function reduceRunStateInner(state: RunState, event: AgentEvent): RunState {
  // 只有终态才阻止事件处理。finalizing 是非终态，
  // 仍需累积 assistant 内容（thinking、text、tool_use、后台任务输出）。
  if (isRunTerminal(state.terminal)) {
    return state;
  }
  const reduce = EVENT_REDUCERS.get(event.type);
  return reduce ? reduce(state, event) : state;
}

/** Handle app-server turn_started — records the operation kind (turn vs compact). */
function reduceTurnStartedEvent(state: RunState, event: TurnStartedEvent): RunState {
  // DSH goal 轮次：上一轮 result 已把卡片置为 finalizing，但宿主又起了下一轮。
  // 同一张卡必须回到运行中，并把上一轮回答从 finalAnswer 挪回 blocks——下一轮
  // 的回答要重新走 promoteFinalAnswer，否则会被上一轮的 finalAnswer 挤掉。
  if (state.terminal === 'finalizing') {
    const previous = state.finalAnswer;
    const blocks =
      previous && previous.content.trim()
        ? [
            ...state.blocks,
            {
              kind: 'text' as const,
              content: previous.content,
              ...(previous.timestamp ? { timestamp: previous.timestamp } : {}),
              archivedAnswer: true as const,
            },
          ]
        : state.blocks;
    return withCappedBlocks(
      {
        ...state,
        terminal: 'running',
        operationKind: event.operationKind,
        resultSubtype: undefined,
        errorMsg: undefined,
        finalAnswer: undefined,
      },
      blocks,
      'thinking',
    );
  }
  return {
    ...state,
    operationKind: event.operationKind,
    footer: state.footer ?? 'thinking',
  };
}

/**
 * Handle app-server turn_diff events. The translator emits FULL per-item
 * snapshots (accumulated text/reasoning/tool output/plan, current file-change
 * set). Each snapshot is scoped to a thread item (event.itemId); the block is
 * replaced in place to avoid duplication, and a NEW block is appended on the
 * item's first sight — so interleaved items keep their real chronology and
 * the active streaming content sits at the bottom, like the exec path.
 */
// ── turn_diff 字段归约器（模块顶层命名函数）────────────────────────────────
// 原来五个 `if (event.X !== undefined)` 分支连同传给 upsertSnapshotBlock 的
// predicate/fallback/update 箭头闭包一起把 CC 顶到 33。现在每个字段一个命名
// applier，闭包全部抽成模块顶层命名函数，用 Function.prototype.bind 显式携带
// event/ts/complete（不再在函数内部定义新闭包）。

type FileChangeDiff = NonNullable<TurnDiffEvent['fileChanges']>[number];

/** 恒等返回：file_change 的 fallback 与 update 都返回同一个已构造块。 */
function constantBlock(block: RunBlock): RunBlock {
  return block;
}

// -- text --
function textDiffMatches(event: TurnDiffEvent, b: RunBlock): boolean {
  return b.kind === 'text' && b.itemId === event.itemId;
}

function makeTextDiffBlock(
  event: TurnDiffEvent,
  ts: string | undefined,
  complete: boolean,
): RunBlock {
  return {
    kind: 'text' as const,
    itemId: event.itemId,
    // 最新那条正文不设窗口（它是「输出」），capStaleTextBlocks 负责在它被
    // 更新的正文顶替后补上进度窗口。
    content: event.text!,
    timestamp: ts,
    ...(complete ? { completedAt: ts } : {}),
  };
}

function updateTextDiffBlock(
  event: TurnDiffEvent,
  ts: string | undefined,
  complete: boolean,
  existing: RunBlock,
): RunBlock {
  const textBlock = existing as Extract<RunBlock, { kind: 'text' }>;
  return {
    ...textBlock,
    content: event.text!,
    // kimi：块锚点时间改为本次 diff 时间（整轮累积流不断续写，
    // 标题应反映“最后写入时刻”而非首见时刻；move-to-end 后位置
    // 与标题才一致）。codex app-server 不置 refreshTimestamp，
    // 保持“首见时间戳不刷新”的既有契约。
    ...(event.refreshTimestamp ? { timestamp: ts } : {}),
    ...(complete ? { completedAt: ts } : {}),
  };
}

function applyTextDiff(next: RunState, event: TurnDiffEvent): RunState {
  if (event.text === undefined) return next;
  const ts = event.timestamp;
  const complete = event.complete === true;
  const blocks = markThinkingInactive(next.blocks);
  const capped = upsertSnapshotBlock(
    blocks,
    textDiffMatches.bind(null, event),
    makeTextDiffBlock.bind(null, event, ts, complete),
    updateTextDiffBlock.bind(null, event, ts, complete),
    !complete,
  );
  return withCappedBlocks(next, capped, 'streaming');
}

// -- reasoning --
function reasoningDiffMatches(event: TurnDiffEvent, b: RunBlock): boolean {
  return b.kind === 'thinking' && b.itemId === event.itemId;
}

function makeReasoningDiffBlock(
  event: TurnDiffEvent,
  ts: string | undefined,
  complete: boolean,
): RunBlock {
  return {
    kind: 'thinking' as const,
    itemId: event.itemId,
    content: keepTailMarked(event.reasoning!, MAX_REASONING_CHARS),
    active: !complete,
    timestamp: ts,
    ...(complete ? { completedAt: ts } : {}),
  };
}

function updateReasoningDiffBlock(
  event: TurnDiffEvent,
  ts: string | undefined,
  complete: boolean,
  existing: RunBlock,
): RunBlock {
  const thinkingBlock = existing as Extract<RunBlock, { kind: 'thinking' }>;
  return {
    ...thinkingBlock,
    content: keepTailMarked(event.reasoning!, MAX_REASONING_CHARS),
    active: !complete,
    ...(event.refreshTimestamp ? { timestamp: ts } : {}),
    ...(complete ? { completedAt: ts } : {}),
  };
}

// reasoning 的 applier 由下方 applySnapshotDiff + REASONING_DIFF_SPEC 提供：
// 原本与 applyToolOutputDiff 逐字重复（仅 guard 字段 / 三个 handler / footer
// 不同），现合并为单一实现，差异提到数据表。字段顺序、事件顺序逐项保持。

// -- toolOutput --
function toolDiffMatches(event: TurnDiffEvent, b: RunBlock): boolean {
  return b.kind === 'tool' && b.tool.id === event.itemId;
}

function makeToolDiffBlock(
  event: TurnDiffEvent,
  ts: string | undefined,
  complete: boolean,
): RunBlock {
  // 身份只在首见时写入（existing 分支不动）：toolName/toolInput/toolHint。
  const inputStr = truncateDetail(stringifyUnknown(event.toolInput ?? {}));
  return {
    kind: 'tool' as const,
    tool: {
      id: event.itemId,
      name: event.toolName ?? 'command',
      input: inputStr,
      parsedInput: asRecord(inputStr),
      ...(event.toolHint !== undefined ? { toolHint: event.toolHint } : {}),
      output: keepTail(event.toolOutput!, MAX_TOOL_DETAIL_CHARS),
      status: complete ? (event.toolStatus ?? 'ok') : 'running',
      startedAt: ts,
      ...(complete ? { completedAt: ts } : {}),
    },
  };
}

function updateToolDiffBlock(
  event: TurnDiffEvent,
  ts: string | undefined,
  complete: boolean,
  existing: RunBlock,
): RunBlock {
  const tool = (existing as Extract<RunBlock, { kind: 'tool' }>).tool;
  return {
    kind: 'tool' as const,
    tool: {
      ...tool,
      output: keepTail(event.toolOutput!, MAX_TOOL_DETAIL_CHARS),
      status: complete ? (event.toolStatus ?? 'ok') : tool.status,
      ...(complete ? { completedAt: ts } : {}),
    },
  };
}

// toolOutput 的 applier 同样由 applySnapshotDiff + TOOL_DIFF_SPEC 驱动（见下）。

// -- plan --
function planDiffMatches(event: TurnDiffEvent, b: RunBlock): boolean {
  return b.kind === 'plan' && b.itemId === event.itemId;
}

function makePlanDiffBlock(
  newPlan: string,
  event: TurnDiffEvent,
  ts: string | undefined,
  complete: boolean,
): RunBlock {
  return {
    kind: 'plan' as const,
    itemId: event.itemId,
    content: newPlan,
    active: !complete,
    timestamp: ts,
    ...(complete ? { completedAt: ts } : {}),
  };
}

function updatePlanDiffBlock(
  newPlan: string,
  complete: boolean,
  ts: string | undefined,
  existing: RunBlock,
): RunBlock {
  const planBlock = existing as Extract<RunBlock, { kind: 'plan' }>;
  return {
    ...planBlock,
    content: newPlan,
    active: !complete,
    ...(complete ? { completedAt: ts } : {}),
  };
}

function applyPlanDiff(next: RunState, event: TurnDiffEvent): RunState {
  if (event.plan === undefined) return next;
  const ts = event.timestamp;
  const complete = event.complete === true;
  const newPlan = keepTailMarked(event.plan, MAX_REASONING_CHARS * 2);
  const capped = upsertSnapshotBlock(
    next.blocks,
    planDiffMatches.bind(null, event),
    makePlanDiffBlock.bind(null, newPlan, event, ts, complete),
    updatePlanDiffBlock.bind(null, newPlan, complete, ts),
    !complete,
  );
  return withCappedBlocks({ ...next, plan: newPlan }, capped);
}

// -- fileChanges --
function makeFileChangeBlock(
  fc: FileChangeDiff,
  event: TurnDiffEvent,
  ts: string | undefined,
  complete: boolean,
): RunBlock {
  return {
    kind: 'file_change' as const,
    itemId: event.itemId,
    path: fc.path,
    operation: fc.kind === 'add' ? 'create' : fc.kind === 'delete' ? 'delete' : 'edit',
    diff: fc.diff,
    timestamp: ts,
    ...(complete ? { completedAt: ts } : {}),
  };
}

function fileChangeMatches(fc: FileChangeDiff, event: TurnDiffEvent, b: RunBlock): boolean {
  return b.kind === 'file_change' && b.itemId === event.itemId && b.path === fc.path;
}

function applyFileChangesDiff(next: RunState, event: TurnDiffEvent): RunState {
  if (event.fileChanges === undefined) return next;
  const ts = event.timestamp;
  const complete = event.complete === true;
  let blocks = next.blocks;
  for (const fc of event.fileChanges) {
    const fileBlock = makeFileChangeBlock(fc, event, ts, complete);
    // 同一 item 的同一路径原地替换（权威 diff 校正），新路径/新 item 追加。
    blocks = upsertSnapshotBlock(
      blocks,
      fileChangeMatches.bind(null, fc, event),
      constantBlock.bind(null, fileBlock),
      constantBlock.bind(null, fileBlock),
      !complete,
    );
  }
  return withCappedBlocks(next, blocks);
}

type TurnDiffApplier = (state: RunState, event: TurnDiffEvent) => RunState;

// reasoning / toolOutput 两个同形 applier 的单一实现：差异全在 spec 数据表，
// 调用点（TURN_DIFF_APPLIERS）通过 bind 共用，行为 / 字段顺序 / 事件顺序不变。
interface SnapshotDiffSpec {
  hasPayload: (event: TurnDiffEvent) => boolean;
  matches: (event: TurnDiffEvent, b: RunBlock) => boolean;
  make: (event: TurnDiffEvent, ts: string | undefined, complete: boolean) => RunBlock;
  update: (
    event: TurnDiffEvent,
    ts: string | undefined,
    complete: boolean,
    existing: RunBlock,
  ) => RunBlock;
  footer: RunFooter;
}

const REASONING_DIFF_SPEC: SnapshotDiffSpec = {
  hasPayload: (e) => e.reasoning !== undefined,
  matches: reasoningDiffMatches,
  make: makeReasoningDiffBlock,
  update: updateReasoningDiffBlock,
  footer: 'thinking',
};
const TOOL_DIFF_SPEC: SnapshotDiffSpec = {
  hasPayload: (e) => e.toolOutput !== undefined,
  matches: toolDiffMatches,
  make: makeToolDiffBlock,
  update: updateToolDiffBlock,
  footer: 'tool_running',
};

function applySnapshotDiff(spec: SnapshotDiffSpec, next: RunState, event: TurnDiffEvent): RunState {
  if (!spec.hasPayload(event)) return next;
  const ts = event.timestamp;
  const complete = event.complete === true;
  const capped = upsertSnapshotBlock(
    next.blocks,
    spec.matches.bind(null, event),
    spec.make.bind(null, event, ts, complete),
    spec.update.bind(null, event, ts, complete),
    !complete,
  );
  return withCappedBlocks(next, capped, spec.footer);
}

/** 五个字段按固定顺序依次应用（与原实现的 5 个 if 分支顺序一致）。 */
const TURN_DIFF_APPLIERS: ReadonlyArray<TurnDiffApplier> = [
  applyTextDiff,
  applySnapshotDiff.bind(null, REASONING_DIFF_SPEC),
  applySnapshotDiff.bind(null, TOOL_DIFF_SPEC),
  applyPlanDiff,
  applyFileChangesDiff,
];

/**
 * Handle app-server turn_diff events. The translator emits FULL per-item
 * snapshots (accumulated text/reasoning/tool output/plan, current file-change
 * set). Each snapshot is scoped to a thread item (event.itemId); the block is
 * replaced in place to avoid duplication, and a NEW block is appended on the
 * item's first sight — so interleaved items keep their real chronology and the
 * active streaming content sits at the bottom, like the exec path.
 */
function reduceTurnDiffEvent(state: RunState, event: TurnDiffEvent): RunState {
  let next = state;
  for (const applier of TURN_DIFF_APPLIERS) {
    next = applier(next, event);
  }
  return next;
}

/**
 * Replace the last block matching `predicate` with `make`; if none matches,
 * append a block built by `fallback`. Snapshot semantics for app-server
 * turn_diff streams.
 *
 * `moveToEndWhenNotLast`: 当命中块不在数组末尾且为流式更新（complete=false）
 * 时，把更新后的块移到末尾。正常协议下 item 串行、流式块总是最后一个，
 * 此分支不触发；若真实 server 在同一个 item 上跨其他 item 续流 delta（违反
 * item 生命周期），流式内容仍会出现在卡片底部，而不是钉在旧位置。
 */
function upsertSnapshotBlock(
  blocks: RunBlock[],
  predicate: (b: RunBlock) => boolean,
  fallback: () => RunBlock,
  update?: (existing: RunBlock) => RunBlock,
  moveToEndWhenNotLast = false,
): RunBlock[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (predicate(blocks[i])) {
      const copy = blocks.slice();
      copy[i] = update ? update(blocks[i]) : fallback();
      if (moveToEndWhenNotLast && i < copy.length - 1) {
        const [moved] = copy.splice(i, 1);
        copy.push(moved);
      }
      return copy;
    }
  }
  return [...blocks, fallback()];
}

/** Handle system init and compact_boundary events. */
function reduceSystemEvent(
  state: RunState,
  event: Extract<AgentEvent, { type: 'system' }>,
): RunState {
  if (event.subtype === 'init') {
    return { ...state, sessionId: event.session_id, model: event.model, footer: 'thinking' };
  }
  if (event.subtype === 'compact_boundary' && event.compactMetadata) {
    return {
      ...state,
      contextLength: event.compactMetadata.postTokens,
      compactCount: (state.compactCount ?? 0) + 1,
    };
  }
  return state;
}

/** Handle result event - transition to finalizing (non-terminal).
 *
 *  进程退出是唯一终态触发源。result 事件只暂存 resultSubtype +
 *  errorMsg（终态判定必需），不暂存 usage（由 bridge 局部变量捕获）。
 *  合并语义：多个 result 事件（agent 自身 + SpawningRunner.buildResultEvent 合成）
 *  - resultSubtype: error 优先（任一为 error 即 error）
 *  - errorMsg: 首个非 undefined 胜出（agent 的更具体）
 */
function reduceResultEvent(state: RunState, event: ResultEvent): RunState {
  // Pre-init result guard: Claude CLI --resume emits a historical result (from
  // the previous turn) before sending system.init for the new run. Without this
  // guard, that stale result would prematurely transition to 'finalizing',
  // freezing the card at "⏳ 等待进程退出" for the entire run duration.
  // sessionId is set by system.init; undefined means init hasn't arrived yet.
  if (state.sessionId === undefined) return state;
  const resultEvent = event as ResultEvent;
  // runner 带过来的完整回答优先于 blocks 里的副本：副本可能是被窗口截过的
  // （同一 turn 里回答之后又出现过更晚的正文），只能当兜底。
  const withFinalAnswer = promoteFinalAnswer(state, 'inferred', resultEvent.finalAnswerText);
  const incomingSubtype = event.subtype;
  const incomingErrorMsg =
    incomingSubtype === 'error' ? (resultEvent.errorMessage ?? 'Agent 返回错误结果') : undefined;

  // 合并 subtype：error 优先，其次 interrupted（任一为 error 即 error；
  // 否则任一为 interrupted 即 interrupted；interrupted 不得并入 success）。
  const mergedSubtype: 'success' | 'error' | 'interrupted' =
    withFinalAnswer.resultSubtype === 'error' || incomingSubtype === 'error'
      ? 'error'
      : withFinalAnswer.resultSubtype === 'interrupted' || incomingSubtype === 'interrupted'
        ? 'interrupted'
        : 'success';
  // 合并 errorMsg：首个非 undefined 胜出（existing ?? incoming）
  const mergedErrorMsg = withFinalAnswer.errorMsg ?? incomingErrorMsg;

  return {
    ...withFinalAnswer,
    terminal: 'finalizing',
    footer: null,
    blocks: markThinkingInactive(withFinalAnswer.blocks),
    resultSubtype: mergedSubtype,
    errorMsg: mergedErrorMsg,
    // costUsd：首个非 undefined 胜出（与 errorMsg 合并语义一致）
    ...(event.total_cost_usd !== undefined && withFinalAnswer.costUsd === undefined
      ? { costUsd: event.total_cost_usd }
      : {}),
    // credits：同上口径（qoder 的积分原样透传，与 total_cost_usd 并列）
    ...(event.total_credits !== undefined && withFinalAnswer.credits === undefined
      ? { credits: event.total_credits }
      : {}),
  };
}

/** Record an authoritative protocol final answer and remove its progress copy. */
function reduceFinalAnswerEvent(state: RunState, event: FinalAnswerEvent): RunState {
  if (!event.text.trim() && !state.finalAnswer) return state;

  const blocks = event.itemId
    ? state.blocks.filter((block) => block.kind !== 'text' || block.itemId !== event.itemId)
    : state.blocks;
  const content = event.text.trim() ? event.text : (state.finalAnswer?.content ?? '');
  return {
    ...state,
    blocks,
    finalAnswer: {
      content,
      timestamp: state.finalAnswer?.timestamp ?? event.timestamp,
      complete: event.complete ?? state.finalAnswer?.complete ?? false,
      source: 'protocol',
    },
    footer: 'streaming',
  };
}

/**
 * Agents without an explicit final-answer marker use their last non-empty
 * assistant text block. Moving it out of `blocks` protects it from
 * MAX_BLOCKS and lets the renderer assign it first claim on card space.
 *
 * `authoritativeText` 是 runner 在 result 上带来的完整回答（见
 * `ResultEvent.finalAnswerText`）。blocks 里那条**通常**是完整的最新正文
 * （见 capStaleTextBlocks），但它可能已被更晚的正文顶替而降级成窗口副本，
 * 也可能在重连丢帧时缺内容；runner 给的全文优先级更高，是「输出永不截断」
 * 的主数据源。
 */
function promoteFinalAnswer(
  state: RunState,
  source: 'protocol' | 'inferred',
  authoritativeText?: string,
): RunState {
  if (state.finalAnswer) {
    return state.finalAnswer.complete
      ? state
      : { ...state, finalAnswer: { ...state.finalAnswer, complete: true } };
  }
  const fullText = authoritativeText?.trim() ? authoritativeText : undefined;
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    // 已归档的上一轮回答只是历史展示，不能再被下一轮 result 认成"本轮正文"抽走。
    if (block.kind !== 'text' || block.archivedAnswer || !block.content.trim()) continue;
    return {
      ...state,
      blocks: state.blocks.filter((_, index) => index !== i),
      finalAnswer: {
        content: fullText ?? block.content,
        timestamp: block.timestamp,
        complete: true,
        source,
      },
    };
  }
  // 进度块全被 MAX_BLOCKS 淘汰、只有 runner 全文可用时也要建立 finalAnswer——
  // 否则长回答的最后一段会连「输出」面板都不存在。
  if (fullText) {
    return { ...state, finalAnswer: { content: fullText, complete: true, source } };
  }
  return state;
}

/**
 * 后台任务名单 → RunState.backgroundJobs。
 *
 * 整份替换而非合并：事件本身就是"收尾那一刻仍在跑的完整名单"，合并会把上一
 * 轮已结束的任务留下来。用户点「停止」成功后由 bridge 直接从 state 里摘掉，
 * 不再走事件（那时已经没有 run 在消费流了）。
 */
function reduceBackgroundJobsEvent(state: RunState, event: BackgroundJobsEvent): RunState {
  return { ...state, backgroundJobs: event.jobs };
}

/**
 * 用户停止某个后台任务成功后，从卡片状态里摘掉它。
 *
 * run 此时已经收尾（没有流再消费事件），所以这条不走 reducer 的事件入口；但
 * RunState 的形状只允许在本模块内拼装——bridge 直接展开 state 曾把「摘一条」
 * 写成「整体重建」，字段一多就会漏带。
 */
export function removeBackgroundJob(state: RunState, jobId: string): RunState {
  return {
    ...state,
    backgroundJobs: (state.backgroundJobs ?? []).filter((job) => job.id !== jobId),
  };
}

/** 宿主仍在执行的任务状态词。状态缺失也算在跑——它还在名单上。 */
const RUNNING_JOB_STATUSES = new Set(['running', 'stopping']);

/**
 * 该任务是否仍在跑（`ended` / `unknown` 都不算）。
 *
 * 卡片据此决定要不要渲染「⏹ 停止」：给已经结束的任务留一个点了必然失败的
 * 按钮，等于逼用户拿「停止」当查询用。
 */
export function isLiveBackgroundJob(job: BackgroundJobRoster): boolean {
  return job.status === undefined || RUNNING_JOB_STATUSES.has(job.status);
}

/** 宿主状态 → 桥侧状态：仍在跑的保留原词，其余已知终态归一成 `ended`。 */
function bridgeJobStatus(status: string): string {
  return RUNNING_JOB_STATUSES.has(status) ? status : 'ended';
}

/**
 * 收尾后把宿主推来的整份任务名单同步进终态卡状态。
 *
 * 与 reducer 的分工：reducer 处理的是"收尾那一刻的名单"，只在 run 还在消费
 * 事件时有效；终态之后 `reduceRunState` 直接早退（终态幂等），名单只能由
 * 这里更新。
 *
 * 三条规则：
 * - 名单里消失 = 宿主已结算（`job/list` 是整份替换，摘掉即结束）→ `ended`；
 * - 名单里还在、宿主却给了终态词 → `ended`（有些宿主会把已结束的行留在名单里）；
 * - `ended` 是终态，不回退成 running —— 同一个 job id 不会重新开始跑。
 *
 * 无变化时返回**同一个 state 引用**：bridge 靠它跳过无谓的卡片 patch。
 */
/** 单个已跟踪 job 与 roster 行的对账（原 tracked.map 回调）。 */
function syncTrackedJob(
  job: BackgroundJobRoster,
  row: BackgroundJobRoster | undefined,
): BackgroundJobRoster {
  if (!row) return job.status === 'ended' ? job : { ...job, status: 'ended' };
  if (job.status === 'ended') return job;
  const status = row.status === undefined ? job.status : bridgeJobStatus(row.status);
  const label = row.label.trim() === '' ? job.label : row.label;
  const progress = row.progress ?? job.progress;
  if (status === job.status && label === job.label && progress === job.progress) return job;
  return {
    ...job,
    label,
    ...(status === undefined ? {} : { status }),
    ...(progress === undefined ? {} : { progress }),
  };
}

/** roster 里新出现且仍在跑的 job（原新增循环）。 */
function collectNewJobs(
  tracked: BackgroundJobRoster[],
  roster: ReadonlyArray<BackgroundJobRoster>,
): BackgroundJobRoster[] {
  const seen = new Set<string>();
  for (const job of tracked) seen.add(job.id);
  const added: BackgroundJobRoster[] = [];
  for (const row of roster) {
    if (seen.has(row.id)) continue;
    if (row.status !== undefined && !RUNNING_JOB_STATUSES.has(row.status)) continue;
    added.push({
      id: row.id,
      label: row.label,
      ...(row.status === undefined ? {} : { status: row.status }),
      ...(row.progress === undefined ? {} : { progress: row.progress }),
    });
  }
  return added;
}

/** next 与 tracked 是否逐项同一引用（原 length + every 判定）。 */
function jobsUnchanged(next: BackgroundJobRoster[], tracked: BackgroundJobRoster[]): boolean {
  if (next.length !== tracked.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== tracked[i]) return false;
  }
  return true;
}

export function syncBackgroundJobs(
  state: RunState,
  roster: ReadonlyArray<BackgroundJobRoster>,
): RunState {
  const tracked = state.backgroundJobs ?? [];

  const byId = new Map<string, BackgroundJobRoster>();
  for (const job of roster) byId.set(job.id, job);

  const next: BackgroundJobRoster[] = [];
  for (const job of tracked) {
    next.push(syncTrackedJob(job, byId.get(job.id)));
  }

  // 新出现的任务只收仍在跑的：与收尾采集同一口径（列出已结束的任务只会被
  // 读成"还在跑"）。
  for (const added of collectNewJobs(tracked, roster)) {
    next.push(added);
  }

  if (jobsUnchanged(next, tracked)) {
    return state;
  }
  return { ...state, backgroundJobs: next };
}

/**
 * 订阅断了但任务仍未结算：把在跑的任务标成「状态未知」。
 *
 * 监控中断不等于任务结束——不标出来，卡片又会退化成"最后一次观测当现状"，
 * 正是这次要修的那个缺陷。未知态仍保留停止按钮（用户还能尝试停掉）。
 */
export function markBackgroundJobsUnknown(state: RunState): RunState {
  const jobs = state.backgroundJobs;
  if (!jobs || jobs.length === 0) return state;
  let changed = false;
  const next = jobs.map((job) => {
    if (!isLiveBackgroundJob(job)) return job;
    changed = true;
    return { ...job, status: 'unknown' };
  });
  return changed ? { ...state, backgroundJobs: next } : state;
}

/**
 * 运行期状态投影 → 状态行。
 *
 * 每帧只带一个投影 key，所以只合并"有值"的字段：用 undefined 覆盖会把另一
 * 维度（上一步算出的上下文水位）擦掉。
 */
function reduceRunStatusEvent(state: RunState, event: RunStatusEvent): RunState {
  const prev = state.liveStatus ?? {};
  const live = {
    ...prev,
    ...(event.contextUsed === undefined ? {} : { contextUsed: event.contextUsed }),
    ...(event.contextLimit === undefined ? {} : { contextLimit: event.contextLimit }),
    ...(event.steps === undefined ? {} : { steps: event.steps }),
    ...(event.toolMs === undefined ? {} : { toolMs: event.toolMs }),
  };
  // 窗口上限同时写进 state：终态 summary 的百分比与状态条同源，即使
  // result.usage 没带上限（DSH 的会话读取端不产出）也算得出来。
  const next: RunState = { ...state, liveStatus: live };
  if (live.contextLimit !== undefined) next.contextLimit = live.contextLimit;
  return next;
}

/** Handle assistant thinking/text/tool_use content blocks. */
function reduceAssistantEvent(state: RunState, event: AssistantEvent): RunState {
  let next = state;
  for (const content of event.message.content) {
    if (content.type === 'thinking') {
      // 增量通道语义：chunk 边界是传输事实，不是文档结构。同一 itemId 的连续
      // 内容是同一块的增量，逐字拼接；itemId 变化才开新块。不能用 '\n' 表示
      // “来了新 delta”——DSH/opencode 的 reasoning delta 是 token 粒度。
      const last = next.blocks[next.blocks.length - 1];
      const prev = last?.kind === 'thinking' ? last : undefined;
      const sameItem = prev !== undefined && prev.itemId === content.itemId;
      const newBlocks = sameItem
        ? [
            ...next.blocks.slice(0, -1),
            {
              ...prev,
              content: keepTailMarked(prev.content + content.thinking, MAX_REASONING_CHARS),
              active: true,
            },
          ]
        : [
            ...markThinkingInactive(next.blocks),
            {
              kind: 'thinking' as const,
              ...(content.itemId !== undefined ? { itemId: content.itemId } : {}),
              content: keepTailMarked(content.thinking, MAX_REASONING_CHARS),
              active: true,
              timestamp: event.timestamp,
            },
          ];
      next = withCappedBlocks(next, newBlocks, 'thinking');
    } else if (content.type === 'text') {
      const blocks = markThinkingInactive(next.blocks);
      const last = blocks[blocks.length - 1];
      // 最新正文原样保留（见 capStaleTextBlocks）：这里一旦按窗口截断，最终回答
      // 就在进渲染层之前已经缺头，任何「回答优先」的排版都救不回来。
      const newBlocks =
        last?.kind === 'text' && !last.archivedAnswer
          ? [
              ...blocks.slice(0, -1),
              {
                kind: 'text' as const,
                content: last.content + content.text,
                timestamp: last.timestamp ?? event.timestamp,
              },
            ]
          : [
              ...blocks,
              {
                kind: 'text' as const,
                content: content.text,
                timestamp: event.timestamp,
              },
            ];
      next = withCappedBlocks(next, newBlocks, 'streaming');
    } else {
      // parse the truncated stored string ONCE here (not on every render)
      // and cache the result on `parsedInput`. tool-render's asRecord then hits
      // the object branch with zero parsing. The parse uses the SAME truncated
      // string as the old per-render parse, so truncation-broken JSON still
      // yields null (over-cap input renders no summary — behavior preserved).
      const inputStr = truncateDetail(stringifyUnknown(content.input));
      const incomingTool: ToolEntry = {
        id: content.id,
        name: content.name,
        input: inputStr,
        parsedInput: asRecord(inputStr),
        ...(content.summary !== undefined ? { summary: content.summary } : {}),
        status: 'running' as const,
        startedAt: event.timestamp,
      };
      const blocks = markThinkingInactive(next.blocks);
      // A tool_use patch (same id) enriches an existing tool block in place:
      // opencode emits the initial tool_call while args are still streaming,
      // then re-reports the command/path in later tool_call_updates. Merging
      // keeps one panel per tool call; a first-seen id still appends.
      const existingIndex = blocks.findIndex(
        (block) => block.kind === 'tool' && block.tool.id === content.id,
      );
      if (existingIndex >= 0) {
        const existing = blocks[existingIndex] as Extract<RunBlock, { kind: 'tool' }>;
        const merged = blocks.slice();
        merged[existingIndex] = {
          kind: 'tool',
          tool: mergeToolUse(existing.tool, incomingTool),
        };
        next = { ...next, blocks: keepLatestBlocks(merged), footer: 'tool_running' };
      } else {
        const capped = [...blocks, { kind: 'tool' as const, tool: incomingTool }];
        next = withCappedBlocks(next, capped, 'tool_running');
      }
    }
  }
  return next;
}

/**
 * Merge a same-id tool_use patch into the existing tool block. Only fields the
 * patch can legitimately enrich are overwritten:
 *   - `input`/`parsedInput` — replaced only when the patch carries a non-empty
 *     object (an empty `{}` patch must not erase a command already rendered);
 *   - `summary` — replaced only when the patch supplies one;
 *   - `name` — kept from first sight (a completed opencode update has no kind,
 *     so its patch cannot know the mapped name).
 * Everything else (`status`, `output`, `completedAt`, `toolHint`) is preserved,
 * so an out-of-order patch after the tool_result cannot reset status to running.
 */
function mergeToolUse(existing: ToolEntry, incoming: ToolEntry): ToolEntry {
  const incomingHasInput =
    incoming.parsedInput !== undefined &&
    incoming.parsedInput !== null &&
    Object.keys(incoming.parsedInput).length > 0;
  return {
    ...existing,
    input: incomingHasInput ? incoming.input : existing.input,
    parsedInput: incomingHasInput ? incoming.parsedInput : existing.parsedInput,
    name: existing.name || incoming.name,
    ...(incoming.summary !== undefined ? { summary: incoming.summary } : {}),
    startedAt: existing.startedAt ?? incoming.startedAt,
  };
}

/** Handle tool_result content blocks (user message with tool results).
 *  rebuild ONLY the block matching `tool_use_id`, copying every other
 *  block by reference. The old `.map()` recreated all block objects per
 *  tool_result (O(N) allocations on the run-card hot path). Footer still
 *  advances to 'streaming' on every content block (parity with old behavior);
 *  only the blocks array is preserved by reference when nothing matches. */
function reduceToolResultEvent(state: RunState, event: UserEvent): RunState {
  let next = state;
  for (const content of event.message.content) {
    const targetId = content.tool_use_id;
    const matchIndex = next.blocks.findIndex(
      (block) => block.kind === 'tool' && block.tool.id === targetId,
    );
    if (matchIndex === -1) {
      if (next.footer !== 'streaming') next = { ...next, footer: 'streaming' };
      continue;
    }
    const matched = next.blocks[matchIndex] as Extract<RunBlock, { kind: 'tool' }>;
    const updated: Extract<RunBlock, { kind: 'tool' }> = {
      kind: 'tool',
      tool: {
        ...matched.tool,
        output: truncateDetail(stringifyUnknown(content.content)),
        status: content.is_error ? ('error' as const) : ('ok' as const),
        completedAt: event.timestamp,
      },
    };
    const blocks = next.blocks.slice();
    blocks[matchIndex] = updated;
    next = { ...next, blocks, footer: 'streaming' };
  }
  return next;
}

/** Handle notice event — append a runtime notice (warning / reroute / compaction). */
function reduceNoticeEvent(state: RunState, event: NoticeEvent): RunState {
  return {
    ...state,
    notices: [
      ...(state.notices ?? []),
      {
        level: event.level,
        ...(event.code !== undefined ? { code: event.code } : {}),
        text: event.text,
        ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
      },
    ],
  };
}

/** Handle session_info event — update sessionTitle / mode only when present. */
function reduceSessionInfoEvent(state: RunState, event: SessionInfoEvent): RunState {
  return {
    ...state,
    ...(event.title !== undefined ? { sessionTitle: event.title } : {}),
    ...(event.mode !== undefined ? { mode: event.mode } : {}),
  };
}

/**
 * Handle plan event — replace the plan document with the latest snapshot.
 * Every producer (ACP entries[] / Codex PlanStep[]) sends the whole current
 * plan, not an incremental delta. Appending snapshots reproduces the entire
 * list once per status change; a plan is a single stateful document, so the
 * reducer upserts one block with the newest content.
 */
function reducePlanEvent(state: RunState, event: PlanEvent): RunState {
  const newPlan = keepTailMarked(event.plan, MAX_REASONING_CHARS * 2);
  const withoutOldPlan = state.blocks.filter((b) => b.kind !== 'plan');
  const newBlocks = [
    ...withoutOldPlan,
    { kind: 'plan' as const, content: newPlan, active: true, timestamp: event.timestamp },
  ];
  return withCappedBlocks({ ...state, plan: newPlan }, newBlocks);
}

/** Handle file_change event — emit a file_change block for rendering (Codex-style agents). */
function reduceFileChangeEvent(state: RunState, event: FileChangeEvent): RunState {
  // Add file_change block for rendering (collapsed by default)
  const newBlocks = [
    ...state.blocks,
    {
      kind: 'file_change' as const,
      path: event.path,
      operation: event.operation,
      diff: event.diff,
      timestamp: event.timestamp,
    },
  ];
  return withCappedBlocks(state, newBlocks);
}

export function finishRun(
  state: RunState,
  terminal: RunFinalTerminal,
  meta: FinishMeta = {},
): RunState {
  const withFinalAnswer = promoteFinalAnswer(state, 'inferred');
  // 允许从 running 或 finalizing finish（/stop、idle watchdog、进程退出 finally）。
  // finalizing 是非终态（result 已收到，进程未退出），可被 finish 转终态。
  // 如果已经是终态，仍然允许补充 meta 信息（如 usage 等，bridge finally 的
  // else-if-sawResult 分支用此路径补充 token 统计）。
  if (withFinalAnswer.terminal !== 'running' && withFinalAnswer.terminal !== 'finalizing') {
    // Already terminal: apply meta fields if provided (e.g. usage from jsonl)
    const hasMeta = Object.keys(meta).some(
      (k) => (meta as Record<string, unknown>)[k] !== undefined,
    );
    if (!hasMeta) return withFinalAnswer;
    return { ...withFinalAnswer, ...sanitizeMeta(meta) };
  }
  // interrupted 终态的中断来源：显式传入优先；否则从顶层持久标记推导
  // （approval_expired 已置位但调用方未传 reason 的路径，如协调器过期自动
  // cancel。原因必须在终态确定，不依赖调用方记得传参）。
  const derivedReason =
    meta.interruptedReason ??
    (terminal === 'interrupted' && withFinalAnswer.approvalExpired === true
      ? 'approval_timeout'
      : undefined);
  return {
    ...withFinalAnswer,
    terminal,
    footer: null,
    // 耗时定格：终态之后再渲染（补 token 统计、点「详情」重渲染）都沿用同一
    // 结束时刻，否则每次 patch 的数字都会变大。
    finishedAt: withFinalAnswer.finishedAt ?? Date.now(),
    blocks: markThinkingInactive(withFinalAnswer.blocks),
    ...sanitizeMeta(meta),
    ...(derivedReason !== undefined ? { interruptedReason: derivedReason } : {}),
  };
}

/** Remove undefined/null meta fields to avoid overwriting existing state with nullish values. */
function sanitizeMeta(meta: FinishMeta): Partial<FinishMeta> {
  const result: Partial<FinishMeta> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined && v !== null) (result as Record<string, unknown>)[k] = v;
  }
  return result;
}

/** Mark all thinking blocks in the array as inactive. */
function markThinkingInactive(blocks: RunBlock[]): RunBlock[] {
  return blocks.map((b) => (b.kind === 'thinking' && b.active ? { ...b, active: false } : b));
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    // JSON.stringify(undefined) returns the value undefined, which would
    // violate this function's string contract and crash callers that take
    // .length on the result. Normalize to ''.
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * 尾块统一收口：keepLatestBlocks 截断 + omittedBlocks 计数 + footer 更新一步
 * 完成。所有「追加/更新块后只保留最新 MAX_BLOCKS 块」的事件归约共用（此前
 * 多处逐字重复）；`blocks` 必须传截断前的数组，被丢出的最旧块才会计入
 * omittedBlocks。`footer` 不传时保持原值（plan/file_change 归约不改 footer）。
 */
function withCappedBlocks(next: RunState, blocks: RunBlock[], footer?: RunFooter): RunState {
  return {
    ...next,
    blocks: keepLatestBlocks(blocks),
    omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, blocks.length - MAX_BLOCKS),
    ...(footer === undefined ? {} : { footer }),
  };
}

function keepLatestBlocks(blocks: RunBlock[]): RunBlock[] {
  return blocks.length <= MAX_BLOCKS ? blocks : blocks.slice(-MAX_BLOCKS);
}

/**
 * 给「已经不再是最新」的 text 块补上 `MAX_TEXT_CHARS` 存储窗口。
 *
 * 为什么最新一条不截：它就是卡片上的**输出**，终态还会被 `promoteFinalAnswer`
 * 提成最终回答。提前按窗口切掉头部，渲染层再怎么回答优先也补不回来
 * （16074 字符的回答只进到渲染层 12000 字符，且是从中间开始的）。
 *
 * 为什么其余 text 块仍然截：它们只是进度信息，卡片本来就只会展示最新几步；
 * 存储层必须保持有界（`MAX_BLOCKS` × 窗口），否则长 run 的内存随历史线性增长。
 *
 * 判定用「最后一次出现的 text 块」而不是「最后一个块」：工具/思考出现在正文之后
 * 时（例如回答写完再补一次思考），回答仍然是那张卡要展示的输出，不能因此被切。
 */
function capStaleTextBlocks(blocks: RunBlock[]): RunBlock[] {
  let newestText = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'text') {
      newestText = i;
      break;
    }
  }
  if (newestText < 0) return blocks;

  let changed = false;
  const capped = blocks.map((block, index) => {
    if (index === newestText || block.kind !== 'text') return block;
    const content = block.content;
    const windowed = keepTailMarked(content, MAX_TEXT_CHARS);
    if (windowed === content) return block;
    changed = true;
    return { ...block, content: windowed };
  });
  return changed ? capped : blocks;
}

/**
 * keepTail + 截断标记：被去头的存储内容以前缀如实标注（信息保真红线：禁止静默丢弃）。
 * 标记计入 maxChars 预算（存储总量仍 ≤ maxChars，保持既有长度不变量）。
 *
 * 计数口径：只统计**真实丢弃的正文**，不含标记自身开销。
 * 关键点是增量流下 `value` 往往已带上一次的标记（`marker + kept`）；若直接
 * 用 `value.length - kept.length` 计费，会把上一帧的标记文本也算进「已省略」，
 * 造成每帧显示十几字符的虚高。这里先剥离旧标记，把 N 定义为**从该块起始累计
 * 丢弃的正文数**（单调不减），再按「marker 计入预算」的不动点求最小 N。
 */
function keepTailMarked(value: string, maxChars: number): string {
  const prior = FRONT_OMISSION_MARKER_RE.exec(value);
  const priorDropped = prior ? Number(prior[1]) : 0;
  const body = prior ? value.slice(prior[0].length) : value;

  // 从未截断且当前正文未超预算：原样返回（不误标）。
  if (priorDropped === 0 && body.length <= maxChars) return value;

  // 求最小累计丢弃数 N（≥ priorDropped），使 marker(N) + 保留正文 ≤ maxChars：
  //   body.length - (N - priorDropped) + (12 + digits(N)) ≤ maxChars
  //   ⟺ N ≥ priorDropped + body.length - maxChars + 12 + digits(N)
  // 即 N = K + digits(N) 的不动点（K 为固定项，位数至多几次即收敛）。
  const K = priorDropped + body.length - maxChars + 12;
  let totalDropped = Math.max(priorDropped, K);
  for (;;) {
    const next = Math.max(priorDropped, K + String(totalDropped).length);
    if (next === totalDropped) break;
    totalDropped = next;
  }

  const newlyDropped = totalDropped - priorDropped;
  const kept = body.slice(newlyDropped);
  return frontOmissionMarker(totalDropped) + kept;
}

function truncateDetail(value: string): string {
  return value.length <= MAX_TOOL_DETAIL_CHARS
    ? value
    : `${value.slice(0, MAX_TOOL_DETAIL_CHARS)}…（已截断）`;
}
