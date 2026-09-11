import type {
  AgentEvent,
  PlanEvent,
  FileChangeEvent,
  ResultEvent,
  ApprovalView,
  TurnStartedEvent,
  TurnDiffEvent,
  NoticeEvent,
  SessionInfoEvent,
  ToolHint,
} from '../runner/index.js';
import { keepTail } from '../common/truncate.js';

const MAX_REASONING_CHARS = 4_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_TOOL_DETAIL_CHARS = 3_000;
const MAX_BLOCKS = 24;

export type RunTerminal =
  'running' | 'finalizing' | 'done' | 'error' | 'interrupted' | 'idle_timeout';
export type RunFooter = 'thinking' | 'tool_running' | 'streaming' | null;
/** 中断来源（interrupted 终态的原因），供卡片如实归因。 */
export type InterruptedReason = 'approval_timeout' | 'user_stop' | 'approval_cancelled';
type ToolStatus = 'running' | 'ok' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  /**
   * P3-6: cached parse of `input` (the truncated string) into a record, so
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

export interface RunState {
  runId: string;
  terminal: RunTerminal;
  footer: RunFooter;
  blocks: RunBlock[];
  sessionId?: string;
  resultSubtype?: 'success' | 'error' | 'interrupted';
  /** interrupted 终态的中断来源；undefined = 未归类（渲染默认文案）。 */
  interruptedReason?: InterruptedReason;
  contextLength?: number;
  /** 当前模型 context window 上限（codex jsonl 提供）；卡片据此渲染百分比。 */
  contextLimit?: number;
  errorMsg?: string;
  idleTimeoutMinutes?: number;
  compactCount?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Agent-declared total; the done card uses max(total, sum of parts). */
  totalTokens?: number;
  /** Real input tokens from the agent's result event (codex/opencode).
   *  When present, the done card shows the real value instead of the
   *  contextLength-based estimate. */
  inputTokens?: number;
  /** Real output tokens from the agent's result event. */
  outputTokens?: number;
  /** 会话累计 total/input/output（所有 run 之和），Run 卡片展示"累计"。 */
  cumulativeTotalTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  /** 会话累计 cache read token（所有 run 之和）。 */
  cumulativeCacheReadTokens?: number;
  /** 会话累计 cache creation token（所有 run 之和）。 */
  cumulativeCacheCreationTokens?: number;
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
  /** 推理 token（pi usage.reasoning 累加，经 finish meta 写入）。 */
  reasoningTokens?: number;
  /** Codex 操作类型：'turn' 表示普通 run，'compaction' 表示 compact 运行。 */
  operationKind?: 'turn' | 'compaction';
  /** 压缩前上下文水位（codex compact 卡展示「压缩前 X → 压缩后 Y」）。 */
  compactPreContextLength?: number;
  /**
   * 待审批请求列表（app-server 模式，review P2-3）。同一 turn 内并发多个审批
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
}

export interface FinishMeta {
  resultSubtype?: 'success' | 'error' | 'interrupted';
  /** 中断来源：由桥侧在 finish 时显式传入（/stop → user_stop、审批卡取消 → approval_cancelled）。 */
  interruptedReason?: InterruptedReason;
  contextLength?: number;
  /** 当前模型 context window 上限；透传到 RunState 供 done 卡片显示百分比。 */
  contextLimit?: number;
  errorMsg?: string;
  idleTimeoutMinutes?: number;
  compactCount?: number;
  compactPreContextLength?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Agent-declared total; threaded to RunState for the done card. */
  totalTokens?: number;
  /** Real input/output tokens from the agent's result event. Threaded through
   *  to RunState so the done card can display real values instead of estimates. */
  inputTokens?: number;
  outputTokens?: number;
  /** 会话累计 total/input/output（所有 run 之和），从 session jsonl 读取。 */
  cumulativeTotalTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeCacheReadTokens?: number;
  cumulativeCacheCreationTokens?: number;
  /** 推理 token（pi usage.reasoning 累加，经 usageMeta 透传）。 */
  reasoningTokens?: number;
}

export function createInitialRunState(runId: string): RunState {
  return {
    runId,
    terminal: 'running',
    footer: 'thinking',
    blocks: [],
  };
}

export function reduceRunState(state: RunState, event: AgentEvent): RunState {
  // 只有终态才阻止事件处理。finalizing 是非终态，
  // 仍需累积 assistant 内容（thinking、text、tool_use、后台任务输出）。
  const terminal = state.terminal;
  if (
    terminal === 'done' ||
    terminal === 'error' ||
    terminal === 'interrupted' ||
    terminal === 'idle_timeout'
  ) {
    return state;
  }

  if (event.type === 'system') return reduceSystemEvent(state, event);
  if (event.type === 'result') return reduceResultEvent(state, event);
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
            parsedInput: tryParseRecord(inputStr),
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
  const resultEvent = event as ResultEvent;
  const incomingSubtype = event.subtype;
  const incomingErrorMsg =
    incomingSubtype === 'error' ? (resultEvent.errorMessage ?? 'Agent 返回错误结果') : undefined;

  // 合并 subtype：error 优先，其次 interrupted（任一为 error 即 error；
  // 否则任一为 interrupted 即 interrupted；interrupted 不得并入 success）。
  const mergedSubtype: 'success' | 'error' | 'interrupted' =
    state.resultSubtype === 'error' || incomingSubtype === 'error'
      ? 'error'
      : state.resultSubtype === 'interrupted' || incomingSubtype === 'interrupted'
        ? 'interrupted'
        : 'success';
  // 合并 errorMsg：首个非 undefined 胜出（existing ?? incoming）
  const mergedErrorMsg = state.errorMsg ?? incomingErrorMsg;

  return {
    ...state,
    terminal: 'finalizing',
    footer: null,
    blocks: markThinkingInactive(state.blocks),
    resultSubtype: mergedSubtype,
    errorMsg: mergedErrorMsg,
    // costUsd：首个非 undefined 胜出（与 errorMsg 合并语义一致）
    ...(event.total_cost_usd !== undefined && state.costUsd === undefined
      ? { costUsd: event.total_cost_usd }
      : {}),
  };
}

