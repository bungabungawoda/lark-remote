import type { RunBlock, RunFooter, RunState, ToolEntry } from './run-state.js';
import {
  terminalToColor,
  terminalToLabel,
  newSessionButton,
  stopButton,
  compactButton,
  agentDisplayName,
} from './card-shared.js';
import { collapsibleMarkdownPanel, markdownDiv, type PanelBorder } from './collapsible.js';
import { toolBodyMd, toolHeaderText } from './tool-render.js';
import { truncateUtf8, truncateMarkdownTables, CARD_BUDGET_BYTES } from './text-truncate.js';
import { formatTimestamp } from './time.js';
import { formatUsageStats } from '../router/utils.js';
import { renderApprovalArea } from './approval-render.js';

const REASONING_BYTES = 4_500;
const TEXT_BYTES = 10_000;
const DEGRADED_THINKING_KEEP = 2;
const DEGRADED_TEXT_BYTES = 5_000;
const DEGRADED_THINKING_BYTES = 1_000;
const DEGRADED_TOOL_KEEP = 3; // Degraded: keep last 3 tool panels
const EXTREME_TOOL_KEEP = 1; // Extreme: keep last 1 tool panel

// --- Budget estimate (先估后建) ---
// 影子测量：估算 = 精确复刻 normal 路径将要渲染的 JSON 字节。面板外壳、statusRow、
// summary、header、按钮全部实测（measureJson），块内容经与渲染相同的变换
// （truncateUtf8 截断 + markdownDiv 的 escapeMarkdown + JSON.stringify）精确测量，
// 不依赖任何转义因子或拍脑袋常数（P1-2 第二轮：CJK/ASCII 转义双向精确）。
const DEGRADED_THRESHOLD = 24_000; // 估算低于此值走正常路径（留 4KB 裕度，相对 CARD_BUDGET_BYTES=28000）；否则直接 degraded。调整时同步评估裕度是否仍覆盖估算偏差

