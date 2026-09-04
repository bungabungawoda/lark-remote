/**
 * Generic TTL + bounded LRU cache.
 *
 * Consolidates the per-reader memory caches that previously hand-rolled the
 * same "mtime/TTL + entry cap" Map pattern (kimi/pi/opencode session readers).
 * Semantics follow the kimi implementation:
 * - TTL is measured from the cache-write time (P1-17 defect 2), not key mtime.
 *   Note: ttlMs = 0 effectively disables caching — `Date.now() - at >= 0` is
 *   always true, so every entry expires immediately.
 * - A hit refreshes recency (LRU); eviction removes the least recently
 *   inserted/used entry past `maxEntries` (P1-17 defect 1: unbounded growth).
 *   The old pi implementation did NOT re-insert on hit (FIFO eviction); the
 *   eviction order for pi therefore changes from FIFO to LRU here.
 */
export class TtlCache<K, V> {
  private map = new Map<K, { at: number; value: V }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries?: number,
  ) {}

  /** Return the fresh value for `key` (refreshing LRU order), or undefined. */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU refresh: re-insert to move to the tail of iteration order.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, { at: Date.now(), value });
    if (this.maxEntries !== undefined) {
      while (this.map.size > this.maxEntries) {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) break;
        this.map.delete(oldest);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}