/** Handle assistant thinking/text/tool_use content blocks. */
function reduceAssistantEvent(state: RunState, event: AgentEvent): RunState {
  if (event.type !== 'assistant') return state;
  let next = state;
  for (const content of event.message.content) {
    if (content.type === 'thinking') {
      const last = next.blocks[next.blocks.length - 1];
      const newBlocks =
        last?.kind === 'thinking'
          ? [
              ...next.blocks.slice(0, -1),
              {
                kind: 'thinking' as const,
                content: keepTailMarked(
                  last.content + '\n' + content.thinking,
                  MAX_REASONING_CHARS,
                ),
                active: true,
                timestamp: last.timestamp ?? event.timestamp,
              },
            ]
          : [
              ...next.blocks,
              {
                kind: 'thinking' as const,
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
      // P3-6: parse the truncated stored string ONCE here (not on every render)
      // and cache the result on `parsedInput`. tool-render's asRecord then hits
      // the object branch with zero parsing. The parse uses the SAME truncated
      // string as the old per-render parse, so truncation-broken JSON still
      // yields null (over-cap input renders no summary — behavior preserved).
      const inputStr = truncateDetail(stringifyUnknown(content.input));
      const capped = [
        ...markThinkingInactive(next.blocks),
        {
          kind: 'tool' as const,
          tool: {
            id: content.id,
            name: content.name,
            input: inputStr,
            parsedInput: tryParseRecord(inputStr),
            ...(content.summary !== undefined ? { summary: content.summary } : {}),
            status: 'running' as const,
            startedAt: event.timestamp,
          },
        },
      ];
      next = {
        ...next,
        blocks: keepLatestBlocks(capped),
        omittedBlocks: (next.omittedBlocks ?? 0) + Math.max(0, capped.length - MAX_BLOCKS),
        footer: 'tool_running',
      };
    }
  }
  return next;
}

/** Handle tool_result content blocks (user message with tool results).
 *  P3-4: rebuild ONLY the block matching `tool_use_id`, copying every other
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
  terminal: Exclude<RunTerminal, 'running' | 'finalizing'>,
  meta: FinishMeta = {},
): RunState {
  // 允许从 running 或 finalizing finish（/stop、idle watchdog、进程退出 finally）。
  // finalizing 是非终态（result 已收到，进程未退出），可被 finish 转终态。
  // 如果已经是终态，仍然允许补充 meta 信息（如 usage 等，bridge finally 的
  // else-if-sawResult 分支用此路径补充 token 统计）。
  if (state.terminal !== 'running' && state.terminal !== 'finalizing') {
    // Already terminal: apply meta fields if provided (e.g. usage from jsonl)
    const hasMeta = Object.keys(meta).some(
      (k) => (meta as Record<string, unknown>)[k] !== undefined,
    );
    if (!hasMeta) return state;
    return { ...state, ...sanitizeMeta(meta) };
  }
  // interrupted 终态的中断来源：显式传入优先；否则从顶层持久标记推导
  // （approval_expired 已置位但调用方未传 reason 的路径，如协调器过期自动
  // cancel。原因必须在终态确定，不依赖调用方记得传参）。
  const derivedReason =
    meta.interruptedReason ??
    (terminal === 'interrupted' && state.approvalExpired === true ? 'approval_timeout' : undefined);
  return {
    ...state,
    terminal,
    footer: null,
    blocks: markThinkingInactive(state.blocks),
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

/**
 * P3-6: parse a (possibly truncated) string into a record, mirroring what
 * `tool-render.ts`'s `asRecord` did on every render. Returns `null` when the
 * string is empty, non-JSON, or parses to a non-object — so a truncation-broken
 * JSON yields `null` exactly as the old per-render parse did. Computed once at
 * store time and cached on `ToolEntry.parsedInput`.
 */
function tryParseRecord(input: string): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const p = JSON.parse(input);
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function keepLatestBlocks(blocks: RunBlock[]): RunBlock[] {
  return blocks.length <= MAX_BLOCKS ? blocks : blocks.slice(-MAX_BLOCKS);
}

/**
 * keepTail + 截断标记：被去头的存储内容以前缀如实标注（信息保真红线：禁止静默丢弃）。
 * 标记计入 maxChars 预算（存储总量仍 ≤ maxChars，保持既有长度不变量）。
 */
function keepTailMarked(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // marker 计入 maxChars 预算（总量不变量）。省略数 = value.length - kept.length，
  // 而 kept 长度取决于 marker 长度、marker 长度又取决于省略数的位数——
  // 不动点迭代（marker 固定部分 12 字符，位数至多几次即收敛）。
  let dropped = value.length - maxChars + 12;
  for (;;) {
    const next = value.length - maxChars + 12 + String(dropped).length;
    if (next === dropped) break;
    dropped = next;
  }
  const marker = `…（前 ${dropped} 字符已省略）\n`;
  const kept = keepTail(value, Math.max(0, maxChars - marker.length));
  return marker + kept;
}

function truncateDetail(value: string): string {
  return value.length <= MAX_TOOL_DETAIL_CHARS
    ? value
    : `${value.slice(0, MAX_TOOL_DETAIL_CHARS)}…（已截断）`;
}