/** 精确测量对象经 JSON.stringify 后的 UTF-8 字节数。 */
function measureJson(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

/** markdownDiv('', 'notation') 的序列化字节（空内容 div 的常量开销，估算时复用）。 */
const EMPTY_MD_DIV_BYTES = measureJson(markdownDiv('', 'notation'));

/**
 * Compact 按钮可见性：普通 run（operationKind='turn'）到达任意终态即可压缩。
 * 异常退出（error/interrupted/idle_timeout）时上下文往往更大，更需要压缩后
 * 再继续，因此不再要求 resultSubtype==='success'。compaction 卡
 * （operationKind='compaction'）永不显示，防止递归 Compact。
 */
function shouldShowCompactButton(state: RunState): boolean {
  if (state.operationKind !== 'turn') return false;
  return (
    state.terminal === 'done' ||
    state.terminal === 'error' ||
    state.terminal === 'interrupted' ||
    state.terminal === 'idle_timeout'
  );
}

/**
 * Wrap text block in a collapsible panel with timestamp in the header.
 * This unifies timestamp position across all block types (thinking/plan/file_change/tool/text).
 *
 * Panel title: `💬 **输出** (ts)` when timestamp present, `💬 **输出**` otherwise.
 * Running: expanded=true; completed: expanded=false (symmetric with thinking).
 *
 * @param content - The text content to render
 * @param timestamp - Optional timestamp for the block
 * @param finalized - Whether the run is in a terminal state
 * @returns elements
 */
function renderTextBlock(
  content: string,
  timestamp?: string,
  finalized: boolean = false,
): object[] {
  if (!content.trim()) {
    return [];
  }

  const ts = formatTimestamp(timestamp);

  // Terminal state: output is the card body, render in collapsible_panel with expanded=true.
  // NOTE: collapsible_panel does NOT shield markdown tables from Feishu's 11310 table count
  // limit — tables inside lark_md text are still counted regardless of container.
  // We must explicitly truncate excess tables via truncateMarkdownTables before rendering.
  if (finalized) {
    const title = '💬 **输出**';
    const header = ts ? `${title} (${ts})` : title;
    const safeContent = truncateMarkdownTables(content);
    return [
      collapsibleMarkdownPanel({
        title: header,
        expanded: true, // Always expanded in finalized state for full visibility
        border: 'grey',
        content: safeContent,
        textSize: 'notation',
      }),
    ];
  }

  // Running/finalizing: panel provides visual grouping with timestamp in header
  const title = '💬 **输出**';
  const header = ts ? `${title} (${ts})` : title;
  const safeContent = truncateMarkdownTables(content);

  return [
    collapsibleMarkdownPanel({
      title: header,
      expanded: true,
      border: 'grey',
      content: safeContent,
      textSize: 'notation',
    }),
  ];
}

export interface RunCardRenderOptions {
  showThinking?: boolean;
  showToolUse?: boolean;
  showToolResult?: boolean;
  /**
   * Agent kind for the run card header title (e.g. "Claude · 思考中").
   * Defaults to 'claude' when not provided; the bridge passes `config.defaultAgent`.
   */
  agentKind?: string;
}

// =============================================================================
// CardKit 2.0 renderer
// =============================================================================

type BlockGroup =
  | { kind: 'thinking'; content: string; active: boolean; timestamp?: string }
  | { kind: 'text'; content: string; timestamp?: string }
  | { kind: 'tool'; tool: ToolEntry } // Each tool is independent
  | { kind: 'plan'; content: string; active: boolean; timestamp?: string }
  | {
      kind: 'file_change';
      path: string;
      operation: 'create' | 'edit' | 'delete' | 'read';
      diff?: string;
      timestamp?: string;
    };

/** 每个块的截断后内容（thinking/plan/text），测量与渲染共用（P1-2 建议项）。 */
type GroupContentPrepared = Map<BlockGroup, string>;

/**
 * 单次截断：把每个超限块（thinking/plan/text）的最终渲染内容算出来，供
 * estimateCardBytes 与 buildChronologicalContent 共用。此前影子测量与正式渲染
 * 各自 truncateUtf8 一次（双倍截断）；现在截断只发生在 prepare 阶段。
 */
function prepareGroupContent(groups: BlockGroup[]): GroupContentPrepared {
  const prepared = new Map<BlockGroup, string>();
  for (const group of groups) {
    if (group.kind === 'thinking') {
      prepared.set(group, truncateUtf8(group.content, REASONING_BYTES));
    } else if (group.kind === 'plan') {
      prepared.set(group, truncateUtf8(group.content, REASONING_BYTES * 2));
    } else if (group.kind === 'text') {
      prepared.set(group, truncateUtf8(group.content, TEXT_BYTES, true, '…（已截断）\n'));
    }
  }
  return prepared;
}

/**
 * Group blocks by type. Each tool is emitted independently.
 * This enables per-tool compression (keep last N, discard older ones).
 */
function groupBlocks(blocks: RunBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  for (const block of blocks) {
    // Each tool is emitted as its own group (not grouped with other tools)
    if (block.kind === 'tool') {
      groups.push({ kind: 'tool', tool: block.tool });
      continue;
    }
    // Handle thinking block — emit as separate group
    if (block.kind === 'thinking') {
      groups.push({
        kind: 'thinking',
        content: block.content,
        active: block.active,
        timestamp: block.timestamp,
      });
      continue;
    }
    // Handle plan block — emit as separate group (collapsed by default)
    if (block.kind === 'plan') {
      groups.push({
        kind: 'plan',
        content: block.content,
        active: block.active,
        timestamp: block.timestamp,
      });
      continue;
    }
    // Handle file_change block — emit as separate group (collapsed by default)
    if (block.kind === 'file_change') {
      groups.push({
        kind: 'file_change',
        path: block.path,
        operation: block.operation,
        diff: block.diff,
        timestamp: block.timestamp,
      });
      continue;
    }
    // text block: merge with previous text if consecutive
    if (block.kind === 'text') {
      const last = groups[groups.length - 1];
      if (last?.kind === 'text') {
        groups[groups.length - 1] = {
          kind: 'text',
          content: last.content + block.content,
          timestamp: last.timestamp ?? block.timestamp,
        };
      } else {
        groups.push({ kind: 'text', content: block.content, timestamp: block.timestamp });
      }
    }
  }
  return groups;
}

/**
 * Render a single tool as a collapsible panel.
 * - Running tool: expanded (user can watch live)
 * - Completed tool: collapsed (click to inspect)
 */
function renderTool(tool: ToolEntry, finalized: boolean, showResult: boolean): object {
  const border: PanelBorder = tool.status === 'error' ? 'red' : 'grey';
  const body = showResult ? toolBodyMd(tool) : toolBodyMd({ ...tool, output: undefined });
  return collapsibleMarkdownPanel({
    title: toolTitle(tool),
    expanded: !finalized && tool.status === 'running',
    border,
    content: body || '_无输出_',
    textSize: 'notation',
  });
}

function toolTitle(tool: ToolEntry): string {
  const ts = formatTimestamp(tool.completedAt ?? tool.startedAt);
  const title = toolHeaderText(tool);
  return ts ? `${title} (${ts})` : title;
}

/**
 * Fallback-tier budget configuration (degraded vs extreme share one builder,
 * differing only in how aggressively content is cut).
 */
interface BudgetTierConfig {
  /** Max thinking blocks to keep. */
  thinkingKeep: number;
  /** Thinking block truncation byte budget. */
  thinkingBytes: number;
  /** Max tool blocks to keep. */
  toolKeep: number;
  /** Text block truncation byte budget. */
  textBytes: number;
}

const DEGRADED_TIER: BudgetTierConfig = {
  thinkingKeep: DEGRADED_THINKING_KEEP,
  thinkingBytes: REASONING_BYTES,
  toolKeep: DEGRADED_TOOL_KEEP,
  textBytes: TEXT_BYTES,
};

const EXTREME_TIER: BudgetTierConfig = {
  thinkingKeep: 1,
  thinkingBytes: DEGRADED_THINKING_BYTES,
  toolKeep: EXTREME_TOOL_KEEP,
  textBytes: DEGRADED_TEXT_BYTES,
};

/** Bottom action row: stop (if running) + compact (if applicable) + new session (always). */
function actionRow(state: RunState): object[] {
  const actionButtons: object[] = [];
  // finalizing 也显示停止按钮（进程未退出，用户可 /stop）
  const showStop = state.terminal === 'running' || state.terminal === 'finalizing';
  if (showStop) {
    actionButtons.push(stopButton(state.runId));
  }
  // Compact 按钮：普通 turn 到达任意终态即可压缩（含异常退出），compaction 卡除外
  if (shouldShowCompactButton(state)) {
    actionButtons.push(compactButton(state.runId));
  }
  actionButtons.push(newSessionButton());

  if (actionButtons.length === 0) return [];
  return [
    { tag: 'div', text: { content: '‎', tag: 'lark_md' } }, // spacer
    {
      tag: 'column_set',
      columns: actionButtons.map((btn) => ({
        tag: 'column',
        width: 'auto',
        elements: [btn],
      })),
    },
  ];
}

/** 审批区位于 body 最底部（底部操作行之后）：待审批时决策按钮不遮挡内容流。 */
function approvalArea(state: RunState): object[] {
  const elements: object[] = [];
  for (const slot of state.approvals ?? []) {
    elements.push(
      ...renderApprovalArea(slot.view, {
        expired: slot.expired,
        runId: state.runId,
        terminal: state.terminal,
      }),
    );
  }
  return elements;
}

/** Assemble the card shell (schema/config/header) around body elements. */
function assembleRunCard(
  state: RunState,
  options: RunCardRenderOptions,
  elements: object[],
): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: headerTemplate2(state),
      title: { content: headerTitle2(state, options), tag: 'plain_text' },
    },
    body: { elements },
  };
}

