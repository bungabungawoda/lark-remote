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
