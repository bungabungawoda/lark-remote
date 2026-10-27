import type {
  AgentEvent,
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
import { keepTail } from '../common/truncate.js';
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
export type RunActiveTerminal = 'running' | 'finalizing';

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
export type InterruptedReason = 'approval_timeout' | 'user_stop' | 'approval_cancelled';
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
  | { kind: 'text'; itemId?: string; content: string; timestamp?: string; completedAt?: string }
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

export interface FinalAnswerState {
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
   * 终态渲染（2026-08-15 事故：标记被消费后卡片误报「已被用户终止」）。
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
   */
  backgroundJobs?: Array<{ id: string; label: string; status?: string; progress?: string }>;
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

export function createInitialRunState(runId: string): RunState {
  return {
    runId,
    terminal: 'running',
    footer: 'thinking',
    // 状态行的耗时口径：从 run 状态建立那一刻算起（卡片首帧即开始计时）。
    startedAt: Date.now(),
    blocks: [],
  };
}

export function reduceRunState(state: RunState, event: AgentEvent): RunState {
  // 只有终态才阻止事件处理。finalizing 是非终态，
  // 仍需累积 assistant 内容（thinking、text、tool_use、后台任务输出）。
  const terminal = state.terminal;
  if (isRunTerminal(terminal)) {
    return state;
  }

  if (event.type === 'system') return reduceSystemEvent(state, event);
  if (event.type === 'run_status') return reduceRunStatusEvent(state, event);
  if (event.type === 'goal_state') {
    // 覆盖写：每次观测都是宿主的整份快照（phase/轮次/目标全文），不做增量。
    return { ...state, goal: event.goal ?? undefined, goalKnown: event.known };
  }
  if (event.type === 'background_jobs') return reduceBackgroundJobsEvent(state, event);
  if (event.type === 'result') return reduceResultEvent(state, event);
  if (event.type === 'final_answer') return reduceFinalAnswerEvent(state, event);
  if (event.type === 'assistant') return reduceAssistantEvent(state, event);
  if (event.type === 'user') return reduceToolResultEvent(state, event);
  if (event.type === 'plan') return reducePlanEvent(state, event);
  if (event.type === 'file_change') return reduceFileChangeEvent(state, event);
  if (event.type === 'notice') return reduceNoticeEvent(state, event);
  if (event.type === 'session_info') return reduceSessionInfoEvent(state, event);
  if (event.type === 'turn_started') return reduceTurnStartedEvent(state, event);
  if (event.type === 'turn_diff') return reduceTurnDiffEvent(state, event);
  if (event.type === 'approval_requested') {
    const approvals = state.approvals ?? [];
    const next = { view: event.view, expired: false };
    const idx = approvals.findIndex((a) => a.view.requestId === event.requestId);
    if (idx >= 0) {
      // 同一 requestId 重复到达：原地替换，保持槽位顺序。
      return {
        ...state,
        approvals: approvals.map((a, i) => (i === idx ? next : a)),
      };
    }
    return { ...state, approvals: [...approvals, next] };
  }
  if (event.type === 'approval_resolved') {
    return {
      ...state,
      approvals: (state.approvals ?? []).filter((a) => a.view.requestId !== event.requestId),
    };
  }
  if (event.type === 'approval_view_updated') {
    return {
      ...state,
      approvals: (state.approvals ?? []).map((a) =>
        a.view.requestId === event.requestId ? { ...a, view: event.view } : a,
      ),
    };
  }
  if (event.type === 'approval_expired') {
    return {
      ...state,
      approvalExpired: true,
      approvals: (state.approvals ?? []).map((a) =>
        a.view.requestId === event.requestId ? { ...a, expired: true } : a,
      ),
    };
  }
  return state;
}

/** Handle app-server turn_started — records the operation kind (turn vs compact). */
function reduceTurnStartedEvent(state: RunState, event: TurnStartedEvent): RunState {
  if (event.type !== 'turn_started') return state;
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
function reduceTurnDiffEvent(state: RunState, event: TurnDiffEvent): RunState {
  if (event.type !== 'turn_diff') return state;
  let next = state;
  const ts = event.timestamp;
  const complete = event.complete === true;

  if (event.text !== undefined) {
    const blocks = markThinkingInactive(next.blocks);
    const capped = upsertSnapshotBlock(
      blocks,
      (b) => b.kind === 'text' && b.itemId === event.itemId,
      () => ({
        kind: 'text' as const,
        itemId: event.itemId,
        content: keepTailMarked(event.text!, MAX_TEXT_CHARS),
        timestamp: ts,
        ...(complete ? { completedAt: ts } : {}),
      }),
      (existing) => {
        const textBlock = existing as Extract<RunBlock, { kind: 'text' }>;
        return {
          ...textBlock,
          content: keepTailMarked(event.text!, MAX_TEXT_CHARS),
          // kimi：块锚点时间改为本次 diff 时间（整轮累积流不断续写，
          // 标题应反映“最后写入时刻”而非首见时刻；move-to-end 后位置
          // 与标题才一致）。codex app-server 不置 refreshTimestamp，
          // 保持“首见时间戳不刷新”的既有契约。
          ...(event.refreshTimestamp ? { timestamp: ts } : {}),
          ...(complete ? { completedAt: ts } : {}),
        };
      },
      !complete,
    );
    next = {
      ...next,
      blocks: keepLatestBlocks(capped),
      omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, capped.length - MAX_BLOCKS),
      footer: 'streaming',
    };
  }

  if (event.reasoning !== undefined) {
    const capped = upsertSnapshotBlock(
      next.blocks,
      (b) => b.kind === 'thinking' && b.itemId === event.itemId,
      () => ({
        kind: 'thinking' as const,
        itemId: event.itemId,
        content: keepTailMarked(event.reasoning!, MAX_REASONING_CHARS),
        active: !complete,
        timestamp: ts,
        ...(complete ? { completedAt: ts } : {}),
      }),
      (existing) => {
        const thinkingBlock = existing as Extract<RunBlock, { kind: 'thinking' }>;
        return {
          ...thinkingBlock,
          content: keepTailMarked(event.reasoning!, MAX_REASONING_CHARS),
          active: !complete,
          ...(event.refreshTimestamp ? { timestamp: ts } : {}),
          ...(complete ? { completedAt: ts } : {}),
        };
      },
      !complete,
    );
    next = {
      ...next,
      blocks: keepLatestBlocks(capped),
      omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, capped.length - MAX_BLOCKS),
      footer: 'thinking',
    };
  }

  if (event.toolOutput !== undefined) {
    const capped = upsertSnapshotBlock(
      next.blocks,
      (b) => b.kind === 'tool' && b.tool.id === event.itemId,
      () => {
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
      },
      (existing) => ({
        kind: 'tool' as const,
        tool: {
          ...(existing as Extract<RunBlock, { kind: 'tool' }>).tool,
          output: keepTail(event.toolOutput!, MAX_TOOL_DETAIL_CHARS),
          status: complete
            ? (event.toolStatus ?? 'ok')
            : (existing as Extract<RunBlock, { kind: 'tool' }>).tool.status,
          ...(complete ? { completedAt: ts } : {}),
        },
      }),
      !complete,
    );
    next = {
      ...next,
      blocks: keepLatestBlocks(capped),
      omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, capped.length - MAX_BLOCKS),
      footer: 'tool_running',
    };
  }

  if (event.plan !== undefined) {
    const newPlan = keepTailMarked(event.plan, MAX_REASONING_CHARS * 2);
    const capped = upsertSnapshotBlock(
      next.blocks,
      (b) => b.kind === 'plan' && b.itemId === event.itemId,
      () => ({
        kind: 'plan' as const,
        itemId: event.itemId,
        content: newPlan,
        active: !complete,
        timestamp: ts,
        ...(complete ? { completedAt: ts } : {}),
      }),
      (existing) => {
        const planBlock = existing as Extract<RunBlock, { kind: 'plan' }>;
        return {
          ...planBlock,
          content: newPlan,
          active: !complete,
          ...(complete ? { completedAt: ts } : {}),
        };
      },
      !complete,
    );
    next = {
      ...next,
      plan: newPlan,
      blocks: keepLatestBlocks(capped),
      omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, capped.length - MAX_BLOCKS),
    };
  }

  if (event.fileChanges !== undefined) {
    let blocks = next.blocks;
    for (const fc of event.fileChanges) {
      const fileBlock: RunBlock = {
        kind: 'file_change' as const,
        itemId: event.itemId,
        path: fc.path,
        operation: fc.kind === 'add' ? 'create' : fc.kind === 'delete' ? 'delete' : 'edit',
        diff: fc.diff,
        timestamp: ts,
        ...(complete ? { completedAt: ts } : {}),
      };
      // 同一 item 的同一路径原地替换（权威 diff 校正），新路径/新 item 追加。
      blocks = upsertSnapshotBlock(
        blocks,
        (b) => b.kind === 'file_change' && b.itemId === event.itemId && b.path === fc.path,
        () => fileBlock,
        () => fileBlock,
        !complete,
      );
    }
    const capped = blocks;
    next = {
      ...next,
      blocks: keepLatestBlocks(capped),
      omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, capped.length - MAX_BLOCKS),
    };
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
function reduceSystemEvent(state: RunState, event: AgentEvent): RunState {
  if (event.type !== 'system') return state;
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
function reduceResultEvent(state: RunState, event: AgentEvent): RunState {
  if (event.type !== 'result') return state;
  // Pre-init result guard: Claude CLI --resume emits a historical result (from
  // the previous turn) before sending system.init for the new run. Without this
  // guard, that stale result would prematurely transition to 'finalizing',
  // freezing the card at "⏳ 等待进程退出" for the entire run duration.
  // sessionId is set by system.init; undefined means init hasn't arrived yet.
  if (state.sessionId === undefined) return state;
  const withFinalAnswer = promoteFinalAnswer(state, 'inferred');
  const resultEvent = event as ResultEvent;
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
  };
}

