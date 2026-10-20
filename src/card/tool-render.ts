/**
 * Structured tool rendering for collapsible panels.
 *
 * Adapted to lark-remote's `ToolEntry` type (which uses `status: 'running' | 'ok' | 'error'`
 * and stores `input` as an already-stringified value in some paths).
 *
 * Why this exists: the old renderer dumped `JSON.stringify(input, null, 2)`
 * which is verbose and buries the useful signal (command, file path, pattern)
 * under formatting noise. `toolHeaderText` produces a compact one-liner header
 * like `✅ **Bash** — pwd` so collapsed panels stay informative.
 */

import type { ToolEntry } from './run-state.js';
import { truncate } from '../common/truncate.js';
import { asRecord, summarizeToolInput } from '../common/tool-summary.js';
import { truncateMiddleToDisplayWidth } from '../common/text-width.js';

// 这两个宽度工具原本住在这里；resume 卡片也要用，已下沉到 common。
export {
  displayWidth,
  truncateMiddleToDisplayWidth,
  truncateToDisplayWidth,
} from '../common/text-width.js';

const HEADER_SUMMARY_MAX = 80;
/**
 * 面板标题的显示宽度上限（半角单位，CJK/emoji 记 2）。
 *
 * 手机（~390px 内容宽）上折叠面板的标题只有**一行**可用：减去图标与内边距约
 * 320px，按 ~7.5px/半角算 ≈ 42 个半角宽度（iPhone SE 更窄，超出时按 `·`/空格
 * 折行仍可读，但不能整段换行）。超过就折行，断点常常落在 URL 或命令
 * 中间（2026-10-19 截图反馈）。完整参数在展开后的正文里，标题只负责"哪个工具、
 * 动了什么"，并带上 `HH:mm` 时间戳（一起计入预算）。
 */
export const HEADER_DISPLAY_MAX = 42;
const BODY_FIELD_MAX = 600;
const OUTPUT_MAX = 1200;
/**
 * Cumulative cap on a tool's full body markdown (input + output + code fences
 * + headers). Even with per-field caps, pathological tools (many input fields
 * + maxed-out output) can stack to multi-KB bodies which, multiplied across
 * panels, push the card past Feishu's per-element size limit. This is the last
 * belt across the whole rendered body string.
 */
const BODY_TOTAL_MAX = 2500;

/**
 * One-line header for a tool call:
 *   `⏳ **Bash** — pwd`
 *   `✅ **Read** — /repo/a.ts`
 *   `❌ **Grep** — pattern in path`
 */
export function toolHeaderText(tool: ToolEntry, suffix = ''): string {
  const icon = tool.status === 'ok' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
  // use the cached parsed record when available (avoids per-render parse).
  const input = tool.parsedInput !== undefined ? tool.parsedInput : tool.input;
  const summary = summarizeToolInput(tool.name, input);
  // 信息保真 ACP kind 映射后 name 与原始 title 不同时，title 以
  // ` — {summary}` 追加在标题末尾（截断沿用 HEADER_SUMMARY_MAX）。
  // 用 truncate（suffix 为空）而非裸 slice：裸 slice 按 UTF-16 码元切，
  // 切点落在 emoji 代理对中间会留下孤立代理项（同族）。
  const blockSummary = tool.summary
    ? truncate(tool.summary.replace(/\s+/g, ' ').trim(), HEADER_SUMMARY_MAX, { suffix: '' })
    : '';
  // opencode carries the same value in both slots (title = command/path, and
  // the args-derived summary resolves to it too); dedupe so the header reads
  // `✅ **Bash** — ls` instead of `✅ **Bash** — ls — ls`.
  const parts = [summary, blockSummary].filter(Boolean);
  const uniqueParts = parts.filter((part, i) => parts.indexOf(part) === i);
  const title =
    uniqueParts.length > 0
      ? `${icon} **${tool.name}** — ${uniqueParts.join(' — ')}`
      : `${icon} **${tool.name}**`;
  // 折叠面板的标题必须能在一行内放下（手机窄屏）：超宽就按显示宽度截断，
  // 完整值仍在展开后的正文里。`suffix`（时间戳）一起计入预算，否则"标题压到
  // 60 宽 + 18 宽时间戳"在手机上照样折行。
  // 中间省略：路径/URL 的结尾（文件名）比开头更有信息量。
  return truncateMiddleToDisplayWidth(`${title}${suffix}`, HEADER_DISPLAY_MAX);
}

