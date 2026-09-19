/**
 * Shared CardKit helpers for router cards (session history, dashboard,
 * ls, ws, etc.).
 *
 * Re-exports `markdownDiv` from `card/collapsible.ts` and adds session-content
 * specific builders (e.g. `sessionEventPanel`) so `router/index.ts` can fold
 * long session histories into collapsible panels without duplicating logic.
 */

import { agentDisplayName } from '../card/card-shared.js';
import { collapsibleMarkdownPanel, markdownDiv } from '../card/collapsible.js';
import { formatTimestamp } from '../card/time.js';
import type { AgentSessionContentEvent } from '../runner/index.js';
import { formatUsageStats } from './utils.js';

type SessionUsageLike = Parameters<typeof formatUsageStats>[0];

/**
 * Build a collapsible panel for a single session content event.
 *
 * Header carries a type emoji (👤 user / 🤖 assistant·text / 💭 thinking /
 * 🔧 tool_use / 🟢🔴 tool_result) with optional timestamp.
 * Body: the event's content (markdown).
 *
 * The last `tailExpandedCount` events are expanded by default so the user
 * sees the most recent context without clicking; older events are collapsed.
 *
 * @param ev - Session content event
 * @param index - Index in the events array
 * @param totalEvents - Total number of events
 * @param tailExpandedCount - How many events from the end to keep expanded (default 2)
 * @param agentKind - Agent type for display name (e.g. 'claude', 'pi'). Defaults to 'claude'.
 */
export function sessionEventPanel(
  ev: AgentSessionContentEvent,
  index: number,
  totalEvents: number,
  tailExpandedCount = 2,
  agentKind: string = 'claude',
): object {
  const label = eventLabel(ev, agentKind);
  const ts = formatTimestamp(ev.timestamp);
  const title = ts ? `${label} (${ts})` : label;
  const expanded = index >= totalEvents - tailExpandedCount;
  return collapsibleMarkdownPanel({
    title,
    expanded,
    border: 'grey',
    content: ev.content,
    textSize: 'notation',
  });
}

/**
 * 事件类型 → 面板标题标签。五种 reader 产出的事件类型是
 * text/thinking/tool_use/tool_result（claude 另有 role-only 的 user/assistant），
 * 裸英文 type 名对用户不可读，统一映射为 emoji 标签。
 * tool_result 的成功/失败跟随正文前缀（content-blocks 打头 🟢/🔴），默认 🟢。
 */
function eventLabel(ev: AgentSessionContentEvent, agentKind: string): string {
  switch (ev.type) {
    case 'user':
      return '👤 你';
    case 'assistant':
    case 'text':
      return `🤖 ${agentDisplayName(agentKind)}`;
    case 'thinking':
      return '💭 思考';
    case 'tool_use':
      return '🔧 工具调用';
    case 'tool_result':
      return ev.content.startsWith('🔴') ? '🔴 工具结果' : '🟢 工具结果';
    default:
      return ev.type;
  }
}

export { markdownDiv };

/** 分页卡「跳转页码」输入框的组件 name（仅用于结构断言与可读性）。 */
export const PAGE_JUMP_INPUT_NAME = 'pageInput';

/** 页码输入非法时的统一提示文案（/ls /ws /resume /active /order 共用）。 */
export const PAGE_JUMP_INVALID_HINT = '请输入有效的页码（正整数）';

/**
 * 解析分页卡「跳转页码」输入框的提交值。
 *
 * 三态返回：
 * - `undefined` — 未输入（空串/非字符串），调用方应回退到 `offset`（上一页/下一页）
 * - `null`      — 输入非法（非正整数），调用方应回错误 toast 且不刷新卡片
 * - `number`    — 页码换算出的 offset（页码从 1 开始）
 */
export function parseJumpOffset(inputValue: unknown, pageSize: number): number | null | undefined {
  if (typeof inputValue !== 'string' || inputValue.trim() === '') return undefined;
  const raw = inputValue.trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  const page = Number(raw);
  if (!Number.isFinite(page) || page < 1) return null;
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.trunc(pageSize) : 1;
  return (page - 1) * size;
}

