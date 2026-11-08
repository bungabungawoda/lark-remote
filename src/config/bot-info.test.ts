import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BOT_INFO_FILE,
  BOT_INFO_TTL_MS,
  fetchBotInfo,
  isBotInfoFresh,
  readBotInfo,
  resolveBotNames,
  type BotInfo,
  type BotInfoHttp,
} from './bot-info.js';
import { makeTempDir } from '../../tests/lib/temp-dir.js';

function writeCache(dir: string, info: Partial<BotInfo>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, BOT_INFO_FILE), JSON.stringify(info), 'utf-8');
}

function readCache(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, BOT_INFO_FILE), 'utf-8')) as Record<
    string,
    unknown
  >;
}

const okHttp = (appName = '报表机器人'): BotInfoHttp => ({
  post: async () => ({ data: { code: 0, tenant_access_token: 't-1' } }),
  get: async () => ({ data: { code: 0, bot: { app_name: appName } } }),
});

const failingHttp = (): BotInfoHttp => ({
  post: async () => {
    throw new Error('ECONNREFUSED');
  },
  get: async () => {
    throw new Error('ECONNREFUSED');
  },
});

const target = (dir: string, appId = 'cli_test', appSecret = 'secret-value') => ({
  dir,
  appId,
  appSecret,
});

describe('bot-info cache', () => {
  it('reads a valid cache and treats malformed files as absent', () => {
    const dir = makeTempDir('bot-info-');
    writeCache(dir, { appId: 'cli_a', appName: ' 报表 ', fetchedAt: new Date().toISOString() });
    expect(readBotInfo(dir)).toMatchObject({ appId: 'cli_a', appName: '报表' });

    fs.writeFileSync(path.join(dir, BOT_INFO_FILE), '{not json', 'utf-8');
    expect(readBotInfo(dir)).toBeUndefined();
  });

  it('treats malformed cache fields as absent and keeps a one-character name', () => {
    const dir = makeTempDir('bot-info-');
    writeCache(dir, {
      appId: 123 as unknown as string,
      appName: '报表',
      fetchedAt: new Date().toISOString(),
    });
    expect(readBotInfo(dir)).toBeUndefined();

    writeCache(dir, {
      appId: 'cli_a',
      appName: 123 as unknown as string,
      fetchedAt: new Date().toISOString(),
    });
    expect(readBotInfo(dir)).toBeUndefined();

    writeCache(dir, { appId: 'cli_a', appName: '   ', fetchedAt: new Date().toISOString() });
    expect(readBotInfo(dir)).toBeUndefined();

    writeCache(dir, {
      appId: 'cli_a',
      appName: 'A',
      fetchedAt: 123 as unknown as string,
    });
    expect(readBotInfo(dir)).toEqual({ appId: 'cli_a', appName: 'A', fetchedAt: '' });
  });

  it('expires after the TTL and rejects a different appId', () => {
    const now = Date.now();
    const fresh: BotInfo = {
      appId: 'cli_a',
      appName: '报表',
      fetchedAt: new Date(now - 1000).toISOString(),
    };
    expect(isBotInfoFresh(fresh, 'cli_a', now)).toBe(true);
    expect(isBotInfoFresh(fresh, 'cli_b', now)).toBe(false);
    expect(isBotInfoFresh(fresh, 'cli_a', now + BOT_INFO_TTL_MS)).toBe(false);
  });
});