/**
 * Structured body markdown for a tool call. Renders input fields by tool name
 * (Bash → command, Read/Edit/Write → file_path, etc.) and output in a code
 * block. An explicit `toolHint` (declared by the runner, 信息保真) selects
 * the same rendering by family instead of name. There is no raw-JSON fallback
 * for unknown tools: `default` returns '' and unknown tools only surface their
 * args through the panel header's `summarizeInput` fallback.
 */
export function toolBodyMd(tool: ToolEntry, opts: { outputMax?: number } = {}): string {
  const parts: string[] = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);

  if (tool.output) {
    const outputMax = Math.min(opts.outputMax ?? OUTPUT_MAX, OUTPUT_MAX);
    const truncated = truncate(tool.output, outputMax);
    if (tool.status === 'error') {
      parts.push(`**Error**\n\`\`\`\n${truncated}\n\`\`\``);
    } else {
      parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
    }
  } else if (tool.status === 'running') {
    parts.push('_运行中…_');
  }

  const body = parts.join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  // 同上：走 truncate 保证切点不落在代理对中间（末尾 '…' 由 truncate 附加以对齐预算）。
  return `${truncate(body, BODY_TOTAL_MAX)}\n\n_（body 已截断，完整内容查日志）_`;
}

// --- Named render bodies (shared by tool-name cases and toolHint branches) ---

function renderBashInput(str: (k: string) => string): string {
  const cmd = str('command');
  return cmd ? `**Command**\n\`\`\`bash\n${truncate(cmd, BODY_FIELD_MAX)}\n\`\`\`` : '';
}

function renderFileInput(str: (k: string) => string): string {
  const fp = str('file_path') || str('path');
  return fp ? `**File** \`${fp}\`` : '';
}

function renderGrepInput(str: (k: string) => string): string {
  const lines: string[] = [];
  if (str('pattern')) lines.push(`**Pattern** \`${str('pattern')}\``);
  if (str('path')) lines.push(`**Path** \`${str('path')}\``);
  return lines.join('\n');
}

function renderGlobInput(str: (k: string) => string): string {
  const p = str('pattern');
  return p ? `**Pattern** \`${truncate(p, BODY_FIELD_MAX)}\`` : '';
}

function renderLsInput(str: (k: string) => string): string {
  const p = str('path');
  return p ? `**Path** \`${p}\`` : '';
}

function renderWebFetchInput(str: (k: string) => string): string {
  return str('url') ? `**URL** ${str('url')}` : '';
}

function renderWebSearchInput(str: (k: string) => string): string {
  return str('query') ? `**Query** \`${truncate(str('query'), BODY_FIELD_MAX)}\`` : '';
}

/** DSH `web_search` 的批量查询参数（`queries: string[]`）。 */
function renderWebQueriesInput(queries: unknown): string {
  if (!Array.isArray(queries)) return '';
  const items = queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
  if (items.length === 0) return '';
  return `**Query** \`${truncate(items.join('` / `'), BODY_FIELD_MAX)}\``;
}

function renderInput(tool: ToolEntry): string {
  // use the cached parsed record when available (avoids per-render parse).
  const input = tool.parsedInput !== undefined ? tool.parsedInput : tool.input;
  const rec = asRecord(input);
  if (!rec) return '';
  const str = (k: string): string => (typeof rec[k] === 'string' ? (rec[k] as string) : '');

  // 信息保真 hint 优先（runner 自愿声明，只消费不推断）；缺失时与现状
  // 完全一致。hint 分支与 name case 共用同一渲染函数，无复制粘贴。
  switch (tool.toolHint) {
    case 'shell':
      return renderBashInput(str);
    case 'file':
    case 'patch':
      return renderFileInput(str);
    case 'search':
      return renderGrepInput(str);
    case 'web':
      return renderWebFetchInput(str) || renderWebSearchInput(str);
    default:
      break;
  }

  switch (tool.name) {
    case 'Bash':
    case 'bash':
    case 'pwsh':
      return renderBashInput(str);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'read':
    case 'edit':
    case 'write':
    case 'read_image':
      return renderFileInput(str);
    case 'Grep':
    case 'grep':
      return renderGrepInput(str);
    case 'Glob':
    case 'glob':
    case 'find':
      return renderGlobInput(str);
    case 'ls':
      return renderLsInput(str);
    case 'WebFetch':
    case 'web_fetch':
      return renderWebFetchInput(str);
    case 'WebSearch':
      return renderWebSearchInput(str);
    case 'web_search':
      return renderWebQueriesInput(rec.queries) || renderWebSearchInput(str);
    default:
      return '';
  }
}