/**
 * Build the CardKit 2.0 pagination block shared by /ls, /ws, /resume, /active,
 * /order.
 *
 * 第一性原理（2026-09-10 窄屏重设计）：分页栏要同时承载「页码信息」和「翻页
 * 控件」两类需求。旧布局把两者塞进同一行 `column_set`（文案 weighted 4 : 输入
 * weighted 2），手机窄屏下 auto 按钮先占走固有宽度，剩余宽度按 4:2 切分后文案
 * 列只有百来像素、输入框只有几十像素——文案折行、输入框窄到没法点。
 * 拆成两行后每一类都有足够的横向空间：
 *
 *   1. 页码文案独占整行（顶层 `div`），窄屏不折行；
 *   2. 控件行 `column_set` = [上一页 auto] [跳转页码 input weighted] [下一页 auto]，
 *      input 吃掉 auto 按钮之外的剩余宽度（窄屏约百来像素，桌面端更宽）。
 *
 * Returns an array of body elements: `[page-label div, controls column_set]`；
 * 调用方展开进 `body.elements`（+ 自己的 `hr`）。input 仍留在控件 column_set
 * 内部，不用 form 容器（form 触发 300123 / 200621 整卡不可用）。CardKit 2.0
 * input 自带 ✓ 提交图标，提交值经 raw `action.input_value` 回传，见 connector
 * includeRawEvent + router/card-action-payload.ts。
 *
 * 每个调用方自带 callback cmd / extra value / 文案（语义差异保留，不强行统一）。
 *
 * @param opts.cmd       The pagination callback command (e.g. 'ls.page').
 * @param opts.offset    Current page offset.
 * @param opts.pageSize  Items per page.
 * @param opts.total     Total item count.
 * @param opts.extra     Extra callback value fields (e.g. path, agent, pageSize).
 * @param opts.label     Page-label markdown text (e.g. `**第 1/3 页**（共 30 项）`).
 * @param opts.prevText / opts.nextText  Button labels (default '⬅ 上一页' / '下一页 ➡').
 */
export function paginationBar(opts: {
  cmd: string;
  offset: number;
  pageSize: number;
  total: number;
  extra?: Record<string, unknown>;
  label: string;
  prevText?: string;
  nextText?: string;
}): object[] {
  const hasPrev = opts.offset > 0;
  const hasNext = opts.offset + opts.pageSize < opts.total;
  const prevText = opts.prevText ?? '⬅ 上一页';
  const nextText = opts.nextText ?? '下一页 ➡';

  const controls: object[] = [];
  if (hasPrev) {
    controls.push({
      tag: 'column',
      width: 'auto',
      vertical_align: 'center',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: prevText },
          type: 'default',
          size: 'small',
          behaviors: [
            {
              type: 'callback',
              value: { cmd: opts.cmd, offset: opts.offset - opts.pageSize, ...opts.extra },
            },
          ],
        },
      ],
    });
  }
  // 跳转页码输入：占满 auto 按钮之外的剩余宽度（窄屏可点、桌面不局促）。
  // 提交后值经 raw.action.input_value 回传，见 connector includeRawEvent +
  // router/card-action-payload.ts。
  controls.push({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    vertical_align: 'center',
    elements: [
      {
        tag: 'input',
        name: PAGE_JUMP_INPUT_NAME,
        placeholder: { tag: 'plain_text', content: '跳转页码' },
        behaviors: [
          {
            type: 'callback',
            value: { cmd: opts.cmd, pageSize: opts.pageSize, ...opts.extra },
          },
        ],
      },
    ],
  });
  if (hasNext) {
    controls.push({
      tag: 'column',
      width: 'auto',
      vertical_align: 'center',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: nextText },
          type: 'default',
          size: 'small',
          behaviors: [
            {
              type: 'callback',
              value: { cmd: opts.cmd, offset: opts.offset + opts.pageSize, ...opts.extra },
            },
          ],
        },
      ],
    });
  }
  return [
    { tag: 'div', text: { tag: 'lark_md', content: opts.label } },
    { tag: 'column_set', columns: controls },
  ];
}

/**
 * 搜索输入框的组件 name（仅用于结构断言与可读性）。input 在非 form 容器下
 * 提交值经 raw.action.input_value 回传，formValue 路径作为回退通道。
 */
export const SEARCH_INPUT_NAME = 'searchInput';

/**
 * Build the CardKit 2.0 keyword-search row shared by /ws and /ls list cards.
 *
 * 飞书 input 组件没有逐键回调——只有用户点击输入框右侧的 ✓ 提交图标时才触发
 * 一次 callback，所以交互只能是「输完点 ✓」确认制，placeholder 必须写明。
 *
 * 与 `paginationBar` 的控件行同一套窄屏安全模式：input 独占整行
 * （`width: 'weighted', weight: 1`），不与任何按钮同行，避免手机上被按钮
 * 挤到没法点。禁用 form 容器（300123 / 200621）与 `tag: "action"`（200861）。
 *
 * 返回**单个** `column_set` 元素（`paginationBar` 返回两个，调用处写法不同：
 * `elements.push(searchBar({...}))` vs `elements.push(...paginationBar({...}))`）。
 *
 * @param opts.cmd         提交回调的 cmd（'ws.filter' / 'ls.filter'）。
 * @param opts.placeholder 输入框占位文案（必须含「输完点 ✓」）。
 * @param opts.currentQuery 当前筛选词，非空时写进 default_value 回显。
 * @param opts.extra       透传进 callback value 的附加字段（/ls 用 path/root）。
 */
