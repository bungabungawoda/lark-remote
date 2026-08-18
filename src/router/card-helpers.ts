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

/**
 * Build a CardKit 2.0 pagination bar (prev-button / page-label / next-button
 * columns). Shared by /ls, /ws, /resume, /active, /order.
 *
 * Returns the `column_set` element (plus caller appends an `hr`). Each caller
 * supplies its own callback cmd + extra value fields and label text (semantic
 * differences are preserved, not silently unified).
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
}): object {
  const hasPrev = opts.offset > 0;
  const hasNext = opts.offset + opts.pageSize < opts.total;
  const prevText = opts.prevText ?? '⬅ 上一页';
  const nextText = opts.nextText ?? '下一页 ➡';

  const pageColumns: object[] = [];
  if (hasPrev) {
    pageColumns.push({
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
  pageColumns.push({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    vertical_align: 'center',
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: opts.label } }],
  });
  if (hasNext) {
    pageColumns.push({
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
  return { tag: 'column_set', columns: pageColumns };
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
