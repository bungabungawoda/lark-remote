/**
 * UTF-8 byte-safe text truncation primitives.
 *
 * Shared by the live run renderer (`run-renderer.ts`), the static card budget
 * enforcer (`card-budget.ts`), and the opencode session reader
 * (`src/session/opencode/sessions.ts`) so that huge tool outputs are folded at a single
 * place instead of being reimplemented per consumer.
 *
 * Why byte-safe: Feishu card size limits are measured in UTF-8 bytes, and a
 * naive `str.slice(0, n)` can split a multi-byte CJK/emoji codepoint, yielding
 * invalid UTF-8. `fitUtf8` iterates by Unicode codepoint (via `Array.from` /
 * `for...of`) so it never breaks a surrogate pair or a multi-byte sequence.
 */

/** Feishu 11310 limit: max markdown tables per card. */
export const FEISHU_MAX_TABLES = 5;

/** Default truncation suffix, shared across all consumers for UX consistency. */
export const DEFAULT_TRUNCATE_SUFFIX = '…（已截断）';

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
 * Fit a UTF-8 string into `maxBytes` by iterating Unicode codepoints, never
 * splitting a multi-byte sequence. When `fromEnd` is true, keeps the TAIL
 * (useful for logs/tails); otherwise keeps the HEAD.
 *
 * P1-2 (2026-08-02): 单遍累计单字符字节数，替代逐字符 `Buffer.byteLength(result +
 * char)` + `result += char`（后者每轮新建并扫描不断增长的字符串，O(budget²)）。
 * 字节长度对拼接可加（byteLength(a+b) = byteLength(a) + byteLength(b)），故累计
 * 与旧实现的逐字符判断逐字节等价；最后一次 slice/join 物化结果。混合 CJK/emoji
 * 样本实测 ~150× 提速（33.7ms/次 → 0.2ms/次，见 tests/anchor/priority/p0-fit-utf8.test.ts）。
 */
function fitUtf8(value: string, maxBytes: number, fromEnd = false): string {
  if (fromEnd) {
    // tail 分支：需要从末尾找截断起点，Array.from 一次物化（旧实现同样 Array.from().reverse()，
    // 无内存回归）；数组仅用于定位，之后 slice+join。
    const codepoints = Array.from(value);
    let bytes = 0;
    let start = codepoints.length;
    for (let i = codepoints.length - 1; i >= 0; i--) {
      const cb = Buffer.byteLength(codepoints[i], 'utf8');
      if (bytes + cb > maxBytes) break;
      bytes += cb;
      start = i;
    }
    return codepoints.slice(start).join('');
  }
  // head 分支：惰性 for-of 迭代 + 字符串索引累计（旧实现同 O(1) 内存）。
  // 不物化数组——opencode-sessions 会对 MB 级 tool_result 做 head 截断，
  // Array.from 全量分配会引入不必要的瞬态内存。
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const cb = Buffer.byteLength(char, 'utf8');
    if (bytes + cb > maxBytes) break;
    bytes += cb;
    end += char.length; // for-of 产出完整码点；char.length 为 1 或 2（代理对），
    // end 落在码点边界上，value.slice(0, end) 不会切分代理对
  }
  return value.slice(0, end);
}

/**
 * Truncate a UTF-8 string to fit within `maxBytes`, appending `suffix`
 * (default `…（已截断）`) when truncation occurs. When `fromEnd` is true, keeps
 * the tail and prepends the suffix (useful for "show the most recent N bytes").
 */
export function truncateUtf8(
  value: string,
  maxBytes: number,
  fromEnd = false,
  suffix: string = DEFAULT_TRUNCATE_SUFFIX,
): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = maxBytes - suffixBytes;
  if (budget <= 0) return suffix;
  const truncated = fitUtf8(value, budget, fromEnd);
  return fromEnd ? `${suffix}\n${truncated}` : `${truncated}${suffix}`;
}

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
