import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isNewer, checkLatestVersion, type UpdateCache, CACHE_TTL_MS } from './version-check.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir } from '../../tests/lib/temp-dir.js';

/**
 * 本文件独占的临时目录 + 其中的 cache 文件（在 beforeEach 里分配，见下）。
 * 模块级声明是为了让「缓存路径隔离」断言与其他用例共用同一份定义。
 */
let tmpDir = '';
let cachePath = '';

// 每个用例独占一个 mkdtemp 目录：把缓存写在固定共享路径上，只要还有第二个写者
// （并行 worktree、上一轮残留的 worker）就会抢写同一文件。跑完由 temp-dir.ts
// 注册的 afterAll 统一清理，不会往 temp 根目录漏文件。
beforeEach(() => {
  tmpDir = makeTempDir('lark-remote-update-cache-');
  cachePath = path.join(tmpDir, 'update-cache.json');
});

describe('cache path isolation', () => {
  it('keeps the cache inside a per-file private temp dir, not a shared fixed path', () => {
    // 旧写法 `path.join('/tmp', 'lark-remote-test-update-cache.json')` 在 win32 上是
    // **驱动器相对路径**（无盘符的 `\tmp\...`），会落到 cwd 所在盘符的 `D:\tmp\` ——
    // 一个仓库外、名字固定、跨进程共享的位置。只要还有第二个写者（并行 worktree、
    // 上一轮残留的 worker），就会抢写同一文件，win32 上表现为
    // `EBUSY: resource busy or locked`（并发 probe 实测：same-family 的
    // `EPERM: rename` / `ENOENT` 共 71 次）。而且它不在 os.tmpdir() 下，
    // `sweepProjectTempDirs` 兜底清扫也覆盖不到 → 残留会永久留在磁盘上。
    // temp-hygiene:allow-fixed-path —— 字面量只作**反例**（断言不等于旧共享路径）
    expect(cachePath).not.toBe(path.join('/tmp', 'lark-remote-test-update-cache.json'));
    expect(cachePath.startsWith(os.tmpdir() + path.sep)).toBe(true);
    expect(path.dirname(cachePath)).toBe(tmpDir);
  });
});

describe('isNewer', () => {
  it('returns true when latest > current', () => {
    expect(isNewer('0.1.0', '0.2.0')).toBe(true);
    expect(isNewer('1.0.0', '2.0.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.1')).toBe(true);
  });

  it('returns false when latest <= current', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(false);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('1.0.0', '0.9.9')).toBe(false);
  });

  it('returns null for non-semver strings', () => {
    expect(isNewer('not-semver', '0.2.0')).toBeNull();
    expect(isNewer('0.1.0', 'not-semver')).toBeNull();
    expect(isNewer('1', '2')).toBeNull();
    expect(isNewer('1..0', '1.0.0')).toBeNull();
    expect(isNewer('1.0.0.0', '1.0.0')).toBeNull();
  });

  it('handles pre-release correctly (pre-release < release)', () => {
    // 0.1.0-alpha < 0.1.0 — a release is newer than a pre-release of the
    // same core version; a pre-release is never newer than the release.
    expect(isNewer('0.1.0-alpha', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0-alpha')).toBe(false);
    expect(isNewer('0.1.0-alpha', '0.1.0-beta')).toBe(false);
  });
});

describe('checkLatestVersion', () => {
  let server: http.Server;
  let registryUrl: string;
  let requestCount = 0;

  beforeAll(async () => {
    // Local registry stub: keeps these tests offline and deterministic
    // instead of hitting the real npm registry (live tests must not run
    // by default in the suite).
    server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '9.9.9' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    registryUrl = `http://127.0.0.1:${port}/latest`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requestCount = 0;
  });

  it('returns current and latest versions on success', async () => {
    const result = await checkLatestVersion({ cachePath, registryUrl });
    expect(result).toHaveProperty('current');
    expect(result).toHaveProperty('latest');
    expect(typeof result.current).toBe('string');
    expect(typeof result.latest).toBe('string');
  });

  it('caches result and reuses within TTL', async () => {
    const first = await checkLatestVersion({ cachePath, registryUrl });
    const second = await checkLatestVersion({ cachePath, registryUrl });
    expect(first.latest).toBe(second.latest);
    // Second call must be served from the cache, not from the registry.
    expect(requestCount).toBe(1);

    // Verify cache file exists
    expect(fs.existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as UpdateCache;
    expect(cached.latestVersion).toBe(first.latest);
  });

  it('bypasses cache when bypassCache=true', async () => {
    // Write a stale cache entry
    const staleCache: UpdateCache = {
      latestVersion: '0.0.1',
      checkedAt: new Date(0).toISOString(),
    };
    fs.writeFileSync(cachePath, JSON.stringify(staleCache));

    const result = await checkLatestVersion({ cachePath, registryUrl, bypassCache: true });
    // Should not return 0.0.1 (the stale cache value)
    expect(result.latest).not.toBe('0.0.1');
  });

  it('re-fetches when cache is expired', async () => {
    // Write an expired cache entry
    const expiredCache: UpdateCache = {
      latestVersion: '0.0.1',
      checkedAt: new Date(Date.now() - CACHE_TTL_MS - 1000).toISOString(),
    };
    fs.writeFileSync(cachePath, JSON.stringify(expiredCache));

    const result = await checkLatestVersion({ cachePath, registryUrl });
    expect(result.latest).not.toBe('0.0.1');
  });

  it('uses cached value when within TTL', async () => {
    // Write a fresh cache entry
    const freshCache: UpdateCache = {
      latestVersion: '8.8.8',
      checkedAt: new Date().toISOString(),
    };
    fs.writeFileSync(cachePath, JSON.stringify(freshCache));

    const result = await checkLatestVersion({ cachePath, registryUrl });
    // 8.8.8 differs from the registry stub's 9.9.9, proving the cache wins.
    expect(result.latest).toBe('8.8.8');
  });

  it('throws on network error', async () => {
    // Use an invalid URL to force a network error
    await expect(
      checkLatestVersion({ registryUrl: 'http://127.0.0.1:1/nonexistent' }),
    ).rejects.toThrow();
  });
});
