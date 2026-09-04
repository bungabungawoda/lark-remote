import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtlCache } from './ttl-cache.js';

describe('TtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns fresh values and expires past the TTL (measured from write time)', () => {
    const cache = new TtlCache<string, number>(5_000);
    cache.set('k', 1);
    expect(cache.get('k')).toBe(1);

    vi.advanceTimersByTime(4_999);
    expect(cache.get('k')).toBe(1);

    vi.advanceTimersByTime(1);
    expect(cache.get('k')).toBeUndefined();
  });

  it('hit refreshes LRU recency; eviction removes the least recently used entry', () => {
    const cache = new TtlCache<string, number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a 刷新为最近使用
    cache.set('c', 3); // 超上限，应淘汰 b（而非 a）

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('set overwrites the write time of an existing key', () => {
    const cache = new TtlCache<string, number>(5_000);
    cache.set('k', 1);
    vi.advanceTimersByTime(4_000);
    cache.set('k', 2); // 重写刷新时间基
    vi.advanceTimersByTime(4_000);
    expect(cache.get('k')).toBe(2);
  });

  it('clear empties all entries', () => {
    const cache = new TtlCache<string, number>(60_000);
    cache.set('a', 1);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});
