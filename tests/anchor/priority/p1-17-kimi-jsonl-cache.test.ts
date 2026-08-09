/**
 * P1-17 anchors: kimi jsonlCache two independent defects
 *
 * 1. TTL uses the FILE mtime instead of the cache-write time
 *    (src/session/kimi/sessions.ts, CACHE_TTL_MS check): for any file whose
 *    mtime is older than the 5s TTL (i.e. almost every non-live session),
 *    the cache never hits — every call re-reads and re-writes the entry.
 *    review.md §P1-17: "TTL 逻辑错误: Date.now() - cached.mtime < CACHE_TTL_MS
 *    用的是文件 mtime 而非缓存写入时间。mtime 超过 5 秒的文件缓存永不命中".
 * 2. The module-level Map is unbounded (no delete/clear anywhere), so long-lived
 *    bridges accumulate every read wire.jsonl's full lines forever.
 *    review.md §P1-17: "无界内存: 全代码库无任何 delete/clear…进程 RSS 持续上涨".
 *
 * Fix expectation: cache entry stores cachedAt=Date.now() for TTL and evicts
 * the least-recently-used entry past a small cap (32), so both anchors go red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockLogger, jsonlSpy } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  jsonlSpy: {
    readJsonlLines: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// Spy the shared jsonl module so we can count real file reads through kimi's
// wrapper (real implementation kept, call counts tracked).
vi.mock('../../../src/session/common/jsonl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/session/common/jsonl.js')>();
  jsonlSpy.readJsonlLines.mockImplementation(actual.readJsonlLines);
  return {
    ...actual,
    readJsonlLines: jsonlSpy.readJsonlLines,
  };
});

const { KimiSessionReader } = await import('../../../src/session/kimi/index.js');

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-17-kimi-cache-'));
  jsonlSpy.readJsonlLines.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSession(kimiDir: string, sessionId: string, workDir: string): string {
  const sessionDir = path.join(kimiDir, 'sessions', sessionId);
  fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      updatedAt: new Date().toISOString(),
      title: sessionId,
      isCustomTitle: true,
      workDir,
      lastPrompt: `prompt ${sessionId}`,
    }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
    `{"type":"turn.prompt","input":[{"type":"text","text":"hi"}],"origin":{"kind":"user"},"time":${Date.now()}}\n`,
    'utf-8',
  );
  return sessionDir;
}

describe('P1-17 kimi jsonlCache', () => {
  it('test_anchor_kimi_jsonl_cache_ttl_uses_cached_at_not_file_mtime', () => {
    // ① 验证什么行为：TTL 判定用缓存写入时间（cachedAt），文件 mtime 一小时前、
    //    刚读过 → 第二次 readSessionContent 必须命中缓存（不重读 wire.jsonl）。
    // ② 缺失/错误会导致什么：TTL 用文件 mtime 时，非活跃（mtime>5s）文件缓存
    //    永不命中 → 每次调用全量重读 + 重写缓存，缓存形同虚设，/resume 翻页与
    //    完成通知卡反复全量 parse 数 MB wire 文件，事件循环同步阻塞。
    // ③ 依据：review.md §P1-17 缺陷 2（TTL 判定用错时间基准）。
    const kimiDir = fs.mkdtempSync(path.join(tmpRoot, 'kimi'));
    const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'proj'));
    const realCwd = fs.realpathSync(projectDir);
    const sessionDir = makeSession(kimiDir, 's1', realCwd);

    // 文件 mtime 一小时前（秒为单位，毫秒会被 APFS 钳制失去判别力）
    const oneHourAgoSec = (Date.now() - 3600_000) / 1000;
    fs.utimesSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      oneHourAgoSec,
      oneHourAgoSec,
    );
    fs.writeFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 's1', sessionDir, workDir: realCwd }) + '\n',
      'utf-8',
    );

    const reader = new KimiSessionReader(kimiDir);
    reader.readSessionContent('s1', realCwd);
    const callsAfterFirst = jsonlSpy.readJsonlLines.mock.calls.length;

    reader.readSessionContent('s1', realCwd);

    // 第二次调用不得触发任何新的共享 jsonl 读取（index 与 wire 都应缓存命中）
    expect(jsonlSpy.readJsonlLines.mock.calls.length).toBe(callsAfterFirst);
  });

  it('test_anchor_kimi_jsonl_cache_bounded_lru', () => {
    // ① 验证什么行为：缓存有界（LRU 上限），超过上限后最早插入的条目被淘汰；
    //    33 个 wire 文件逐个读取后，再读第 1 个必须重读文件（已被淘汰）。
    // ② 缺失/错误会导致什么：无界 Map 缓存整份 wire.jsonl（单文件数 MB），bridge
    //    长期驻留每次 /resume 翻页、每次完成通知卡都往 Map 塞新 entry 永不释放
    //    → 内存单调增长直至 OOM。
    // ③ 依据：review.md §P1-17 缺陷 1（无界增长）与修复建议「加 size 上限（如
    //    32 条 LRU）」。
    const kimiDir = fs.mkdtempSync(path.join(tmpRoot, 'kimi'));
    const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'proj'));
    const realCwd = fs.realpathSync(projectDir);
    const sessionDirs: string[] = [];
    const indexLines: string[] = [];
    for (let i = 0; i < 33; i++) {
      const id = `s${String(i).padStart(2, '0')}`;
      const dir = makeSession(kimiDir, id, realCwd);
      sessionDirs.push(dir);
      indexLines.push(JSON.stringify({ sessionId: id, sessionDir: dir, workDir: realCwd }));
    }
    fs.writeFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      indexLines.join('\n') + '\n',
      'utf-8',
    );

    const reader = new KimiSessionReader(kimiDir);
    for (const id of sessionDirs.map((_d, i) => `s${String(i).padStart(2, '0')}`)) {
      reader.readSessionContent(id, realCwd);
    }

    const callsBeforeReread = jsonlSpy.readJsonlLines.mock.calls.length;
    reader.readSessionContent('s00', realCwd);

    // 最早插入的 s00 应已被 LRU 淘汰 → 重读触发新的共享读取
    expect(jsonlSpy.readJsonlLines.mock.calls.length).toBeGreaterThan(callsBeforeReread);
  });
});
