import type { RunBlock, RunNotice, RunState, ToolEntry } from './run-state.js';
import {
  terminalToColor,
  terminalToLabel,
  newSessionButton,
  stopButton,
  compactButton,
  cardButton,
  agentDisplayName,
} from './card-shared.js';
import { collapsibleMarkdownPanel, markdownDiv, type PanelBorder } from './collapsible.js';
import { toolBodyMd, toolHeaderText } from './tool-render.js';
import { truncateMarkdownTables, CARD_BUDGET_BYTES } from './text-truncate.js';
import { truncateUtf8 } from '../common/truncate.js';
import { countCardElements, MAX_CARD_ELEMENTS } from './card-budget.js';
import { displayWidth } from '../common/text-width.js';
import { isContentFilterFailure } from '../common/turn-failure.js';
import { formatClock, formatTimestamp } from './time.js';
import { formatUsageStats } from '../router/usage-format.js';
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
// 不依赖任何转义因子或拍脑袋常数（第二轮：CJK/ASCII 转义双向精确）。
const DEGRADED_THRESHOLD = 24_000; // 估算低于此值走正常路径（留 4KB 裕度，相对 CARD_BUDGET_BYTES=28000）；否则直接 degraded。调整时同步评估裕度是否仍覆盖估算偏差

/** 精确测量对象经 JSON.stringify 后的 UTF-8 字节数。 */
function measureJson(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

/** markdownDiv('', 'notation') 的序列化字节（空内容 div 的常量开销，估算时复用）。 */
const EMPTY_MD_DIV_BYTES = measureJson(markdownDiv('', 'notation'));

/**
 * Compact 按钮可见性：到达任意终态即可压缩。
 * 异常退出（error/interrupted/idle_timeout）时上下文往往更大，更需要压缩后
 * 再继续，因此不再要求 resultSubtype==='success'。compaction 卡
 * （operationKind='compaction'）永不显示，防止递归 Compact。
 *
 * 能力门控（compactSupported !== false）与执行侧 `'runCompact' in runner`
 * 鸭子探测对齐：claude 走 stream-json，不发射 turn_started，operationKind
 * 恒 undefined——若以 operationKind==='turn' 作门控，claude 终态卡永远拿
 * 不到按钮（2026-08-19 缺陷）。compaction 卡的「防递归」仍由 operationKind
 * 保证，两者是不同质的判断。
 */
function shouldShowCompactButton(state: RunState, options: RunCardRenderOptions): boolean {
  if (state.operationKind === 'compaction') return false;
  if (options.compactSupported === false) return false;
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
  /**
   * Agent kind for the run card header title (e.g. "Claude · 思考中").
   * Defaults to 'claude' when not provided; the bridge passes `config.defaultAgent`.
   */
  agentKind?: string;
  /**
   * Whether the terminal-state Compact button may be rendered. Defaults to true.
   * The bridge passes `runner 有 runCompact`（与 resume 卡 / auto-resume 卡的
   * hasRunCompact 探测一致），保证「有能力才渲染」：claude（stream-json，
   * 无 turn_started → operationKind undefined）同样能拿到按钮。
   */
  compactSupported?: boolean;
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

/** 内容时间线上的普通消息：内容组（原 blocks）或 notice 行。 */
type ContentItem = BlockGroup | { kind: 'notice'; notice: RunNotice };

/** 运行期通知作为普通消息渲染：与内容流同级的一行斜体提示。 */
function renderNoticeRow(notice: RunNotice): object {
  const icon = notice.level === 'info' ? 'ℹ️' : '⚠️';
  return markdownDiv(`_${icon} ${notice.text}_`);
}

/** 内容组用于时间线插值的锚点时刻（与面板标题展示的时间戳一致）。 */
function groupTimeMs(group: BlockGroup): number | undefined {
  if (group.kind === 'tool') {
    const ts = group.tool.completedAt ?? group.tool.startedAt;
    return ts ? Date.parse(ts) : undefined;
  }
  return group.timestamp ? Date.parse(group.timestamp) : undefined;
}

/**
 * 把 notices 作为普通消息并入内容时间线：按到达时间插到对应内容组之间。
 * 内容组自身的相对顺序不被改动（仍由 run-state 的块数组决定），时间戳只决定
 * notice 的落点；无时间戳的 notice 无法定位，兜底置于内容流末尾。
 */
function mergeNoticesIntoContent(
  groups: BlockGroup[],
  notices: RunNotice[] | undefined,
): ContentItem[] {
  if (!notices || notices.length === 0) return groups;
  const timed: RunNotice[] = [];
  const untimed: RunNotice[] = [];
  for (const notice of notices) {
    if (notice.timestamp) timed.push(notice);
    else untimed.push(notice);
  }
  const items: ContentItem[] = [];
  let cursor = 0;
  for (const notice of timed) {
    const t = Date.parse(notice.timestamp!);
    if (!Number.isNaN(t)) {
      while (
        cursor < groups.length &&
        groupTimeMs(groups[cursor]) !== undefined &&
        (groupTimeMs(groups[cursor]) as number) <= t
      ) {
        items.push(groups[cursor]);
        cursor++;
      }
    }
    items.push({ kind: 'notice', notice });
  }
  while (cursor < groups.length) {
    items.push(groups[cursor]);
    cursor++;
  }
  for (const notice of untimed) {
    items.push({ kind: 'notice', notice });
  }
  return items;
}

/** 每个块的截断后内容（thinking/plan/text），测量与渲染共用（建议项）。 */
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
 * 工具块 = **原生折叠面板**（与 thinking/plan 同一交互）。
 *
 * 早先试过"一行 + 服务端「详情」按钮"：折叠不省字节所以正文不入 payload，展开
 * 只能回服务端重出卡。代价是手机上要多点一次、按钮还占掉标题宽度（长 URL 被挤
 * 成两行，2026-10-19 反馈）。现在改成折叠面板 + **按工具数量缩放的正文截断**：
 * 正文始终随卡下发（面板折叠时不显示），点标题即展开，无往返、无按钮。
 *
 * 展开态：运行中/失败的默认展开（用户在等结果、错误要立刻可见），其余折叠。
 */
function renderTool(tool: ToolEntry, outputMax: number): object {
  const body = toolBodyMd(tool, { outputMax });
  return collapsibleMarkdownPanel({
    title: toolTitle(tool),
    expanded: tool.status === 'running' || tool.status === 'error',
    border: tool.status === 'error' ? 'red' : 'grey',
    content: body || '_无输出_',
    textSize: 'notation',
  });
}

/**
 * 每个工具的正文输出预算：工具越多，单个工具留的字符越少。
 *
 * 24 个工具（`MAX_BLOCKS`，也是上限）× 1200 字符的正文会把卡片顶到 28KB 以上
 * （实测 13 个 1200 字符的面板就开始走 skeleton 降级）。这里按总量反推：正文
 * 合计约 8KB，单个工具 160–1200 字符——够看清前几行输出，又不会让整卡超预算。
 */
function toolOutputBudget(state: RunState): number {
  let count = 0;
  for (const block of state.blocks) if (block.kind === 'tool') count += 1;
  return Math.max(160, Math.min(1200, Math.floor(8000 / Math.max(1, count))));
}

/**
 * 工具面板标题：`✅ **bash** — npm test (21:23)`。
 *
 * 标题连同时间戳一起收进 `HEADER_DISPLAY_MAX`（见 tool-render）——手机上折叠
 * 面板的标题只有一行可用，超了就会断在 URL/命令中间。时间戳用 `HH:mm` 而不是
 * 完整日期：同一张卡里的时间戳只需要区分先后。
 */
function toolTitle(tool: ToolEntry): string {
  const clock = formatClock(tool.completedAt ?? tool.startedAt);
  const title = toolHeaderText(tool, clock ? ` (${clock})` : '');
  return title;
}

/**
 * 内容组的元素成本（口径 = 递归 `elements` 数组成员，与飞书实测判据一致）。
 *
 * 工具是折叠面板：面板 1 + 内部 div 1 = 2 个元素，与展开态无关（折叠跟展开的
 * payload 一样，这正是"折叠不省字节"的含义——所以靠截断控制大小，而不是靠
 * 不发送正文）。
 */
const TOOL_PANEL_ELEMENTS = 2;
const PANEL_ELEMENTS = 2;
const TEXT_BLOCK_ELEMENTS = 1;
/**
 * 内容区（blocks）可用的元素预算 = 总预算 − 固定开销预留。
 *
 * 固定开销：状态行 1 + summary 1 + 操作行 4 + 省略提示/通知若干，实测约 10；
 * 预留 20 留出通知与提示的波动空间。
 */
const CONTENT_ELEMENT_BUDGET = MAX_CARD_ELEMENTS - 20;

/** 单个内容组的元素成本（保守：宁多不少）。 */
function groupElementCost(group: BlockGroup): number {
  if (group.kind === 'tool') return TOOL_PANEL_ELEMENTS;
  if (group.kind === 'text') return TEXT_BLOCK_ELEMENTS;
  return PANEL_ELEMENTS;
}

/**
 * 元素预算内从最新往回选择可见的内容组。
 *
 * 为什么在正常路径里先裁剪而不是整卡降级：降级档（degraded）只保留最后 3 个
 * 工具 + 2 个思考块，对一次跑了几十步的 run 是灾难性的信息损失；元素超限的
 * 成因只是"元素多"，砍掉最旧的几步就能同时保住元素预算和最新内容的完整渲染。
 * 被省略的数量由调用方渲染成 `_已省略 N 个早期步骤_`（与 omittedBlocks 同款提示）。
 */
function selectVisibleGroups(groups: BlockGroup[]): {
  visible: BlockGroup[];
  omitted: number;
} {
  if (groups.length === 0) return { visible: groups, omitted: 0 };
  let used = 0;
  let start = groups.length;
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groupElementCost(groups[i]);
    if (start < groups.length && used + cost > CONTENT_ELEMENT_BUDGET) break;
    used += cost;
    start = i;
  }
  return { visible: groups.slice(start), omitted: start };
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

/** Bottom action buttons: stop (if running) + compact (if applicable) + new session (always). */
function actionButtonList(state: RunState, options: RunCardRenderOptions): object[] {
  const actionButtons: object[] = [];
  // finalizing 也显示停止按钮（进程未退出，用户可 /stop）
  const showStop = state.terminal === 'running' || state.terminal === 'finalizing';
  if (showStop) {
    actionButtons.push(stopButton(state.runId));
  }
  // Compact 按钮：到达任意终态即可压缩（含异常退出），compaction 卡除外
  if (shouldShowCompactButton(state, options)) {
    actionButtons.push(compactButton(state.runId));
  }
  actionButtons.push(newSessionButton());
  return actionButtons;
}

/** Bottom action row: spacer + column_set of actionButtonList (估算与渲染共用）。 */
function actionRow(state: RunState, options: RunCardRenderOptions): object[] {
  const actionButtons = actionButtonList(state, options);
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

/** 审批区位于 body 最底部（底部操作行之后）：待审批时决策按钮不遮挡内容流。
 *  例外：skeleton 兜底路径中 approvalArea 在 actionRow 之前（信息保真），
 *  保证极端降级时审批入口与 stop/new-session 按钮同时可见。 */
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

/** 底部操作行之前的内容区提示：被 MAX_BLOCKS 截掉的早期块计数（信息保真）。 */
function omittedBlocksHint(state: RunState): object[] {
  return state.omittedBlocks !== undefined && state.omittedBlocks > 0
    ? [markdownDiv(`_💡 已省略 ${state.omittedBlocks} 个早期步骤_`)]
    : [];
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
      template: headerTemplate(state),
      title: { content: headerTitle(state, options), tag: 'plain_text' },
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
  const outputMax = toolOutputBudget(state);

  elements.push(statusRow(state));
  elements.push(...omittedBlocksHint(state));

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

  // use object references (like the extreme path) instead of timestamps.
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

  // 信息保真 plan/file_change 块在降级路径不渲染内容（正常路径已可见，
  // 降级预算紧张），但必须计数留痕，禁止静默丢弃。
  // 计数在渲染前完成，提示与 thinking/tool 省略提示一并置于卡片顶部——不能等
  // 内容循环结束再追加，否则提示会落在最后一条输出之后，打乱「输出收尾」观感。
  const groupsToRender = groupBlocks(filteredBlocks);
  const omittedPlanOrFileChange = groupsToRender.filter(
    (g) => g.kind === 'plan' || g.kind === 'file_change',
  ).length;
  if (omittedPlanOrFileChange > 0) {
    elements.push(markdownDiv(`_💡 另外 ${omittedPlanOrFileChange} 个计划/文件变更已省略_`));
  }

  // notices 作为普通消息按时间插入内容流（与正常路径同语义）；降级只裁剪
  // 内容块，不裁剪运行期通知。
  const contentItems = mergeNoticesIntoContent(groupsToRender, state.notices);
  // Render thinking/text/tool/notice in chronological order
  for (const item of contentItems) {
    if (item.kind === 'notice') {
      elements.push(renderNoticeRow(item.notice));
      continue;
    }
    const group = item;
    if (group.kind === 'thinking') {
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
      elements.push(renderTool(group.tool, outputMax));
    }
  }

  if (elements.length === 0 && tier === EXTREME_TIER) {
    elements.push(markdownDiv('_暂无输出_'));
  }

  elements.push(...buildSummaryContent(state, { includeNotices: false }));
  elements.push(...actionRow(state, options));
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

/**
 * 状态行内容：**一行、一个 div、窄屏不换行**。
 *
 * 设计约束（2026-10-19 手机端实测）：旧版把「状态标签」和「耗时/指标」放进
 * `column_set` 的 auto + grow 两列，窄屏上 auto 列被挤到只剩两个字宽，
 * "运行中" 被拆成 "运行 / 中"。列式布局的可用宽度取决于对端渲染，服务端无法
 * 保证；所以这里改成单 div，段间用 " · " 分隔——换行只会发生在分隔符处，
 * 而且整行控制在 ~26 个半角宽度内，320px 宽的手机也能放下。
 *
 * 状态标签（运行中/已完成…）不再重复：header 已经写了（`🔧 dsh · 调用工具`
 * / `✅ dsh · 已完成`），终态 summary 还有一次。
 *
 * 终态也保留状态行：耗时定格，DSH 的步数/上下文投影展示最后一次快照
 * （2026-10-21 用户要求）。summary 的最终 usage 与状态行并存。
 *
 * 导出供窄屏守卫测试断言分段宽度（与 `estimateCardBytes` 同一惯例）。
 */
export function statusLine(state: RunState): string {
  const parts: string[] = [];
  // 等待人工决策是「现在卡在哪儿」的唯一线索，值得在状态行重复一次 header
  // （窄屏上用户往往只扫这一行）。其余活动词（思考中/输出中）不重复，header 有。
  if (hasPendingApproval(state) && state.terminal === 'running') parts.push('✋ 等待审批');
  const elapsed = elapsedLabel(state);
  if (elapsed) parts.push(`⏱ ${elapsed}`);

  // 运行期投影在终态也保留（2026-10-21 用户要求）：DSH 卡片完成时，耗时/步数/
  // 上下文百分比是这一跑留下的最后快照，撤掉后用户只能从 summary 的累计口径
  // 重新推算。summary 仍展示最终 usage，两者口径不同、并存不冲突。
  const live = state.liveStatus;
  if (live) {
    if (live.steps !== undefined) parts.push(`🧰 ${live.steps} 步`);
    if (
      live.contextUsed !== undefined &&
      live.contextLimit !== undefined &&
      live.contextLimit > 0
    ) {
      // 官方口径：projectedTokens ?? pressureTokens，取整封顶 100；`~` 表示投影值。
      const pct = Math.min(100, Math.round((live.contextUsed / live.contextLimit) * 100));
      parts.push(`📊 ~${pct}%`);
    } else if (live.contextUsed !== undefined) {
      parts.push(`📊 ${formatTokens(live.contextUsed)}`);
    }
  }

  if (parts.length === 0) {
    // 没有任何可用指标时退回状态词（骨架卡/测试构造的状态没有时间戳）。
    return statusTagLabel(state.terminal);
  }
  return parts.join(' · ');
}

/** 耗时文案：`12s` / `2m13s` / `1h04m` / `2d3h`。空 = 无时间戳。 */
function elapsedLabel(state: RunState): string {
  if (state.startedAt === undefined) return '';
  const end = state.finishedAt ?? Date.now();
  const ms = end - state.startedAt;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m${String(totalSeconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
}

/** token 数量的紧凑写法：`950` / `12K` / `1.2M`。 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * 状态行元素（full/degraded/extreme/skeleton 共用）。
 *
 * 单 div + `notation` 字号：列式布局在窄屏会把短标签挤成竖排（手机端实测），
 * 单行文本的换行点只在 " · " 处，可预期。
 */
function statusRow(state: RunState): object {
  return markdownDiv(statusLine(state), 'notation');
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
function buildSkeletonElements(state: RunState, options: RunCardRenderOptions): object[] {
  const elements: object[] = [];

  elements.push(statusRow(state));
  elements.push(
    markdownDiv('_⚠️ 输出过大且含大量转义字符，已省略全部内容以避免超限；完整内容请查日志_'),
  );

  // Summary (token stats etc.) — static, bounded size
  elements.push(...buildSummaryContent(state));

  // 信息保真 skeleton 也渲染审批区——极端兜底不丢审批入口
  //（待审批被静默吞掉 = 用户永远看不到审批请求）。
  elements.push(...approvalArea(state));

  // Bottom action row: stop (if running/finalizing) + compact (if applicable) + new session (always).
  // Degraded paths must keep the action buttons reachable (design constraint).
  elements.push(...actionRow(state, options));

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
/**
 * 镜像对单源：thinking/plan/file_change 三个 collapsible 面板组的
 * { title, expanded, border, content } 描述，估算（measurePanelBytes）与渲染
 * （collapsibleMarkdownPanel）共用——此前同一套标题/opIcon/内容模板写两遍。
 * text（renderTextBlock）与 tool（renderTool）形态特殊，由调用方各自处理；
 * 返回 null 表示该组不是 collapsible 面板。
 */
function describePanelGroup(
  group: BlockGroup,
  prepared: GroupContentPrepared,
): { title: string; expanded: boolean; border: PanelBorder; content: string } | null {
  if (group.kind === 'tool') return null;
  const ts = formatTimestamp(group.timestamp);
  const suffix = ts ? ` (${ts})` : '';
  if (group.kind === 'thinking') {
    const title = (group.active ? '💭 **思考中**' : '💭 **思考完成**') + suffix;
    return { title, expanded: group.active, border: 'grey', content: prepared.get(group) ?? '' };
  }
  if (group.kind === 'plan') {
    const title = (group.active ? '📋 **执行计划**' : '📋 **计划完成**') + suffix;
    return { title, expanded: group.active, border: 'blue', content: prepared.get(group) ?? '' };
  }
  if (group.kind === 'file_change') {
    const opIcon =
      group.operation === 'create'
        ? '🆕'
        : group.operation === 'edit'
          ? '✏️'
          : group.operation === 'delete'
            ? '🗑️'
            : '📖';
    const title = `${opIcon} **文件改动**${suffix}`;
    const content = group.diff
      ? `**${group.path}**\n\n\`\`\`\n${group.diff}\n\`\`\``
      : `**${group.path}** (${group.operation})`;
    return { title, expanded: false, border: 'grey', content };
  }
  return null;
}

/** 导出供测试断言估算精度（估算 ≈ 实际渲染字节，见 tests/anchor/run-card/run-card.test.ts）。 */
export function estimateCardBytes(
  state: RunState,
  options: RunCardRenderOptions = {},
  shared?: { groups?: BlockGroup[]; prepared?: GroupContentPrepared },
): number {
  // renderRunCard 传入共享 groups/prepared 时直接复用（截断只做一次）；
  // 独立调用（测试/预算探针）时自建，行为与原先一致。
  const groups = shared?.groups ?? groupBlocks(state.blocks);
  const prepared = shared?.prepared ?? prepareGroupContent(groups);
  // 与 buildChronologicalContent 同源：估算必须测量"将要渲染的内容"，而正常
  // 路径会按节点预算省略最旧的组（不模拟这一步会系统性高估）。
  const { visible, omitted } = selectVisibleGroups(groups);
  const outputMax = toolOutputBudget(state);

  // 卡片外壳直接实测 assembleRunCard 空元素产物（schema/config/header/body 结构
  // 与正式渲染完全一致）；status/summary/操作行同样实测渲染结构。
  // 注：审批区（approvalArea）不参与估算——待审批通常在途且体积小，超预算由
  // renderRunCard 的 stringify 兜底捕获。
  let total =
    measureJson(assembleRunCard(state, options, [])) +
    measureJson(statusRow(state)) +
    measureJson(buildSummaryContent(state, { includeNotices: false })) +
    measureJson(actionRow(state, options));

  // 块内容：与 buildChronologicalContent 同源（describePanelGroup 单源）
  let renderedAny = false;
  if (omitted > 0) {
    renderedAny = true;
    total += measureJson(markdownDiv(`_💡 已省略 ${omitted} 个早期步骤_`));
  }
  for (const group of visible) {
    if (group.kind === 'tool') {
      renderedAny = true;
      // tool 直接实测真实渲染元素（复用 renderTool，output ≤1200 字符，物化廉价）
      total += measureJson(renderTool(group.tool, outputMax));
      continue;
    }
    if (group.kind === 'text') {
      const content = prepared.get(group) ?? '';
      if (!content.trim()) continue;
      renderedAny = true;
      const ts = formatTimestamp(group.timestamp);
      const header = `💬 **输出**${ts ? ` (${ts})` : ''}`;
      total += measurePanelBytes(header, true, 'grey', content);
      continue;
    }
    const spec = describePanelGroup(group, prepared);
    if (!spec) continue;
    renderedAny = true;
    total += measurePanelBytes(spec.title, spec.expanded, spec.border, spec.content);
  }

  // notices 在正常路径作为普通消息内联渲染（与 buildChronologicalContent 同源，
  // renderNoticeRow 单源）；行体积与位置无关，直接按条累加。
  for (const notice of state.notices ?? []) {
    renderedAny = true;
    total += measureJson(renderNoticeRow(notice));
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
  // degraded。groups/prepared 只算一次，测量与正式渲染共用同一份截断结果，
  // 避免影子测量 + 正式渲染对每个超限块双倍截断。
  const groups = groupBlocks(state.blocks);
  const prepared = prepareGroupContent(groups);
  const estimate = estimateCardBytes(state, options, { groups, prepared });

  // 构建完整卡（仅在估算低于阈值时，避免大 state 浪费 render + stringify）
  if (estimate < DEGRADED_THRESHOLD) {
    const elements: object[] = [
      statusRow(state),
      ...omittedBlocksHint(state),
      ...buildChronologicalContent(state, prepared, groups),
      ...buildSummaryContent(state, { includeNotices: false }),
      ...actionRow(state, options),
      ...approvalArea(state),
    ];

    const card = assembleRunCard(state, options, elements);

    // Check budget — stringify 兜底（估算可能低估，仍保留安全网）。
    // 两个维度都必须过：字节（28KB）与元素总数（飞书 11310，实测 203 节点上限）。
    if (withinRunCardBudget(card)) return card;
    // 超预算 → 继续走 degraded（不 return，fallthrough）
  }

  // 估算 ≥ 阈值 或 完整卡超预算 — 走 degraded 渲染
  const degradedCard = assembleRunCard(state, options, buildDegradedElements(state, options));
  if (withinRunCardBudget(degradedCard)) {
    return degradedCard;
  }

  // Extreme fallback: even degraded exceeds budget
  const extremeCard = assembleRunCard(state, options, buildExtremeFallbackElements(state, options));

  // Final safety net: extreme fallback 是最后一层，但高转义内容（反斜杠 4× 膨胀）
  // 可能让 extreme 产物本身 >28KB。补上 stringify 兜底（与 normal/degraded 对称）：
  // 超预算则降级到结构性保证 ≤28KB 的 skeleton 卡，避免飞书 11310 整卡不可用。
  if (withinRunCardBudget(extremeCard)) {
    return extremeCard;
  }

  const skeletonCard = assembleRunCard(state, options, buildSkeletonElements(state, options));
  // skeleton 卡是静态结构，理论上必 ≤28KB；保留兜底断言以防未来结构膨胀
  if (Buffer.byteLength(JSON.stringify(skeletonCard), 'utf8') <= CARD_BUDGET_BYTES) {
    return skeletonCard;
  }

  // 理论上不可达：skeleton 已是静态最小结构。若仍超限（errorMsg 等无界文本
  // 灌进 summary），硬截断只丢 summary——审批入口与 stop/新会话按钮是红线，
  // 任何一级兜底都不能把它们截掉（丢了用户就再也停不下这个 run）。
  const truncatedSkeleton = {
    ...skeletonCard,
    body: {
      elements: [
        statusRow(state),
        markdownDiv('_⚠️ 输出过大_'),
        ...approvalArea(state),
        ...actionRow(state, options),
      ],
    },
  };
  return truncatedSkeleton;
}

/**
 * Run 卡片的双预算检查：UTF-8 字节 ≤ 28KB **且** 元素数 ≤ `MAX_CARD_ELEMENTS`。
 *
 * 为什么两个维度都要查：字节超限来自内容长（截断即可），元素超限来自元素多
 * （必须删元素）。一张只有几十个短文本的卡片可以远低于 28KB 却把飞书的元素
 * 总数撑爆（实测 24 行工具 + 24 个展开正文 = 103 个元素 → 11310），只查字节
 * 的安全网抓不到它。
 */
function withinRunCardBudget(card: object): boolean {
  if (countCardElements(card) > MAX_CARD_ELEMENTS) return false;
  return Buffer.byteLength(JSON.stringify(card), 'utf8') <= CARD_BUDGET_BYTES;
}

/** Build content in chronological order using groupBlocks to interleave thinking/text/tools. */
function buildChronologicalContent(
  state: RunState,
  prepared: GroupContentPrepared,
  groups: BlockGroup[],
): object[] {
  const elements: object[] = [];
  // finalized = 非 running（含 finalizing：主结果已出，thinking 折叠）
  const finalized = state.terminal !== 'running';
  // 节点预算内从最新往回选择可见组：超限时只省略最旧的几步，不整卡降级。
  const { visible, omitted } = selectVisibleGroups(groups);
  const outputMax = toolOutputBudget(state);
  if (omitted > 0) elements.push(markdownDiv(`_💡 已省略 ${omitted} 个早期步骤_`));

  // renderRunCard 传入同一 groups 数组时直接复用（prepared 的键是组对象
  // 引用，重建数组会让 prepared.get 永远 miss，退化为二次截断）。
  // 面板组描述经 describePanelGroup 与估算共享同一份模板。
  // notices 作为普通消息按到达时间插入内容流（有内容时不再沉到 summary）。
  const contentItems = mergeNoticesIntoContent(visible, state.notices);
  for (const item of contentItems) {
    if (item.kind === 'notice') {
      elements.push(renderNoticeRow(item.notice));
      continue;
    }
    const group = item;
    if (group.kind === 'tool') {
      elements.push(renderTool(group.tool, outputMax));
      continue;
    }
    if (group.kind === 'text') {
      const content = prepared.get(group) ?? '';
      const ts = formatTimestamp(group.timestamp);
      elements.push(...renderTextBlock(content, ts, finalized));
      continue;
    }
    const spec = describePanelGroup(group, prepared);
    if (!spec) continue;
    elements.push(
      collapsibleMarkdownPanel({
        title: spec.title,
        expanded: spec.expanded,
        border: spec.border,
        content: spec.content,
        textSize: 'notation',
      }),
    );
  }

  if (elements.length === 0) {
    elements.push(markdownDiv('_暂无输出_'));
  }

  return elements;
}

/** Build summary tab content */
function buildSummaryContent(
  state: RunState,
  options: { includeNotices?: boolean } = {},
): object[] {
  const elements: object[] = [];

  // 运行期通知默认仍走 summary（skeleton 兜底：内容区整体缺失时唯一可见位置）。
  // 正常/degraded/extreme 路径传入 includeNotices:false——通知已作为普通消息
  // 按时间线内联渲染（renderNoticeRow），避免同一通知渲染两遍。
  if (options.includeNotices !== false) {
    for (const notice of state.notices ?? []) {
      elements.push(renderNoticeRow(notice));
    }
  }

  // running 时不显示统计（仍在生成）；finalizing 显示等待提示
  if (state.terminal === 'running') {
    return elements;
  }
  if (state.terminal === 'finalizing') {
    elements.push(markdownDiv('⏳ **等待进程退出…**'));
    return elements;
  }

  if (state.terminal === 'error') {
    // 服务方内容审核截断（多为误报）不是「程序出错」：照抄英文内部报文会让
    // 用户以为代码或配置坏了。文案说清三件事——谁拦的、改动还在、下一步。
    if (isContentFilterFailure(state.errorMsg)) {
      elements.push(
        markdownDiv(
          '⚠️ **服务方内容审核拦截**\n\n' +
            '模型输出被上游安全策略截断（`content_filter`），多数是误报，不是代码或配置问题。\n' +
            '本回合已中止；已写入磁盘的改动都还在。重试仍被拦截时，可换模型或稍后再试。',
        ),
      );
    } else {
      elements.push(markdownDiv(`⚠️ **运行出错**\n\n${state.errorMsg ?? '未知错误'}`));
    }
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
    // 压缩（operationKind='compaction'）不会返回 agent 正文——引擎只压缩上下文
    // 窗口，空内容属正常，不能沿用普通 run 的「（未返回内容）」异常信号
    // （2026-09 用户反馈）。所有会压缩的 agent（codex/claude/kimi/opencode/pi）
    // 都经 streamCompact 走这条共享渲染路径，一处覆盖全部。
    const empty = hasContent
      ? ''
      : state.operationKind === 'compaction'
        ? '\n\n🗜 Compact 完成'
        : '\n\n（未返回内容）';

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
        model: state.model,
        costUsd: state.costUsd,
        reasoningTokens: state.reasoningTokens,
      },
      { showResult: true, result },
    );

    elements.push(markdownDiv(usageStatsStr + empty));

    // 后台任务：跨 turn 生命周期，必须显式告知并可逐个停止。
    elements.push(...buildBackgroundJobsSection(state));
  }

  return elements;
}

/** 终态卡最多列几个后台任务（多出来的只报数）。 */
const MAX_BACKGROUND_JOB_LINES = 3;

/**
 * 命令在手机上可直接内联的显示宽度上限（半角单位，CJK/emoji 记 2）。
 *
 * 手机内容区约 320–360px，36 个半角单位约一行；再长会折成"每个词一行"。
 * 超过这个宽度改用代码块整段展示（完整、可读），而不是截断。
 */
const BACKGROUND_JOB_INLINE_MAX = 36;

/**
 * 代码块再长到这个程度才折叠：约 180 个半角宽度或 6 行。
 *
 * 低于阈值直接展示完整命令（用户一眼能看到，不用点）；只有确实很长的
 * 脚本/链式命令才收进折叠面板，避免一张卡被一条命令占满。
 */
const BACKGROUND_JOB_FOLD_DISPLAY_MAX = 180;
const BACKGROUND_JOB_FOLD_LINES = 6;

/**
 * 任务状态标签：目前 DSH 只会给 running/stopping，其他值按运行中处理。
 */
function backgroundJobStatusLabel(status: string | undefined): string {
  return status === 'stopping' ? '停止中' : '运行中';
}

/**
 * 生成能包住任意反引号串的代码围栏。命令里的 shell 反引号不能替换成 `'`
 * （那是改内容），只能选比内容里最长反引号串更长的围栏。
 */
function codeFenceFor(content: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of content) {
    if (ch === '`') {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * 后台任务小节：命令独占一行，停止按钮单独一行。
 *
 * 布局约束（2026-10-21 手机端反馈）：
 * - 命令 + 按钮不再并排（grow + auto）：窄屏下 auto 列会被挤成「🟥…」，
 *   命令也被截断。按钮现在独占一个单列 column_set，宽度由按钮自身决定。
 * - 命令不 truncate：短命令/单行直接内联；中等长度的多行命令用代码块
 *   整段展示；只有超长命令（> 180 显示宽度或 > 6 行）才进折叠面板。
 *   面板折叠只影响视觉，JSON 里始终带全文。
 * - 含反引号的命令不走行内代码（无法安全包含反引号），改走代码块；
 *   围栏长度按内容自动加长，命令原文不改写。
 *
 * 按钮 payload 只带 runId/jobId：sessionId 与 cwd 由 bridge 的快照解析，卡片
 * 上少放一个可变字段就少一处不一致。
 */
function buildBackgroundJobsSection(state: RunState): object[] {
  const jobs = state.backgroundJobs ?? [];
  if (jobs.length === 0) return [];
  const elements: object[] = [
    markdownDiv(`🧵 **后台任务** ${jobs.length} 个仍在运行`),
    markdownDiv('_本轮结束后继续，可逐个停止_', 'notation'),
  ];
  jobs.slice(0, MAX_BACKGROUND_JOB_LINES).forEach((job, index) => {
    const label = job.label.trim();
    const lineCount = label === '' ? 0 : label.split(/\r?\n/).length;
    const inline =
      label.length > 0 &&
      lineCount === 1 &&
      !label.includes('`') &&
      displayWidth(label) <= BACKGROUND_JOB_INLINE_MAX;
    if (inline) {
      elements.push(markdownDiv(`· \`${label}\``));
    } else {
      // 多行/超宽/含反引号：代码块保留完整命令；只有超长才折叠。
      const fence = codeFenceFor(label);
      const content = `${fence}\n${label}\n${fence}`;
      const fold =
        lineCount > BACKGROUND_JOB_FOLD_LINES ||
        displayWidth(label) > BACKGROUND_JOB_FOLD_DISPLAY_MAX;
      elements.push(
        fold
          ? collapsibleMarkdownPanel({
              title: `🧵 任务 ${index + 1} · ${backgroundJobStatusLabel(job.status)} · 点击展开完整命令`,
              expanded: false,
              border: 'grey',
              content,
              textSize: 'notation',
            })
          : markdownDiv(content),
      );
    }
    elements.push({
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            cardButton(
              '⏹ 停止',
              { cmd: 'job.kill', runId: state.runId, jobId: job.id },
              { size: 'small', type: 'danger' },
            ),
          ],
        },
      ],
    });
  });
  if (jobs.length > MAX_BACKGROUND_JOB_LINES) {
    elements.push(markdownDiv(`_…另有 ${jobs.length - MAX_BACKGROUND_JOB_LINES} 个任务_`));
  }
  return elements;
}

/** Status tag label */
function statusTagLabel(terminal: RunState['terminal']): string {
  return terminalToLabel(terminal);
}

/** CardKit 2.0 header title — agent-aware via options.agentKind. */
function headerTitle(state: RunState, options: RunCardRenderOptions = {}): string {
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
function headerTemplate(state: RunState): string {
  return terminalToColor(state.terminal);
}
