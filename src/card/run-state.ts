import type { AgentEvent, PlanEvent, FileChangeEvent, ResultEvent } from '../runner/index.js';

const MAX_REASONING_CHARS = 4_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_TOOL_DETAIL_CHARS = 3_000;
const MAX_BLOCKS = 24;

export type RunTerminal =
  'running' | 'finalizing' | 'done' | 'error' | 'interrupted' | 'idle_timeout';
export type RunFooter = 'thinking' | 'tool_running' | 'streaming' | null;
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
}

export type RunBlock =
  | { kind: 'thinking'; content: string; active: boolean; timestamp?: string }
  | { kind: 'text'; content: string; timestamp?: string }
  | { kind: 'tool'; tool: ToolEntry }
  | { kind: 'plan'; content: string; active: boolean; timestamp?: string }
  | {
      kind: 'file_change';
      path: string;
      operation: 'create' | 'edit' | 'delete' | 'read';
      diff?: string;
      timestamp?: string;
    };

export interface RunState {
  runId: string;
  terminal: RunTerminal;
  footer: RunFooter;
  blocks: RunBlock[];
  sessionId?: string;
  resultSubtype?: 'success' | 'error';
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
}

export interface FinishMeta {
  resultSubtype?: 'success' | 'error';
  contextLength?: number;
  /** 当前模型 context window 上限；透传到 RunState 供 done 卡片显示百分比。 */
  contextLimit?: number;
  errorMsg?: string;
  idleTimeoutMinutes?: number;
  compactCount?: number;
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
  return state;
}

/** Handle system init and compact_boundary events. */
function reduceSystemEvent(state: RunState, event: AgentEvent): RunState {
  if (event.type !== 'system') return state;
  if (event.subtype === 'init') {
    return { ...state, sessionId: event.session_id, footer: 'thinking' };
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
  const resultEvent = event as ResultEvent;
  const incomingSubtype = event.subtype;
  const incomingErrorMsg =
    incomingSubtype === 'error' ? (resultEvent.errorMessage ?? 'Agent 返回错误结果') : undefined;

  // 合并 subtype：error 优先（任一为 error 即 error）
  const mergedSubtype: 'success' | 'error' =
    state.resultSubtype === 'error' || incomingSubtype === 'error' ? 'error' : 'success';
  // 合并 errorMsg：首个非 undefined 胜出（existing ?? incoming）
  const mergedErrorMsg = state.errorMsg ?? incomingErrorMsg;

  return {
    ...state,
    terminal: 'finalizing',
    footer: null,
    blocks: markThinkingInactive(state.blocks),
    resultSubtype: mergedSubtype,
    errorMsg: mergedErrorMsg,
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
                content: keepLatest(last.content + '\n' + content.thinking, MAX_REASONING_CHARS),
                active: true,
                timestamp: last.timestamp ?? event.timestamp,
              },
            ]
          : [
              ...next.blocks,
              {
                kind: 'thinking' as const,
                content: keepLatest(content.thinking, MAX_REASONING_CHARS),
                active: true,
                timestamp: event.timestamp,
              },
            ];
      next = {
        ...next,
        blocks: keepLatestBlocks(newBlocks),
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
                content: keepLatest(last.content + content.text, MAX_TEXT_CHARS),
                timestamp: last.timestamp ?? event.timestamp,
              },
            ]
          : [
              ...blocks,
              {
                kind: 'text' as const,
                content: keepLatest(content.text, MAX_TEXT_CHARS),
                timestamp: event.timestamp,
              },
            ];
      next = {
        ...next,
        blocks: keepLatestBlocks(newBlocks),
        footer: 'streaming',
      };
    } else {
      // P3-6: parse the truncated stored string ONCE here (not on every render)
      // and cache the result on `parsedInput`. tool-render's asRecord then hits
      // the object branch with zero parsing. The parse uses the SAME truncated
      // string as the old per-render parse, so truncation-broken JSON still
      // yields null (over-cap input renders no summary — behavior preserved).
      const inputStr = truncateDetail(stringifyUnknown(content.input));
      next = {
        ...next,
        blocks: keepLatestBlocks([
          ...markThinkingInactive(next.blocks),
          {
            kind: 'tool',
            tool: {
              id: content.id,
              name: content.name,
              input: inputStr,
              parsedInput: tryParseRecord(inputStr),
              status: 'running',
              startedAt: event.timestamp,
            },
          },
        ]),
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

/** Handle plan event — accumulate plan text for Codex-style agents. */
function reducePlanEvent(state: RunState, event: PlanEvent): RunState {
  if (event.type !== 'plan') return state;
  const currentPlan = state.plan ?? '';
  const newPlan = keepLatest(currentPlan + '\n' + event.plan, MAX_REASONING_CHARS * 2);
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
  return {
    ...state,
    terminal,
    footer: null,
    blocks: markThinkingInactive(state.blocks),
    ...sanitizeMeta(meta),
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
    return JSON.stringify(value);
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

function keepLatest(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function keepLatestBlocks(blocks: RunBlock[]): RunBlock[] {
  return blocks.length <= MAX_BLOCKS ? blocks : blocks.slice(-MAX_BLOCKS);
}

function truncateDetail(value: string): string {
  return value.length <= MAX_TOOL_DETAIL_CHARS
    ? value
    : `${value.slice(0, MAX_TOOL_DETAIL_CHARS)}…（已截断）`;
}