/**
 * Build a budget-fallback tier (degraded or extreme): keep the last N thinking
 * blocks and last N tools, truncate text/thinking per tier, then render in
 * chronological order. Shared by buildDegradedElements / buildExtremeFallback.
 */
function buildFallbackElements(
  state: RunState,
  options: RunCardRenderOptions,
  tier: BudgetTierConfig,
): object[] {
  const elements: object[] = [];

  elements.push(statusRow(state));

  // 单遍分桶：thinking / tool（保持原相对顺序）
  const { thinking: allThinkingBlocks, tool: allToolBlocks } = bucketThinkingAndTool(state.blocks);

  if (allThinkingBlocks.length > tier.thinkingKeep) {
    const omitted = allThinkingBlocks.length - tier.thinkingKeep;
    elements.push(markdownDiv(`_💡 ${omitted} 个早期思考已省略_`));
  }
  const thinkingBlocksToShow = allThinkingBlocks.slice(-tier.thinkingKeep);

  const toolsToShow = allToolBlocks.slice(-tier.toolKeep);
  const toolsOmitted = allToolBlocks.length - tier.toolKeep;

  // Add omit hint for tools if any were omitted
  if (toolsOmitted > 0) {
    elements.push(markdownDiv(`_💡 另外 ${toolsOmitted} 个工具调用已省略_`));
  }

  // P2-6: use object references (like the extreme path) instead of timestamps.
  // RunBlock.timestamp has millisecond precision; ≥2 thinking blocks sharing a
  // timestamp collapse to one Set entry, so `has(block.timestamp)` lets ALL
  // same-timestamp blocks (including ones meant to be omitted) pass through —
  // inflating the card past 28KB and contradicting the "N omitted" hint.
  // `thinkingBlocksToShow` is a slice of `allThinkingBlocks`, so the blocks
  // retain stable references and the Set membership check is exact.
  const thinkingSetToShow = new Set(thinkingBlocksToShow);
  const toolIdsToShow = new Set(toolsToShow.map((b) => b.tool.id));
  const filteredBlocks = state.blocks.filter((block) => {
    if (block.kind === 'thinking') {
      return thinkingSetToShow.has(block);
    }
    if (block.kind === 'tool') {
      return toolIdsToShow.has(block.tool.id);
    }
    return true; // keep all non-thinking, non-tool blocks
  });

  // Render thinking/text/tool in chronological order using groupBlocks
  for (const group of groupBlocks(filteredBlocks)) {
    if (group.kind === 'thinking') {
      if (options.showThinking === false) continue;
      const ts = formatTimestamp(group.timestamp);
      const title = '💭 **思考完成**';
      const content = truncateUtf8(group.content, tier.thinkingBytes);
      const header = ts ? `${title} (${ts})` : title;
      elements.push(
        collapsibleMarkdownPanel({
          title: header,
          expanded: false,
          border: 'grey',
          content,
          textSize: 'notation',
        }),
      );
    } else if (group.kind === 'text') {
      const content = truncateUtf8(group.content, tier.textBytes, true, '…（已截断）\n');
      const ts = formatTimestamp(group.timestamp);
      elements.push(...renderTextBlock(content, ts, true));
    } else if (group.kind === 'tool') {
      // Show tool individually (each tool is independent now)
      if (options.showToolUse === false) continue;
      elements.push(renderTool(group.tool, true, options.showToolResult !== false)); // finalized=true
    }
  }

  if (elements.length === 0 && tier === EXTREME_TIER) {
    elements.push(markdownDiv('_暂无输出_'));
  }

  elements.push(...buildSummaryContent(state));
  elements.push(...actionRow(state));
  elements.push(...approvalArea(state));

  return elements;
}