describe('resolveBotNames', () => {
  it('uses a fresh cache without any HTTP call', async () => {
    const dir = makeTempDir('bot-info-');
    const now = Date.now();
    writeCache(dir, { appId: 'cli_a', appName: '缓存名', fetchedAt: new Date(now).toISOString() });
    let calls = 0;
    const http: BotInfoHttp = {
      post: async () => {
        calls++;
        throw new Error('should not fetch');
      },
      get: async () => {
        calls++;
        throw new Error('should not fetch');
      },
    };
    const result = await resolveBotNames([target(dir, 'cli_a')], { now, http });
    expect(calls).toBe(0);
    expect(result.get(dir)).toEqual({ appName: '缓存名', source: 'cache' });
  });

  it('fetches a missing name and writes a cache without the app secret', async () => {
    const dir = makeTempDir('bot-info-');
    const result = await resolveBotNames([target(dir)], { http: okHttp('报表助手') });

    expect(result.get(dir)).toEqual({ appName: '报表助手', source: 'fresh' });
    const cache = readCache(dir);
    expect(cache).toMatchObject({ appId: 'cli_test', appName: '报表助手' });
    expect(JSON.stringify(cache)).not.toContain('secret-value');
    expect(typeof cache.fetchedAt).toBe('string');
  });

  it('refetches when the cached appId no longer matches the config', async () => {
    const dir = makeTempDir('bot-info-');
    writeCache(dir, { appId: 'cli_old', appName: '旧名', fetchedAt: new Date().toISOString() });
    const result = await resolveBotNames([target(dir, 'cli_new')], { http: okHttp('新名') });
    expect(result.get(dir)).toEqual({ appName: '新名', source: 'fresh' });
    expect(readCache(dir)).toMatchObject({ appId: 'cli_new', appName: '新名' });
  });

  it('refetches an expired cache', async () => {
    const dir = makeTempDir('bot-info-');
    const now = Date.now();
    writeCache(dir, {
      appId: 'cli_test',
      appName: '旧名',
      fetchedAt: new Date(now - BOT_INFO_TTL_MS - 1).toISOString(),
    });
    const result = await resolveBotNames([target(dir)], { now, http: okHttp('新名') });
    expect(result.get(dir)).toEqual({ appName: '新名', source: 'fresh' });
  });

  it('falls back to a stale cache when the network fails', async () => {
    const dir = makeTempDir('bot-info-');
    writeCache(dir, {
      appId: 'cli_test',
      appName: '旧名',
      fetchedAt: new Date(Date.now() - BOT_INFO_TTL_MS - 1).toISOString(),
    });
    const result = await resolveBotNames([target(dir)], { http: failingHttp() });
    expect(result.get(dir)).toEqual({ appName: '旧名', source: 'stale' });
  });

  it('reports no name when there is no cache and the network fails', async () => {
    const dir = makeTempDir('bot-info-');
    const result = await resolveBotNames([target(dir)], { http: failingHttp() });
    expect(result.get(dir)).toEqual({ source: 'none' });
    expect(fs.existsSync(path.join(dir, BOT_INFO_FILE))).toBe(false);
  });

  it('rejects a non-zero token code, a non-zero bot code, and an empty name', async () => {
    const dir = makeTempDir('bot-info-');
    const badToken: BotInfoHttp = {
      post: async () => ({ data: { code: 99991663, msg: 'invalid app' } }),
      get: async () => {
        throw new Error('should not fetch bot info');
      },
    };
    expect((await resolveBotNames([target(dir)], { http: badToken })).get(dir)).toEqual({
      source: 'none',
    });

    const badInfo: BotInfoHttp = {
      post: async () => ({ data: { code: 0, tenant_access_token: 't' } }),
      get: async () => ({ data: { code: 40001, msg: 'no bot' } }),
    };
    expect((await resolveBotNames([target(dir)], { http: badInfo })).get(dir)).toEqual({
      source: 'none',
    });

    const emptyName: BotInfoHttp = {
      post: async () => ({ data: { code: 0, tenant_access_token: 't' } }),
      get: async () => ({ data: { code: 0, bot: { app_name: '   ' } } }),
    };
    expect((await resolveBotNames([target(dir)], { http: emptyName })).get(dir)).toEqual({
      source: 'none',
    });
  });

  it('rejects an unparsable fetchedAt and treats the TTL boundary as expired', () => {
    const now = Date.now();
    expect(
      isBotInfoFresh({ appId: 'cli_a', appName: 'x', fetchedAt: 'not-a-date' }, 'cli_a', now),
    ).toBe(false);
    const boundary = new Date(now - BOT_INFO_TTL_MS).toISOString();
    expect(
      isBotInfoFresh({ appId: 'cli_a', appName: 'x', fetchedAt: boundary }, 'cli_a', now),
    ).toBe(false);
  });

  it('honours an explicit epoch clock and a fresh epoch cache', async () => {
    const dir = makeTempDir('bot-info-');
    const info = await fetchBotInfo(target(dir), { http: okHttp('A'), now: 0 });
    expect(info).toMatchObject({ appName: 'A', fetchedAt: new Date(0).toISOString() });

    const cached = makeTempDir('bot-info-');
    writeCache(cached, { appId: 'cli_a', appName: '缓存名', fetchedAt: new Date(0).toISOString() });
    let calls = 0;
    const http: BotInfoHttp = {
      post: async () => {
        calls++;
        throw new Error('must not fetch');
      },
      get: async () => {
        calls++;
        throw new Error('must not fetch');
      },
    };
    const result = await resolveBotNames([target(cached, 'cli_a')], { now: 0, http });
    expect(calls).toBe(0);
    expect(result.get(cached)).toEqual({ appName: '缓存名', source: 'cache' });
  });

  it('accepts one-character tokens and names, and rejects a non-string token', async () => {
    const dir = makeTempDir('bot-info-');
    const oneChar: BotInfoHttp = {
      post: async () => ({ data: { code: 0, tenant_access_token: 't' } }),
      get: async () => ({ data: { code: 0, bot: { app_name: ' A ' } } }),
    };
    expect((await resolveBotNames([target(dir)], { http: oneChar })).get(dir)).toEqual({
      appName: 'A',
      source: 'fresh',
    });

    const objectTokenDir = makeTempDir('bot-info-');
    const objectToken: BotInfoHttp = {
      post: async () => ({ data: { code: 0, tenant_access_token: { length: 5 } } }),
      get: async () => ({ data: { code: 0, bot: { app_name: 'A' } } }),
    };
    expect(
      (await resolveBotNames([target(objectTokenDir)], { http: objectToken })).get(objectTokenDir),
    ).toEqual({ source: 'none' });

    const numericDir = makeTempDir('bot-info-');
    const numericToken: BotInfoHttp = {
      post: async () => ({ data: { code: 0, tenant_access_token: 123 } }),
      get: async () => ({ data: { code: 0, bot: { app_name: 'A' } } }),
    };
    expect(
      (await resolveBotNames([target(numericDir)], { http: numericToken })).get(numericDir),
    ).toEqual({ source: 'none' });
  });

  it('gives up when the shared timeout budget expires', async () => {
    const dir = makeTempDir('bot-info-');
    const hanging: BotInfoHttp = {
      post: (_url, _body, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      get: async () => {
        throw new Error('should not reach bot info');
      },
    };
    const startedAt = Date.now();
    const result = await resolveBotNames([target(dir)], { http: hanging, timeoutMs: 20 });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.get(dir)).toEqual({ source: 'none' });
  });

  it('limits concurrent fetches', async () => {
    const base = makeTempDir('bot-info-');
    const targets = Array.from({ length: 12 }, (_, i) =>
      target(path.join(base, `d${i}`), `cli_${i}`),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const http: BotInfoHttp = {
      async post() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { data: { code: 0, tenant_access_token: 't' } };
      },
      async get() {
        return { data: { code: 0, bot: { app_name: 'n' } } };
      },
    };
    const result = await resolveBotNames(targets, { http });
    expect(result.size).toBe(12);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('announces only the targets that need a remote fetch', async () => {
    const cached = makeTempDir('bot-info-');
    const missing = makeTempDir('bot-info-');
    const now = Date.now();
    writeCache(cached, { appId: 'cli_a', appName: '缓存', fetchedAt: new Date(now).toISOString() });
    const seen: number[] = [];
    await resolveBotNames([target(cached, 'cli_a'), target(missing, 'cli_b')], {
      now,
      http: okHttp('新名'),
      onStart: (pending) => seen.push(pending),
    });
    expect(seen).toEqual([1]);
  });

  it('works cache-only when remote fetching is disabled', async () => {
    const cached = makeTempDir('bot-info-');
    const missing = makeTempDir('bot-info-');
    writeCache(cached, {
      appId: 'cli_a',
      appName: '旧缓存',
      fetchedAt: new Date(0).toISOString(),
    });
    let calls = 0;
    const http: BotInfoHttp = {
      post: async () => {
        calls++;
        throw new Error('must not fetch');
      },
      get: async () => {
        calls++;
        throw new Error('must not fetch');
      },
    };
    const result = await resolveBotNames([target(cached, 'cli_a'), target(missing, 'cli_b')], {
      http,
      remote: false,
    });
    expect(calls).toBe(0);
    expect(result.get(cached)).toEqual({ appName: '旧缓存', source: 'stale' });
    expect(result.get(missing)).toEqual({ source: 'none' });
  });
});