/** Record an authoritative protocol final answer and remove its progress copy. */
function reduceFinalAnswerEvent(state: RunState, event: FinalAnswerEvent): RunState {
  if (event.type !== 'final_answer') return state;
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
 */
function promoteFinalAnswer(state: RunState, source: 'protocol' | 'inferred'): RunState {
  if (state.finalAnswer) {
    return state.finalAnswer.complete
      ? state
      : { ...state, finalAnswer: { ...state.finalAnswer, complete: true } };
  }
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (block.kind !== 'text' || !block.content.trim()) continue;
    return {
      ...state,
      blocks: state.blocks.filter((_, index) => index !== i),
      finalAnswer: {
        content: block.content,
        timestamp: block.timestamp,
        complete: true,
        source,
      },
    };
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
function reduceBackgroundJobsEvent(state: RunState, event: AgentEvent): RunState {
  if (event.type !== 'background_jobs') return state;
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

/**
 * 运行期状态投影 → 状态行。
 *
 * 每帧只带一个投影 key，所以只合并"有值"的字段：用 undefined 覆盖会把另一
 * 维度（上一步算出的上下文水位）擦掉。
 */
function reduceRunStatusEvent(state: RunState, event: AgentEvent): RunState {
  if (event.type !== 'run_status') return state;
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
function reduceAssistantEvent(state: RunState, event: AgentEvent): RunState {
  if (event.type !== 'assistant') return state;
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
      next = {
        ...next,
        blocks: keepLatestBlocks(newBlocks),
        omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, newBlocks.length - MAX_BLOCKS),
        footer: 'thinking',
      };
    } else if (content.type === 'text') {
      const blocks = markThinkingInactive(next.blocks);
      const last = blocks[blocks.length - 1];
      const newBlocks =
        last?.kind === 'text'
          ? [
              ...blocks.slice(0, -1),
              {
                kind: 'text' as const,
                content: keepTailMarked(last.content + content.text, MAX_TEXT_CHARS),
                timestamp: last.timestamp ?? event.timestamp,
              },
            ]
          : [
              ...blocks,
              {
                kind: 'text' as const,
                content: keepTailMarked(content.text, MAX_TEXT_CHARS),
                timestamp: event.timestamp,
              },
            ];
      next = {
        ...next,
        blocks: keepLatestBlocks(newBlocks),
        omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, newBlocks.length - MAX_BLOCKS),
        footer: 'streaming',
      };
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
        next = {
          ...next,
          blocks: keepLatestBlocks(capped),
          omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, capped.length - MAX_BLOCKS),
          footer: 'tool_running',
        };
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
function reduceToolResultEvent(state: RunState, event: AgentEvent): RunState {
  if (event.type !== 'user') return state;
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
  if (event.type !== 'notice') return state;
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
  if (event.type !== 'session_info') return state;
  return {
    ...state,
    ...(event.title !== undefined ? { sessionTitle: event.title } : {}),
    ...(event.mode !== undefined ? { mode: event.mode } : {}),
  };
}

/** Handle plan event — accumulate plan text for Codex-style agents. */
function reducePlanEvent(state: RunState, event: PlanEvent): RunState {
  if (event.type !== 'plan') return state;
  const currentPlan = state.plan ?? '';
  const newPlan = keepTailMarked(currentPlan + '\n' + event.plan, MAX_REASONING_CHARS * 2);
  // Plan is a single evolving document — replace the existing plan block
  // instead of appending a new one (avoids N overlapping blocks after N events).
  const withoutOldPlan = state.blocks.filter((b) => b.kind !== 'plan');
  const newBlocks = [
    ...withoutOldPlan,
    { kind: 'plan' as const, content: newPlan, active: true, timestamp: event.timestamp },
  ];
  return {
    ...state,
    plan: newPlan,
    blocks: keepLatestBlocks(newBlocks),
    omittedBlocks: (state.omittedBlocks ?? 0) + Math.max(0, newBlocks.length - MAX_BLOCKS),
  };
}

/** Handle file_change event — emit a file_change block for rendering (Codex-style agents). */
function reduceFileChangeEvent(state: RunState, event: FileChangeEvent): RunState {
  if (event.type !== 'file_change') return state;
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
  return {
    ...state,
    blocks: keepLatestBlocks(newBlocks),
    omittedBlocks: (state.omittedBlocks ?? 0) + Math.max(0, newBlocks.length - MAX_BLOCKS),
  };
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
    // .length on the result (2026-08-17 kimi ACP tool_call without rawInput
    // → truncateDetail TypeError). Normalize to ''.
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function keepLatestBlocks(blocks: RunBlock[]): RunBlock[] {
  return blocks.length <= MAX_BLOCKS ? blocks : blocks.slice(-MAX_BLOCKS);
}

/** 截断标记前缀（`keepTailMarked` 产出，含已丢弃正文计数）。 */
const TRUNCATION_MARKER_RE = /^…（前 (\d+) 字符已省略）\n/;

/**
 * keepTail + 截断标记：被去头的存储内容以前缀如实标注（信息保真红线：禁止静默丢弃）。
 * 标记计入 maxChars 预算（存储总量仍 ≤ maxChars，保持既有长度不变量）。
 *
 * 计数口径（2026-10 修正）：只统计**真实丢弃的正文**，不含标记自身开销。
 * 关键点是增量流下 `value` 往往已带上一次的标记（`marker + kept`）；若直接
 * 用 `value.length - kept.length` 计费，会把上一帧的标记文本也算进「已省略」，
 * 造成每帧显示十几字符的虚高。这里先剥离旧标记，把 N 定义为**从该块起始累计
 * 丢弃的正文数**（单调不减），再按「marker 计入预算」的不动点求最小 N。
 */
function keepTailMarked(value: string, maxChars: number): string {
  const prior = TRUNCATION_MARKER_RE.exec(value);
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
  return `…（前 ${totalDropped} 字符已省略）\n${kept}`;
}

function truncateDetail(value: string): string {
  return value.length <= MAX_TOOL_DETAIL_CHARS
    ? value
    : `${value.slice(0, MAX_TOOL_DETAIL_CHARS)}…（已截断）`;
}
