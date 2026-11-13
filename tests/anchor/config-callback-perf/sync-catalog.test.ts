/**
 * SyncCatalog（统一 SWR 目录缓存契约）单测。
 *
 * 覆盖四个 loader 共用的行为面：fresh/stale/inflight/cold/negative/key-shift
 * 六种读取形态 + 单飞刷新 + 失败保快照。pi/codex/opencode/kimi 的迁移都以本
 * 契约为准；agent 专属解析行为的测试留在各自 config 测试文件。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/logger/index.js', async () =>
  (await import('../lib/logger-mock.js')).loggerModuleMock(),
);

import { SyncCatalog } from '../../../src/config/catalog-cache.js';

describe('SyncCatalog（SWR 目录缓存契约）', () => {
  function makeCatalog(overrides?: Partial<Parameters<typeof makeSync>[0]>) {
    return makeSync({ ...overrides });
  }

  function makeSync(overrides?: {
    loadSync?: () => number[];
    loadAsync?: () => Promise<number[]>;
    fallback?: () => number[];
    isEmpty?: (v: number[]) => boolean;
  }) {
    let syncCalls = 0;
    let asyncCalls = 0;
    const catalog = new SyncCatalog<number[]>({
      agent: 'test',
      key: () => 'k1',
      loadSync: () => {
        syncCalls += 1;
        return overrides?.loadSync?.() ?? [1];
      },
      loadAsync: async () => {
        asyncCalls += 1;
        return overrides?.loadAsync?.() ?? [1, 2];
      },
      fallback: () => overrides?.fallback?.() ?? [],
      isEmpty: overrides?.isEmpty ?? ((v) => v.length === 0),
    });
    return { catalog, counts: () => ({ syncCalls, asyncCalls }) };
  }

  it('冷启动走一次同步加载，后续读命中 fresh', () => {
    const { catalog, counts } = makeCatalog();
    expect(catalog.read()).toEqual([1]);
    expect(catalog.read()).toEqual([1]);
    expect(counts().syncCalls).toBe(1);
    expect(counts().asyncCalls).toBe(0);
  });

  it('同步冷加载抛错时回退 fallback 并落负缓存（不反复阻塞）', () => {
    const { catalog, counts } = makeCatalog({
      loadSync: () => {
        throw new Error('CLI missing');
      },
    });
    expect(catalog.read()).toEqual([]);
    expect(catalog.read()).toEqual([]); // negative 命中
    expect(counts().syncCalls).toBe(1);
  });

  it('TTL 过期：返回旧快照（stale）并点火一次后台刷新', async () => {
    vi.useFakeTimers();
    try {
      const asyncResult = [1, 2];
      const { catalog, counts } = makeCatalog({
        loadAsync: async () => asyncResult,
      });
      expect(catalog.read()).toEqual([1]); // cold
      vi.advanceTimersByTime(6 * 60_000); // 过 TTL
      const stale = catalog.read();
      expect(stale).toEqual([1]); // 旧快照立即返回
      expect(counts().syncCalls).toBe(1); // 未同步 spawn
      await vi.runAllTimersAsync();
      expect(counts().asyncCalls).toBe(1);
      // 刷新落地后读到新值
      expect(catalog.read()).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stale 连读不重复点火（in-flight 单飞）', async () => {
    vi.useFakeTimers();
    try {
      const { catalog, counts } = makeCatalog();
      catalog.read(); // cold
      vi.advanceTimersByTime(6 * 60_000);
      catalog.read(); // stale → 点火
      catalog.read(); // 仍 stale（刷新未落地）→ 不再点火
      await vi.runAllTimersAsync();
      expect(counts().asyncCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('刷新失败：保留上次成功快照并落负缓存（下拉框不变空）', async () => {
    vi.useFakeTimers();
    try {
      let shouldFail = false;
      const { catalog, counts } = makeCatalog({
        loadAsync: async () => {
          if (shouldFail) throw new Error('offline');
          return [1, 2];
        },
      });
      catalog.read(); // cold [1]
      vi.advanceTimersByTime(6 * 60_000);
      shouldFail = true;
      await catalog.refresh();
      // 失败后同步读拿旧成功快照
      expect(catalog.read()).toEqual([1]);
      expect(counts().asyncCalls).toBe(1);
      // 负缓存 TTL 内不重复点火
      catalog.read();
      await vi.runAllTimersAsync();
      expect(counts().asyncCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('key 漂移（binary/配置目录变化）：不返回旧清单，改回 fallback + 后台刷新新键', async () => {
    vi.useFakeTimers();
    try {
      let currentKey = 'k1';
      const catalog = new SyncCatalog<number[]>({
        agent: 'test',
        key: () => currentKey,
        loadSync: () => [1],
        loadAsync: async () => [2],
        fallback: () => [],
      });
      expect(catalog.read()).toEqual([1]); // cold under k1
      currentKey = 'k2';
      // key-shift：**不能**把 k1 的清单当成 k2 的返回（旧身份冒充新身份会让
      // 卡片展示/写回一个当前 binary 或配置目录下不存在的模型 id）。
      expect(catalog.read()).toEqual([]);
      await vi.runAllTimersAsync();
      expect(catalog.read()).toEqual([2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warm 后首次同步读命中快照（零 spawn）', async () => {
    const { catalog, counts } = makeCatalog();
    catalog.warm();
    await vi.waitFor(() => expect(counts().asyncCalls).toBe(1));
    expect(catalog.read()).toEqual([1, 2]);
    expect(counts().syncCalls).toBe(0);
  });
});