/**
 * Build degraded elements when full card exceeds 28KB budget.
 * Strategy: text fully preserved, thinking keeps last 2, tools keep last N (compressed).
 */
function buildDegradedElements(state: RunState, options: RunCardRenderOptions): object[] {
  return buildFallbackElements(state, options, DEGRADED_TIER);
}

/**
 * Extreme fallback when even degraded card exceeds 28KB.
 * Strategy: text truncated to 5KB tail, thinking only last 1 truncated to 1KB,
 * tools keep last N (more aggressive than degraded).
 */
function buildExtremeFallbackElements(state: RunState, options: RunCardRenderOptions): object[] {
  return buildFallbackElements(state, options, EXTREME_TIER);
}

/** Build the status row element (shared across full/degraded/extreme). */
function statusRow(state: RunState): object {
  const statusLabel = statusTagLabel(state.terminal);
  const durationInfo = buildDurationInfo(state);
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [{ tag: 'div', text: { content: statusLabel, tag: 'lark_md' } }],
      },
      {
        tag: 'column',
        width: 'grow',
        elements: [{ tag: 'div', text: { content: durationInfo, tag: 'lark_md' } }],
      },
    ],
  };
}

/**
 * Minimal skeleton card — the final safety net when even the extreme fallback
 * exceeds the 28KB budget (pathological high-escape content: backslash inflates
 * 4× via escapeMarkdown + JSON.stringify). The extreme fallback is the last
 * degradation layer and used to `return` without a budget check, leaking >28KB
 * cards to Feishu (ErrCode 11310, card unusable).
 *
 * This guarantees a structurally tiny card: status row + a fixed "output too
 * large" notice + summary + the bottom action buttons (new session always;
 * stop while running/finalizing). No block content is rendered, so the size is
 * bounded by static structure regardless of input — closing the safety-net gap.
 */
function buildSkeletonElements(state: RunState): object[] {
  const elements: object[] = [];

  elements.push(statusRow(state));
  elements.push(
    markdownDiv('_⚠️ 输出过大且含大量转义字符，已省略全部内容以避免超限；完整内容请查日志_'),
  );

  // Summary (token stats etc.) — static, bounded size
  elements.push(...buildSummaryContent(state));

  // Bottom action row: stop (if running/finalizing) + compact (if applicable) + new session (always).
  // Degraded paths must keep the action buttons reachable (design constraint).
  elements.push(...actionRow(state));

  return elements;
}

/**
 * Single-pass bucket of thinking/tool blocks, preserving original relative
 * order. Shared by degraded and extreme fallback (replaces repeated
 * `state.blocks.filter()` scans). Returning precise element types lets
 * callers access `.timestamp` / `.tool.id` without a redundant type guard.
 */
