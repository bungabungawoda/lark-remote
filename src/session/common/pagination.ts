/**
 * Shared pagination / truncation helpers for agent session readers.
 *
 * The five readers (claude/codex/opencode/pi/kimi) all implement the same
 * offset-clamp + slice + total pattern for `listSessions`, and the same
 * maxEvents tail-cap for `readSessionContent`. These were duplicated (and had
 * drifted on the default limit). Centralized here so the contract is defined
 * once: default page limit is 20, matching the majority of readers.
 */

/** Default page size for listSessions. */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * Paginate a (already-ordered) full item list by offset + limit.
 * Clamps negative offset to 0; caps limit to the remaining items.
 */
export function paginate<T>(
  items: T[],
  opts: { limit?: number; offset?: number },
): {
  items: T[];
  total: number;
} {
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const offset = Math.max(0, opts.offset ?? 0);
  return { items: items.slice(offset, offset + limit), total: items.length };
}

/**
 * Apply the maxEvents tail-cap shared by readSessionContent:
 * keep the LAST N events; maxEvents <= 0 returns [] (guards the
 * `slice(-0) === slice(0)` full-array trap).
 */
export function capEvents<T>(events: T[], maxEvents?: number): T[] {
  if (maxEvents === undefined || maxEvents > events.length) return events;
  if (maxEvents <= 0) return [];
  return events.slice(-maxEvents);
}
