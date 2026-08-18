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

/**
 * Max byte budget for a single session `tool_result` event's content when
 * replaying an opencode session (L2 pre-fold). The static card budget enforcer
 * (`enforceCardBudget`, maxPanelContentBytes = 2000) would truncate it again at
 * render time anyway; pre-folding here bounds the in-memory `events[]` array
 * and the intermediate card JSON so a single pathological tool_result (e.g. a
 * 500KB file listing) never inflates the replay payload to megabytes.
 */
export const TOOL_RESULT_MAX_BYTES = 4000;

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
    if (/^\|[-: |]+$/.test(line.trim())) {
      count++;
    }
  }
  return count;
}

/**
 * Truncate markdown tables in a string to at most `maxTables`, keeping the
 * **newest** (last) tables and removing the oldest ones.
 *
 * Strategy: find all table separator lines, determine which tables to remove
 * (those whose separator is among the oldest `count - maxTables`), then remove
 * each such table entirely (header row + separator row + data rows).
 *
 * A "table block" is a contiguous run of lines where the first line is the
 * header row, the second is the separator row (`|---|`), and subsequent lines
 * are data rows. We remove entire table blocks from the text.
 *
 * When tables are removed, a hint is inserted at the removal point indicating
 * how many earlier tables were omitted.
 */
export function truncateMarkdownTables(
  text: string,
  maxTables: number = FEISHU_MAX_TABLES,
): string {
  if (maxTables <= 0) return text;

  const tableCount = countMarkdownTables(text);
  if (tableCount <= maxTables) return text;

  const lines = text.split('\n');

  // Step 1: Find all table separator line indices
  const separatorIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\|[-: |]+$/.test(lines[i].trim())) {
      separatorIndices.push(i);
    }
  }

  // Step 2: For each separator, identify the full table block
  // A table block = [headerLine, separatorLine, ...dataLines]
  // headerLine is separatorIndex - 1, dataLines continue while line starts with '|'
  interface TableBlock {
    start: number; // header line index
    end: number; // first line AFTER the table (exclusive)
    separatorIdx: number;
  }

  const blocks: TableBlock[] = [];
  for (const sepIdx of separatorIndices) {
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

    blocks.push({ start, end, separatorIdx: sepIdx });
  }

  // Step 3: Determine which blocks to remove (oldest first)
  const toRemoveCount = blocks.length - maxTables;
  // blocks are in document order (oldest first), so remove from the front
  const blocksToRemove = new Set(blocks.slice(0, toRemoveCount));
  // Map: start line index → block (for lookup when processing lines)
  const blockByStart = new Map<number, TableBlock>();
  for (const b of blocks) {
    blockByStart.set(b.start, b);
  }

  // Step 4: Rebuild the text, skipping removed table blocks and inserting hints
  const result: string[] = [];
  let i = 0;
  let removedSoFar = 0;

  while (i < lines.length) {
    const block = blockByStart.get(i);
    if (block && blocksToRemove.has(block)) {
      // Skip the entire table block
      removedSoFar++;
      i = block.end;
      // Insert hint at the removal point
      if (removedSoFar === toRemoveCount) {
        result.push(`_💡 前 ${toRemoveCount} 个表格已省略_`);
      }
      continue;
    }
    result.push(lines[i]);
    i++;
  }

  return result.join('\n');
}