function bucketThinkingAndTool(blocks: RunBlock[]): {
  thinking: Extract<RunBlock, { kind: 'thinking' }>[];
  tool: Extract<RunBlock, { kind: 'tool' }>[];
} {
  const thinking: Extract<RunBlock, { kind: 'thinking' }>[] = [];
  const tool: Extract<RunBlock, { kind: 'tool' }>[] = [];
  for (const block of blocks) {
    if (block.kind === 'thinking') {
      thinking.push(block);
    } else if (block.kind === 'tool') {
      tool.push(block);
    }
  }
  return { thinking, tool };
}

/**
 * 影子测量：精确复刻 normal 路径（buildChronologicalContent + renderRunCard 的
 * 骨架）产物 stringify 后的字节数，避免"先建完整卡再丢弃"的浪费。
 *
 * 第一性原理：估算应当测量"将要渲染的内容"，而非近似它。
 * - 骨架（schema/config/header/statusRow/summary/buttons/spacer）用小对象实测
 *   （measureJson），不依赖固定常数。
 * - 块内容经与渲染完全相同的变换后精确测量：truncateUtf8 截断 →
 *   markdownDiv 的 escapeMarkdown（反斜杠 2×）→ JSON.stringify。因此 CJK
 *   （3 字节/字符无转义）与 ASCII 高转义（\n/" 膨胀）双向精确，无需转义因子。
 * - tool 块直接 measureJson(renderTool(...))——与渲染共用同一函数，无复制。
 * - 块结构基于 groupBlocks（与渲染一致，连续 text 合并），保证合并语义一致。
 *
 * 唯一系统性低估：elements 数组元素间逗号/括号 ~n+1 字节（忽略，4KB 裕度内）。
 *
 * 注意：估算只是优化路径选择，不替代最终 stringify 兜底。即使估算说"低于阈值"
 * 走正常路径，renderRunCard 仍会 stringify 确认 ≤28KB；若估算低估，仍 fallback
 * 到 degraded（安全网不丢）。
 */
/** 导出供测试断言估算精度（估算 ≈ 实际渲染字节，见 tests/anchor/run-card/run-card.test.ts）。 */
export function estimateCardBytes(
  state: RunState,
  options: RunCardRenderOptions = {},
  shared?: { groups?: BlockGroup[]; prepared?: GroupContentPrepared },
): number {
  const finalized = state.terminal !== 'running';
  const showResult = options.showToolResult !== false;
  const showThinking = options.showThinking !== false;
  const showToolUse = options.showToolUse !== false;
  // P1-2：renderRunCard 传入共享 groups/prepared 时直接复用（截断只做一次）；
  // 独立调用（测试/预算探针）时自建，行为与原先一致。
  const groups = shared?.groups ?? groupBlocks(state.blocks);
  const prepared = shared?.prepared ?? prepareGroupContent(groups);

  // 卡片外壳 + 状态行 + summary（小对象实测，动态文案精确）
  let total =
    measureJson({
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: headerTemplate2(state),
        title: { content: headerTitle2(state, options), tag: 'plain_text' },
      },
      body: { elements: [] },
    }) +
    measureJson(statusRow(state)) +
    measureJson(buildSummaryContent(state));

  // 底部操作行：spacer + 操作按钮（与 renderRunCard normal 分支一致）
  const actionButtons: object[] = [];
  if (state.terminal === 'running' || state.terminal === 'finalizing') {
    actionButtons.push(stopButton(state.runId));
  }
  actionButtons.push(newSessionButton());
  total += measureJson([
    { tag: 'div', text: { content: '‎', tag: 'lark_md' } },
    {
      tag: 'column_set',
      columns: actionButtons.map((btn) => ({
        tag: 'column',
        width: 'auto',
        elements: [btn],
      })),
    },
  ]);

  // 块内容：与 buildChronologicalContent 同源（groupBlocks 合并语义一致）
  let renderedAny = false;
  for (const group of groups) {
    if (group.kind === 'thinking') {
      if (!showThinking) continue;
      renderedAny = true;
      const ts = formatTimestamp(group.timestamp);
      const title = group.active ? '💭 **思考中**' : '💭 **思考完成**';
      const header = ts ? `${title} (${ts})` : title;
      total += measurePanelBytes(header, group.active, 'grey', prepared.get(group) ?? '');
    } else if (group.kind === 'plan') {
      renderedAny = true;
      const ts = formatTimestamp(group.timestamp);
      const title = group.active ? '📋 **执行计划**' : '📋 **计划完成**';
      const header = ts ? `${title} (${ts})` : title;
      total += measurePanelBytes(header, group.active, 'blue', prepared.get(group) ?? '');
    } else if (group.kind === 'file_change') {
      renderedAny = true;
      const ts = formatTimestamp(group.timestamp);
      const opIcon =
        group.operation === 'create'
          ? '🆕'
          : group.operation === 'edit'
            ? '✏️'
            : group.operation === 'delete'
              ? '🗑️'
              : '📖';
      const title = `${opIcon} **文件改动**`;
      const content = group.diff
        ? `**${group.path}**\n\n\`\`\`\n${group.diff}\n\`\`\``
        : `**${group.path}** (${group.operation})`;
      const header = ts ? `${title} (${ts})` : title;
      total += measurePanelBytes(header, false, 'grey', content);
    } else if (group.kind === 'text') {
      const content = prepared.get(group) ?? '';
      if (!content.trim()) continue;
      renderedAny = true;
      const ts = formatTimestamp(group.timestamp);
      const header = `💬 **输出**${ts ? ` (${ts})` : ''}`;
      total += measurePanelBytes(header, true, 'grey', content);
    } else if (group.kind === 'tool') {
      if (!showToolUse) continue;
      renderedAny = true;
      // tool 直接实测真实渲染元素（复用 renderTool，output ≤1200 字符，物化廉价）
      total += measureJson(renderTool(group.tool, finalized, showResult));
    }
  }

  if (!renderedAny) {
    total += measureJson(markdownDiv('_暂无输出_'));
  }

  return Math.ceil(total);
}

