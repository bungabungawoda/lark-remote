/**
 * Session-list ordering invariant shared by every reader: newest first,
 * with a deterministic id tie-break so index rebuilds / walk-order changes
 * never reorder a page (codex red line: never break out of a partial order).
 */
import type { AgentSessionReader } from '../../session-contract.js';

/** 「时间降序 + id 字典序 tie-break」原地排序（原先 6 处内联拷贝）。 */
export function sortByRecencyDesc<T>(
  items: T[],
  time: (item: T) => number,
  id: (item: T) => string,
): void {
  items.sort((a, b) => time(b) - time(a) || id(a).localeCompare(id(b)));
}

/**
 * 列表首项 = 最新会话（`getNewestSession` 的唯一实现，此前 5 个 reader 逐字各抄一遍）。
 * 「newest first」是 `AgentSessionReader.listSessions` 的契约，这里只取第一页第一条。
 */
export function newestOf(reader: Pick<AgentSessionReader, 'listSessions'>, cwd: string) {
  return reader.listSessions(cwd, { limit: 1 }).sessions[0] ?? null;
}
