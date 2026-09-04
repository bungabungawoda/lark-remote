/**
 * Session-list ordering invariant shared by every reader: newest first,
 * with a deterministic id tie-break so index rebuilds / walk-order changes
 * never reorder a page (codex red line: never break out of a partial order).
 */

/** 「时间降序 + id 字典序 tie-break」原地排序（原先 6 处内联拷贝）。 */
export function sortByRecencyDesc<T>(
  items: T[],
  time: (item: T) => number,
  id: (item: T) => string,
): void {
  items.sort((a, b) => time(b) - time(a) || id(a).localeCompare(id(b)));
}