/**
 * 精确测量一个 collapsible 面板的序列化字节。
 * 外壳（title/expanded/border/elements 结构）用空 content 面板实测，内容单独
 * 经 markdownDiv（含 escapeMarkdown）精确测量——与渲染完全一致。
 */
function measurePanelBytes(
  title: string,
  expanded: boolean,
  border: PanelBorder,
  content: string,
): number {
  const shell = collapsibleMarkdownPanel({
    title,
    expanded,
    border,
    content: '',
    textSize: 'notation',
  });
  return measureJson(shell) - EMPTY_MD_DIV_BYTES + measureJson(markdownDiv(content, 'notation'));
}

/**
 * CardKit 2.0 renderer - simplified for streaming (no tabs)
 */
export function renderRunCard(state: RunState, options: RunCardRenderOptions = {}): object {
  // 先估后建：用廉价估算预测是否超 28KB 预算，明显超预算直接跳过完整卡构建走
  // degraded。P1-2：groups/prepared 只算一次，测量与正式渲染共用同一份截断结果，
  // 避免影子测量 + 正式渲染对每个超限块双倍截断。
  const groups = groupBlocks(state.blocks);
  const prepared = prepareGroupContent(groups);
  const estimate = estimateCardBytes(state, options, { groups, prepared });

  // 构建完整卡（仅在估算低于阈值时，避免大 state 浪费 render + stringify）
  if (estimate < DEGRADED_THRESHOLD) {
    const elements: object[] = [
      statusRow(state),
      ...buildChronologicalContent(state, options, prepared, groups),
      ...buildSummaryContent(state),
      ...actionRow(state),
      ...approvalArea(state),
    ];

    const card = assembleRunCard(state, options, elements);

    // Check budget — stringify 兜底（估算可能低估，仍保留安全网）
    if (Buffer.byteLength(JSON.stringify(card), 'utf8') <= CARD_BUDGET_BYTES) return card;
    // 超预算 → 继续走 degraded（不 return，fallthrough）
  }

  // 估算 ≥ 阈值 或 完整卡 stringify 超预算 — 走 degraded 渲染
  const degradedCard = assembleRunCard(state, options, buildDegradedElements(state, options));
  if (Buffer.byteLength(JSON.stringify(degradedCard), 'utf8') <= CARD_BUDGET_BYTES) {
    return degradedCard;
  }

  // Extreme fallback: even degraded exceeds budget
  const extremeCard = assembleRunCard(state, options, buildExtremeFallbackElements(state, options));

  // Final safety net: extreme fallback 是最后一层，但高转义内容（反斜杠 4× 膨胀）
  // 可能让 extreme 产物本身 >28KB。补上 stringify 兜底（与 normal/degraded 对称）：
  // 超预算则降级到结构性保证 ≤28KB 的 skeleton 卡，避免飞书 11310 整卡不可用。
  if (Buffer.byteLength(JSON.stringify(extremeCard), 'utf8') <= CARD_BUDGET_BYTES) {
    return extremeCard;
  }

  const skeletonCard = assembleRunCard(state, options, buildSkeletonElements(state));
  // skeleton 卡是静态结构，理论上必 ≤28KB；保留兜底断言以防未来结构膨胀
  if (Buffer.byteLength(JSON.stringify(skeletonCard), 'utf8') <= CARD_BUDGET_BYTES) {
    return skeletonCard;
  }

  // 理论上不可达：skeleton 已是静态最小结构。若仍超限，硬截断文本提示兜底。
  const truncatedSkeleton = {
    ...skeletonCard,
    body: {
      elements: [statusRow(state), markdownDiv('_⚠️ 输出过大_'), newSessionButton()],
    },
  };
  return truncatedSkeleton;
}

