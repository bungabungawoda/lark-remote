/**
 * UTF-8 byte-safe text truncation primitives.
 *
 * The core `fitUtf8` / `truncateUtf8` / `DEFAULT_TRUNCATE_SUFFIX` primitives
 * live in `src/common/truncate.ts` (shared with session readers to avoid a
 * card→session layer inversion); this module re-exports them and adds the
 * card-specific markdown-table helpers.
 *
 * Why byte-safe: Feishu card size limits are measured in UTF-8 bytes, and a
 * naive `str.slice(0, n)` can split a multi-byte CJK/emoji codepoint, yielding
 * invalid UTF-8. `fitUtf8` iterates by Unicode codepoint (via `Array.from` /
 * `for...of`) so it never breaks a surrogate pair or a multi-byte sequence.
 */

import { DEFAULT_TRUNCATE_SUFFIX, truncateUtf8 } from '../common/truncate.js';

export { DEFAULT_TRUNCATE_SUFFIX, truncateUtf8 };

/** Feishu 11310 limit: max markdown tables per card. */
export const FEISHU_MAX_TABLES = 5;

/**
 * Feishu 单卡字节上限（安全阈值）。
 *
 * 供 run-renderer（流式卡）、card-budget（静态卡）、bash-renderer（bash 卡）
 * 共用，避免三处各自定义后数值漂移。
 */
export const CARD_BUDGET_BYTES = 28_000;

/** markdown table 分隔行判据：以 `|` 开头，只含 `| - : 空格`。 */
const TABLE_SEPARATOR_RE = /^\|[-: |]+$/;

/**
 * Count the number of markdown tables in a string.
 *
 * A markdown table is identified by a separator line matching `/^\|[-: |]+\$/m`
 * (i.e. a line that starts with `|` and contains only `|`, `-`, `:`, spaces).
 * Each separator line corresponds to exactly one table.
 */
export function countMarkdownTables(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (TABLE_SEPARATOR_RE.test(line.trim())) {
      count++;
    }
  }
  return count;
}

/** A removable table: header row + separator row + data rows. */
interface TableBlock {
  /** 块起始行下标（含向上并入的前置空行 / `###` 标题行） */
  start: number;
  /** 块结束后第一行下标（不含） */
  end: number;
}

/**
 * 按文档顺序定位字符串里的 markdown table 块。
 *
 * `truncateMarkdownTables`（单串）与 `enforceCardBudget`（整卡预算）共用这一份
 * 识别口径——两处各写一遍分隔行正数是下一个 bug 的温床。
 */
function findMarkdownTableBlocks(text: string): TableBlock[] {
  const lines = text.split('\n');
  const blocks: TableBlock[] = [];

  for (let sepIdx = 0; sepIdx < lines.length; sepIdx++) {
    if (!TABLE_SEPARATOR_RE.test(lines[sepIdx].trim())) continue;

    // Header is the line just before the separator
    let start = sepIdx - 1;
    if (start < 0) continue; // malformed table, skip

    // Expand start upward to include preceding heading (### ...) and blank lines
    // that belong to this table block. Stop at the first non-blank, non-heading line
    // or at the start of the text.
    while (start > 0) {
      const prevLine = lines[start - 1].trim();
      if (prevLine === '' || /^#{1,6}\s/.test(prevLine)) {
        start--;
      } else {
        break;
      }
    }

    // Data rows: lines after separator that start with '|'
    let end = sepIdx + 1;
    while (end < lines.length && /^\|/.test(lines[end].trim())) {
      end++;
    }

    blocks.push({ start, end });
  }

  return blocks;
}

/**
 * 删掉 `text` 中文档顺序**最旧**的至多 `maxDrop` 个 table 块（保留其余，含最新
 * 的那些），并在最后一个删除点插入省略提示。`maxDrop <= 0` 时原样返回。
 *
 * 与 `truncateMarkdownTables` 同一口径：删最旧、留最新。
 */
export function dropOldestMarkdownTables(text: string, maxDrop: number): string {
  if (maxDrop <= 0) return text;

  const lines = text.split('\n');
  const blocksToRemove = findMarkdownTableBlocks(text).slice(0, maxDrop);
  if (blocksToRemove.length === 0) return text;

  const blockByStart = new Map<number, TableBlock>();
  for (const b of blocksToRemove) blockByStart.set(b.start, b);
  const toRemove = blocksToRemove.length;

  const result: string[] = [];
  let i = 0;
  let dropped = 0;
  while (i < lines.length) {
    const block = blockByStart.get(i);
    if (block) {
      dropped++;
      i = block.end;
      if (dropped === toRemove) {
        result.push(`_💡 前 ${dropped} 个表格已省略_`);
      }
      continue;
    }
    result.push(lines[i]);
    i++;
  }

  return result.join('\n');
}

/**
 * Truncate markdown tables in a string to at most `maxTables`, keeping the
 * **newest** (last) tables and removing the oldest ones.
 *
 * 注意：`maxTables` 是**这一个字符串**的上限。飞书 11310 数的是**整卡**，
 * 表分散在多个字段时必须走 `card-budget.ts` 的整卡预算，不能逐字段调用本函数。
 */
export function truncateMarkdownTables(
  text: string,
  maxTables: number = FEISHU_MAX_TABLES,
): string {
  if (maxTables <= 0) return text;
  const dropCount = findMarkdownTableBlocks(text).length - maxTables;
  if (dropCount <= 0) return text;
  return dropOldestMarkdownTables(text, dropCount);
}
