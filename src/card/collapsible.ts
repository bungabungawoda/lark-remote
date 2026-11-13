/**
 * Shared helpers for building CardKit collapsible_panel elements.
 *
 * Docs: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components/containers/collapsible-panel
 *
 * Requires Feishu client V7.9+. Lower versions show a placeholder.
 * Used by all card types (run, bash, /resume, /ws, /active, etc.).
 */

export type PanelBorder = 'grey' | 'red' | 'blue' | 'green' | 'orange';

interface CollapsiblePanelOpts {
  /** Markdown title shown in the panel header. */
  title: string;
  /** Whether the panel is expanded by default. */
  expanded: boolean;
  /** Border color. Defaults to 'grey'. */
  border?: PanelBorder;
  /** Inner elements (markdown divs, etc.). */
  elements: object[];
}

/**
 * Build a `collapsible_panel` element.
 *
 * The panel's `elements` are always present in the JSON payload (folding is
 * purely visual), so they still count toward the card byte budget. Folding
 * reduces visual height, not serialized size.
 */
function collapsiblePanel(opts: CollapsiblePanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border ?? 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: opts.elements,
  };
}

/**
 * Standard panel header with a down-arrow icon that rotates on expand.
 * Used by all collapsible panels for visual consistency.
 */
function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: {
      tag: 'standard_icon',
      token: 'down-small-ccm_outlined',
      size: '16px 16px',
    },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

/**
 * Convenience: build a collapsible panel whose body is a single markdown div.
 * Common case for thinking blocks and tool details.
 */
export function collapsibleMarkdownPanel(opts: {
  title: string;
  expanded: boolean;
  border?: PanelBorder;
  content: string;
  textSize?: string;
}): object {
  return collapsiblePanel({
    title: opts.title,
    expanded: opts.expanded,
    border: opts.border,
    elements: [markdownDiv(opts.content, opts.textSize)],
  });
}

/**
 * Markdown div. `textSize` is optional ('notation' for small text).
 * Content backslashes are escaped via escapeMarkdown to avoid unintended
 * markdown escape sequences (see escapeMarkdown for the []| decision).
 */
export function markdownDiv(content: string, textSize?: string): object {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: escapeMarkdown(content),
      ...(textSize ? { text_size: textSize } : {}),
    },
  };
}

/**
 * Escape backslash to prevent unintended markdown escape sequences.
 *
 * Backslash is markdown's escape character. Unpaired backslashes in content
 * (e.g. Windows path `C:\Users`, regex `\d`) may cause the following character
 * to be interpreted as a literal. Escape it to preserve the raw backslash.
 *
 * Note: Square brackets [] and pipe | are NOT escaped -- they are valid markdown
 * (links, tables) and escaping them breaks link rendering. Verified by the live
 * regression test tests/feishu-live/escape-bracket-regression.test.ts: unescaped
 * []| does not trigger 11311.
 */
function escapeMarkdown(content: string): string {
  if (!content) return content;
  return content.replace(/\\/g, '\\\\');
}

/**
 * Inverse of escapeMarkdown (collapses `\\` back to `\`).
 *
 * 生产代码不使用（转义发生在发送前，飞书侧负责还原）；供测试侧从渲染后的
 * 卡片 JSON 取回原始文本——Windows 路径含 `\`，markdownDiv 会将其翻倍，
 * 断言原样路径时必须先经此还原（ci-windows 曾因此两处 anchor 假红）。
 * 只对 `lark_md` 文本调用：plain_text（如 header 标题）未经转义，还原会
 * 破坏合法的 `\\` 字面量。
 */
export function unescapeMarkdown(content: string): string {
  if (!content) return content;
  return content.replace(/\\\\/g, '\\');
}