/** Build content in chronological order using groupBlocks to interleave thinking/text/tools. */
function buildChronologicalContent(
  state: RunState,
  options: RunCardRenderOptions,
  prepared?: GroupContentPrepared,
  groups?: BlockGroup[],
): object[] {
  const elements: object[] = [];
  // finalized = 非 running（含 finalizing：主结果已出，thinking 折叠）
  const finalized = state.terminal !== 'running';
  const showResult = options.showToolResult !== false;

  // P1-2：renderRunCard 传入同一 groups 数组时直接复用（prepared 的键是组对象
  // 引用，重建数组会让 prepared.get 永远 miss，退化为二次截断）。
  for (const group of groups ?? groupBlocks(state.blocks)) {
    if (group.kind === 'thinking') {
      if (options.showThinking === false) continue;
      const ts = formatTimestamp(group.timestamp);
      const title = group.active ? '💭 **思考中**' : '💭 **思考完成**';
      const content = prepared?.get(group) ?? truncateUtf8(group.content, REASONING_BYTES);
      const header = ts ? `${title} (${ts})` : title;
      elements.push(
        collapsibleMarkdownPanel({
          title: header,
          expanded: group.active,
          border: 'grey',
          content,
          textSize: 'notation',
        }),
      );
    } else if (group.kind === 'plan') {
      // Plan blocks: render as collapsible panel (default collapsed)
      const ts = formatTimestamp(group.timestamp);
      const title = group.active ? '📋 **执行计划**' : '📋 **计划完成**';
      const content = prepared?.get(group) ?? truncateUtf8(group.content, REASONING_BYTES * 2);
      const header = ts ? `${title} (${ts})` : title;
      elements.push(
        collapsibleMarkdownPanel({
          title: header,
          expanded: group.active, // expand while active, collapse when done
          border: 'blue',
          content,
          textSize: 'notation',
        }),
      );
    } else if (group.kind === 'file_change') {
      // File change blocks: render as collapsible panel (default collapsed)
      const ts = formatTimestamp(group.timestamp);
      const opIcon =
        group.operation === 'create'
          ? '🆕'
          : group.operation === 'edit'
            ? '✏️'
            : group.operation === 'delete'
              ? '🗑️'
              : '📖';
      const title = `${opIcon} **文件改动**`;
      const content = group.diff
        ? `**${group.path}**\n\n\`\`\`\n${group.diff}\n\`\`\``
        : `**${group.path}** (${group.operation})`;
      const header = ts ? `${title} (${ts})` : title;
      elements.push(
        collapsibleMarkdownPanel({
          title: header,
          expanded: false,
          border: 'grey',
          content,
          textSize: 'notation',
        }),
      );
    } else if (group.kind === 'text') {
      const content =
        prepared?.get(group) ?? truncateUtf8(group.content, TEXT_BYTES, true, '…（已截断）\n');
      const ts = formatTimestamp(group.timestamp);
      const els = renderTextBlock(content, ts, finalized);
      elements.push(...els);
    } else if (group.kind === 'tool') {
      if (options.showToolUse === false) continue;
      elements.push(renderTool(group.tool, finalized, showResult));
    }
  }

  if (elements.length === 0) {
    elements.push(markdownDiv('_暂无输出_'));
  }

  return elements;
}