export function searchBar(opts: {
  cmd: string;
  placeholder: string;
  currentQuery?: string;
  extra?: Record<string, unknown>;
}): object {
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [
          {
            tag: 'input',
            name: SEARCH_INPUT_NAME,
            placeholder: { tag: 'plain_text', content: opts.placeholder },
            ...(opts.currentQuery ? { default_value: opts.currentQuery } : {}),
            max_length: 100,
            behaviors: [
              {
                type: 'callback',
                value: { cmd: opts.cmd, ...opts.extra },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Build a session-history resume card (shared by auto-restore, /resume <id>,
 * config-switch resume, and run-completion notification).
 *
 * Encapsulates the common structure: header (cwd + sessionId + displayTitle/
 * recap sections) → optional hidden-count indicator → folded event panels (or
 * empty placeholder) → usage → trailing-hr removal → action column_set → card
 * shell. Callers pass their specific header text, card title, usage result
 * label, placeholders, and already-built action buttons via opts.
 */
export function buildSessionHistoryCard(
  state: {
    sessionId: string;
    cwd: string;
    displayTitle?: string;
    aiTitle?: string;
    recap?: string;
    events: AgentSessionContentEvent[];
    usage?: SessionUsageLike;
  },
  opts: {
    agentKind: string;
    /** Header first line, e.g. `📂 \`${cwd}\`\n已恢复最近会话: **id**`. */
    headerText: string;
    /** Card header title content. */
    title: string;
    /** Optional result label passed to formatUsageStats (showResult:true). */
    usageResult?: string;
    /** Empty-events placeholder (some callers show a hint instead of nothing). */
    emptyPlaceholder?: string;
    /** Hidden earlier-events count (auto-restore only). */
    hiddenCount?: number;
    /** Action buttons to render (already built, protocol-specific). */
    actions?: object[];
    /** Optional card header template (e.g. 'green' for completion cards). */
    headerTemplate?: string;
  },
): object {
  const { displayTitle, aiTitle, recap, events, usage } = state;
  let header = opts.headerText;
  const sections: string[] = [];
  // Reader 层不再截断 displayTitle/summary；统一在消费侧这里截到 200 字符。
  if (displayTitle) {
    const label = aiTitle ? 'AI 标题' : '最近输入';
    const preview = displayTitle.length > 200 ? displayTitle.slice(0, 197) + '...' : displayTitle;
    sections.push(`🏷️ **${label}**\n${preview}`);
  }
  if (recap) {
    const recapPreview = recap.length > 200 ? recap.slice(0, 197) + '...' : recap;
    sections.push(`📝 **Recap**\n${recapPreview}`);
  }
  if (sections.length > 0) {
    header += '\n\n' + sections.join('\n\n──\n\n');
  }

  const elements: object[] = [markdownDiv(header), { tag: 'hr' }];

  if (opts.hiddenCount && opts.hiddenCount > 0) {
    elements.push(markdownDiv(`📜 还有 ${opts.hiddenCount} 个更早的事件未显示`));
  }

  if (events.length === 0 && opts.emptyPlaceholder) {
    elements.push(markdownDiv(opts.emptyPlaceholder));
  } else {
    events.forEach((ev, i) => {
      elements.push(sessionEventPanel(ev, i, events.length, 2, opts.agentKind));
    });
  }

  if (usage) {
    const usageStr = opts.usageResult
      ? formatUsageStats(usage, { showResult: true, result: opts.usageResult })
      : formatUsageStats(usage);
    elements.push(markdownDiv(usageStr));
  }

  // Remove trailing hr
  if (elements.length > 0 && (elements[elements.length - 1] as { tag: string }).tag === 'hr') {
    elements.pop();
  }

  if (opts.actions && opts.actions.length > 0) {
    elements.push({
      tag: 'column_set',
      columns: opts.actions.map((btn) => ({
        tag: 'column',
        width: 'auto',
        elements: [btn],
      })),
    });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      ...(opts.headerTemplate ? { template: opts.headerTemplate } : {}),
      title: {
        tag: 'plain_text',
        content: opts.title,
      },
    },
    body: { elements },
  };
}