/** Build summary tab content */
function buildSummaryContent(state: RunState): object[] {
  const elements: object[] = [];

  // running 时不显示统计（仍在生成）；finalizing 显示等待提示
  if (state.terminal === 'running') {
    return elements;
  }
  if (state.terminal === 'finalizing') {
    elements.push(markdownDiv('⏳ **等待进程退出…**'));
    return elements;
  }

  if (state.terminal === 'error') {
    elements.push(markdownDiv(`⚠️ **运行出错**\n\n${state.errorMsg ?? '未知错误'}`));
  } else if (state.terminal === 'interrupted') {
    // 审批超时（approval_expired 已标记）是「无人响应被自动取消」，不是用户
    // 主动终止；如实展示原因，避免用户误判为 Agent 出错或自己操作过。
    // 顶层 approvalExpired 优先：approval_resolved 会移除审批条目，但标记
    // 必须活到终态渲染（2026-08-15 事故回归）。
    const expiredApproval =
      state.interruptedReason === 'approval_timeout' ||
      state.approvalExpired === true ||
      (state.approvals ?? []).some((a) => a.expired);
    elements.push(
      markdownDiv(
        expiredApproval
          ? '⏰ **审批超时未响应，已自动取消**'
          : state.interruptedReason === 'approval_cancelled'
            ? '⏹ **已取消审批，任务终止**'
            : '⏹ **已被用户终止**',
      ),
    );
  } else if (state.terminal === 'idle_timeout') {
    elements.push(
      markdownDiv(`⏱ **已超时**\n\n${state.idleTimeoutMinutes ?? 0} 分钟无响应，已自动终止`),
    );
  } else {
    const result = state.resultSubtype ?? 'success';

    const hasContent = state.blocks.length > 0;
    const empty = !hasContent ? '\n\n（未返回内容）' : '';

    const usageStatsStr = formatUsageStats(
      {
        contextLength: state.contextLength,
        contextLimit: state.contextLimit,
        compactCount: state.compactCount,
        compactPreContextLength: state.compactPreContextLength,
        cacheReadTokens: state.cacheReadTokens,
        cacheCreationTokens: state.cacheCreationTokens,
        totalTokens: state.totalTokens,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        cumulativeTotalTokens: state.cumulativeTotalTokens,
        cumulativeInputTokens: state.cumulativeInputTokens,
        cumulativeOutputTokens: state.cumulativeOutputTokens,
        cumulativeCacheReadTokens: state.cumulativeCacheReadTokens,
        cumulativeCacheCreationTokens: state.cumulativeCacheCreationTokens,
      },
      { showResult: true, result },
    );

    elements.push(markdownDiv(usageStatsStr + empty));
  }

  return elements;
}

/** Build duration info string */
function buildDurationInfo(state: RunState): string {
  if (
    state.terminal === 'done' ||
    state.terminal === 'error' ||
    state.terminal === 'interrupted' ||
    state.terminal === 'idle_timeout'
  ) {
    return `⏱ ${state.footer || '已完成'}`;
  }
  // 与标题一致：审批等待期间状态行显示「等待审批中」，而不是「工具调用中」。
  if (hasPendingApproval(state)) return '✋ 等待审批中';
  return footerText2(state.footer);
}

function footerText2(footer: RunFooter | undefined): string {
  if (footer === 'tool_running') return '🧰 工具调用中';
  if (footer === 'streaming') return '✍️ 输出中';
  return '🧠 思考中';
}

/** Status tag label */
function statusTagLabel(terminal: RunState['terminal']): string {
  return terminalToLabel(terminal);
}

/** CardKit 2.0 header title — agent-aware via options.agentKind. */
function headerTitle2(state: RunState, options: RunCardRenderOptions = {}): string {
  const agent = agentDisplayName(options.agentKind ?? 'claude');
  if (state.terminal === 'done') return `✅ ${agent} · 已完成`;
  if (state.terminal === 'error') return `⚠️ ${agent} · 出错`;
  if (state.terminal === 'interrupted') return `⏹ ${agent} · 已中断`;
  if (state.terminal === 'idle_timeout') return `⏱ ${agent} · 已超时`;
  if (state.terminal === 'finalizing') return `⏳ ${agent} · 完成中`;
  // 审批等待期间 server 暂停 turn，命令工具停在 tool_running——标题必须提示
  // 正在等人工决策，而不是「调用工具」（2026-08-14 UX）。
  if (hasPendingApproval(state)) return `✋ ${agent} · 等待审批`;
  if (state.footer === 'thinking') return `💭 ${agent} · 思考中`;
  if (state.footer === 'streaming') return `💬 ${agent} · 输出中`;
  if (state.footer === 'tool_running') return `🔧 ${agent} · 调用工具`;
  return `🔴 ${agent} · 运行中`;
}

/** 是否有未过期（仍可操作）的待审批请求。 */
function hasPendingApproval(state: RunState): boolean {
  return (state.approvals ?? []).some((a) => !a.expired);
}

/** CardKit 2.0 header template color */
function headerTemplate2(state: RunState): string {
  return terminalToColor(state.terminal);
}
