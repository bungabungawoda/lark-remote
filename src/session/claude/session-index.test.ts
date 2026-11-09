import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionIndex, buildFingerprint, parseSessionJsonl } from './session-index.js';

// ─── 合成 fixture 工厂 ───────────────────────────────────────
// 禁止真实会话数据：UUID 用 AABB 模式、cwd 用 /home/user/project、消息用 "placeholder"

const FAKE_SESSION_ID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const FAKE_SESSION_ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const FAKE_CWD_1 = '/home/user/project';
const FAKE_CWD_2 = '/home/user/other';
const FAKE_CWD_3 = '/home/user/third';

/** 构造一条 JSONL 行 */
function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/** 构造一个 user 消息行 */
function userMessageLine(text: string, cwd?: string): string {
  return jsonlLine({
    type: 'user',
    message: { role: 'user', content: text },
    ...(cwd ? { cwd } : {}),
  });
}

/** 构造一个 assistant 消息行 */
function assistantLine(cwd?: string): string {
  return jsonlLine({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ...(cwd ? { cwd } : {}),
  });
}

/** 构造 system.init 行（带 cwd） */
function initLine(cwd: string): string {
  return jsonlLine({ type: 'system', subtype: 'init', cwd });
}

/** 把行数组拼接为 JSONL 文件内容 */
function toJsonl(lines: string[]): string {
  return lines.join('\n') + '\n';
}

// ─── 测试辅助 ────────────────────────────────────────────────

let tmpDir: string;
let projectsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-index-test-'));
  projectsDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(projectsDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 创建一个项目目录并写入 jsonl */
function writeJsonl(projectName: string, sessionId: string, lines: string[]): string {
  const dir = path.join(projectsDir, projectName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, toJsonl(lines));
  return filePath;
}

/** 等待 mtime 变化（至少 1ms） */
async function tickMtime(): Promise<void> {
  // vitest fake timers don't affect real fs; just wait a real ms
  await new Promise((r) => setTimeout(r, 10));
}

// ─── parseSessionJsonl ───────────────────────────────────────

describe('parseSessionJsonl', () => {
  it('extracts cwdSet and summary from a simple session', () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
      assistantLine(FAKE_CWD_1),
    ]);
    const result = parseSessionJsonl(filePath);
    expect(result.cwdSet).toContain(FAKE_CWD_1);
    expect(result.summary).toBe('placeholder');
  });

  it('collects ALL cwd values (A→B→C)', () => {
    const filePath = writeJsonl('-home-user-third', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
      assistantLine(FAKE_CWD_1),
      initLine(FAKE_CWD_2),
      assistantLine(FAKE_CWD_2),
      initLine(FAKE_CWD_3),
      assistantLine(FAKE_CWD_3),
    ]);
    const result = parseSessionJsonl(filePath);
    expect(result.cwdSet).toContain(FAKE_CWD_1);
    expect(result.cwdSet).toContain(FAKE_CWD_2);
    expect(result.cwdSet).toContain(FAKE_CWD_3);
    expect(result.cwdSet.size).toBe(3);
  });

  it('keeps the first real user message as summary when later messages follow', () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('first placeholder'),
      assistantLine(FAKE_CWD_1),
      userMessageLine('second placeholder'),
    ]);
    const result = parseSessionJsonl(filePath);
    expect(result.summary).toBe('first placeholder');
  });

  it('skips task-notification user messages for summary', () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      jsonlLine({
        type: 'user',
        message: { role: 'user', content: '<task-notification result="success"/>' },
      }),
      userMessageLine('placeholder'),
    ]);
    const result = parseSessionJsonl(filePath);
    expect(result.summary).toBe('placeholder');
  });

  it('returns empty cwdSet and fallback summary for unreadable file', () => {
    const filePath = path.join(tmpDir, 'nonexistent.jsonl');
    const result = parseSessionJsonl(filePath);
    expect(result.cwdSet.size).toBe(0);
    expect(result.summary).toBe('(无摘要)');
  });

  it('returns fallback summary when no real user message exists', () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      assistantLine(FAKE_CWD_1),
    ]);
    const result = parseSessionJsonl(filePath);
    expect(result.summary).toBe('(无摘要)');
  });
});

// ─── buildFingerprint ────────────────────────────────────────

describe('buildFingerprint', () => {
  it('produces a string fingerprint from a real file stat', () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [initLine(FAKE_CWD_1)]);
    const fp = buildFingerprint(filePath);
    expect(typeof fp).toBe('string');
    expect(fp.length).toBeGreaterThan(0);
  });

  it('returns empty string for nonexistent file', () => {
    const fp = buildFingerprint(path.join(tmpDir, 'nope.jsonl'));
    expect(fp).toBe('');
  });

  it('fingerprint is size|mtimeNs|ctimeNs|dev|ino of the real bigint stat', () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [initLine(FAKE_CWD_1)]);
    const st = fs.statSync(filePath, { bigint: true });

    expect(buildFingerprint(filePath)).toBe(
      [st.size, st.mtimeNs, st.ctimeNs, st.dev, st.ino].map(String).join('|'),
    );
  });

  it('fingerprint changes after the file is rewritten', async () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [initLine(FAKE_CWD_1)]);
    const before = buildFingerprint(filePath);

    await tickMtime();
    fs.writeFileSync(
      filePath,
      toJsonl([initLine(FAKE_CWD_1), userMessageLine('a longer body than before')]),
    );

    expect(buildFingerprint(filePath)).not.toBe(before);
  });

  it('returns an empty fingerprint and warns when stat fails with a non-ENOENT error', () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [initLine(FAKE_CWD_1)]);
    const origStatSync = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === filePath) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return (origStatSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.statSync);
    try {
      expect(buildFingerprint(filePath)).toBe('');
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── SessionIndex build ──────────────────────────────────────

describe('SessionIndex build', () => {
  it('builds index with entries from projects dir', () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);
    writeJsonl('-home-user-other', FAKE_SESSION_ID_B, [
      initLine(FAKE_CWD_2),
      userMessageLine('other task'),
    ]);

    const idx = new SessionIndex(projectsDir);
    expect(idx.isBuilt).toBe(false);
    idx.build();
    expect(idx.isBuilt).toBe(true);

    const byCwd1 = idx.listByCwd(FAKE_CWD_1);
    expect(byCwd1.length).toBe(1);
    expect(byCwd1[0].sessionId).toBe(FAKE_SESSION_ID_A);

    const byCwd2 = idx.listByCwd(FAKE_CWD_2);
    expect(byCwd2.length).toBe(1);
    expect(byCwd2[0].sessionId).toBe(FAKE_SESSION_ID_B);
  });

  it('A→B→C: all three cwds find the same session via byCwd', () => {
    writeJsonl('-home-user-third', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
      initLine(FAKE_CWD_2),
      initLine(FAKE_CWD_3),
    ]);

    const idx = new SessionIndex(projectsDir);
    idx.build();

    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(1);
    expect(idx.listByCwd(FAKE_CWD_2).length).toBe(1);
    expect(idx.listByCwd(FAKE_CWD_3).length).toBe(1);
    // Same sessionId found from all three cwds
    expect(idx.listByCwd(FAKE_CWD_1)[0].sessionId).toBe(FAKE_SESSION_ID_A);
    expect(idx.listByCwd(FAKE_CWD_2)[0].sessionId).toBe(FAKE_SESSION_ID_A);
    expect(idx.listByCwd(FAKE_CWD_3)[0].sessionId).toBe(FAKE_SESSION_ID_A);
  });

  it('skips corrupt jsonl without failing other files', () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);
    // Write a corrupt file
    const corruptDir = path.join(projectsDir, '-home-user-corrupt');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, `${FAKE_SESSION_ID_B}.jsonl`), '{not valid json\n');

    const idx = new SessionIndex(projectsDir);
    idx.build();

    // Valid session still indexed
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(1);
  });

  it('readdir failure preserves empty index', () => {
    const idx = new SessionIndex(path.join(tmpDir, 'no-such-dir'));
    idx.build();
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(0);
  });
});

// ─── SessionIndex refresh ────────────────────────────────────

describe('SessionIndex refresh', () => {
  it('unchanged files keep the cached entry object (no re-parse)', async () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();
    const entryAfterBuild = idx.listByCwd(FAKE_CWD_1)[0];

    await new Promise((r) => setTimeout(r, 5));
    idx.refresh();
    expect(idx.listByCwd(FAKE_CWD_1)[0]).toBe(entryAfterBuild);
  });

  it('changed file is re-parsed and the summary updates', async () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();

    // Modify the file
    await tickMtime();
    fs.writeFileSync(filePath, toJsonl([initLine(FAKE_CWD_1), userMessageLine('updated')]));

    await new Promise((r) => setTimeout(r, 5));
    idx.refresh();
    expect(idx.listByCwd(FAKE_CWD_1)[0].summary).toBe('updated');
  });

  it('deleted file is removed from index', async () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(1);

    fs.unlinkSync(filePath);
    await new Promise((r) => setTimeout(r, 5));
    idx.refresh();
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(0);
  });

  it('moved file = old deleted + new parsed', async () => {
    const oldPath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(1);

    // "Move" the file: delete old, create in new dir
    fs.unlinkSync(oldPath);
    writeJsonl('-home-user-other', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    await new Promise((r) => setTimeout(r, 5));
    idx.refresh();
    // Still findable by cwd_1 (cwdSet hasn't changed)
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(1);
  });

  it('new file is added on refresh', async () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(1);

    writeJsonl('-home-user-project', FAKE_SESSION_ID_B, [
      initLine(FAKE_CWD_1),
      userMessageLine('second task'),
    ]);

    await new Promise((r) => setTimeout(r, 5));
    idx.refresh();
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(2);
  });

  it('readdir failure preserves old index', async () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(1);

    // Corrupt projectsDir so readdir fails (make it a file instead of dir)
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.writeFileSync(projectsDir, 'not a dir');

    await new Promise((r) => setTimeout(r, 5));
    idx.refresh();
    // Old index preserved
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(1);
  });

  it('concurrent write (fingerprint changes mid-parse) → skip, retry next refresh', async () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    // refreshIntervalMs: 1 让 refresh() 不被 5s 默认节流吞掉（build 后立刻刷新）。
    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();
    expect(idx.listByCwd(FAKE_CWD_1)[0].summary).toBe('placeholder');

    // 让下一轮 refresh 检测到 fingerprint 变化 → 走重解析路径。
    await tickMtime();
    fs.writeFileSync(filePath, toJsonl([initLine(FAKE_CWD_1), userMessageLine('updated')]));

    // 有状态 spy：目标文件在 refresh() 期间被 stat 两次时——第一次（解析前，
    // fpBefore）返回真实值，第二次（解析后，fpAfter）把 size 加 999n——
    // 制造 fpBefore !== fpAfter，模拟"解析中被并发改写"。只针对目标文件，
    // build() 已用真实 stat 完成，spy 只覆盖本次 refresh。
    const origStatSync = fs.statSync;
    let targetStats = 0;
    vi.spyOn(fs, 'statSync').mockImplementation((...args: unknown[]) => {
      const result = (origStatSync as (...a: unknown[]) => unknown).apply(fs, args);
      const p = args[0];
      if (typeof p === 'string' && p.endsWith(`${FAKE_SESSION_ID_A}.jsonl`)) {
        targetStats++;
        if (targetStats === 2) {
          // bigint 模式下 size 是 bigint：+999n 保证 fpAfter 与 fpBefore 不同
          const resultRecord = result as unknown as Record<string, unknown>;
          const cloned: Record<string, unknown> = { ...resultRecord };
          cloned.size = (resultRecord.size as bigint) + 999n;
          return cloned as unknown as fs.Stats;
        }
      }
      return result as fs.Stats;
    });

    // 保证 1ms 节流已过，refresh 真正执行全量扫描。
    await tickMtime();
    idx.refresh();

    // 守卫触发：本轮跳过该文件——updateEntry 不执行，旧条目保留，summary 不变。
    expect(idx.listByCwd(FAKE_CWD_1)[0].summary).toBe('placeholder');

    // 下一轮稳定刷新（真实 stat，无并发写）→ 重新解析并更新（retry 成功）。
    vi.restoreAllMocks();
    await tickMtime();
    idx.refresh();
    expect(idx.listByCwd(FAKE_CWD_1)[0].summary).toBe('updated');
  });
});

// ─── SessionIndex listByCwd ──────────────────────────────────

describe('SessionIndex listByCwd', () => {
  it('sorts by mtime desc then sessionId asc', async () => {
    // Write session A first, then B (B has newer mtime if we wait)
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);
    await tickMtime();
    writeJsonl('-home-user-project', FAKE_SESSION_ID_B, [
      initLine(FAKE_CWD_1),
      userMessageLine('second task'),
    ]);

    const idx = new SessionIndex(projectsDir);
    idx.build();

    const list = idx.listByCwd(FAKE_CWD_1);
    expect(list.length).toBe(2);
    // B has newer mtime → comes first
    expect(list[0].sessionId).toBe(FAKE_SESSION_ID_B);
    expect(list[1].sessionId).toBe(FAKE_SESSION_ID_A);
  });

  it('deduplicates same sessionId from multiple paths', () => {
    // Same sessionId appears in two project dirs with the same cwd in cwdSet
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
      initLine(FAKE_CWD_2),
    ]);
    writeJsonl('-home-user-other', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
      initLine(FAKE_CWD_2),
    ]);

    const idx = new SessionIndex(projectsDir);
    idx.build();

    const list = idx.listByCwd(FAKE_CWD_1);
    // Same sessionId should only appear once (keep mtime newest)
    expect(list.length).toBe(1);
    expect(list[0].sessionId).toBe(FAKE_SESSION_ID_A);
  });
});

// ─── SessionIndex findBySessionIdAndCwd ──────────────────────

describe('SessionIndex findBySessionIdAndCwd', () => {
  it('finds session by sessionId and cwd', () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir);
    idx.build();

    const entry = idx.findBySessionIdAndCwd(FAKE_SESSION_ID_A, FAKE_CWD_1);
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBe(FAKE_SESSION_ID_A);
    expect(entry!.path).toContain(`${FAKE_SESSION_ID_A}.jsonl`);
  });

  it('A→B→C: finds session by intermediate cwd B', () => {
    writeJsonl('-home-user-third', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
      initLine(FAKE_CWD_2),
      initLine(FAKE_CWD_3),
    ]);

    const idx = new SessionIndex(projectsDir);
    idx.build();

    // Can find by cwd B even though file is in cwd C's project dir
    const entry = idx.findBySessionIdAndCwd(FAKE_SESSION_ID_A, FAKE_CWD_2);
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBe(FAKE_SESSION_ID_A);
  });

  it('rejects foreign cwd (cwd not in cwdSet)', () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir);
    idx.build();

    const entry = idx.findBySessionIdAndCwd(FAKE_SESSION_ID_A, FAKE_CWD_2);
    expect(entry).toBeUndefined();
  });

  it('re-stats and verifies fingerprint before returning', async () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();

    // First lookup: fingerprint matches → trust index
    const entry1 = idx.findBySessionIdAndCwd(FAKE_SESSION_ID_A, FAKE_CWD_1);
    expect(entry1).toBeDefined();

    // Modify the file (fingerprint changes)
    await tickMtime();
    fs.writeFileSync(filePath, toJsonl([initLine(FAKE_CWD_2), userMessageLine('changed')]));

    // Second lookup: fingerprint mismatch → re-parse and re-check
    const entry2 = idx.findBySessionIdAndCwd(FAKE_SESSION_ID_A, FAKE_CWD_2);
    expect(entry2).toBeDefined();
    // cwd_1 is no longer in cwdSet
    const entry3 = idx.findBySessionIdAndCwd(FAKE_SESSION_ID_A, FAKE_CWD_1);
    expect(entry3).toBeUndefined();
  });

  it('does not re-parse the same path repeatedly when stat keeps changing mid-lookup', () => {
    // 红：findBySessionIdAndCwd 迭代 bySessionId 的 Set，updateEntry 会
    // delete+add 同一 path（Set 迭代器把它排到队尾后重新访问）。文件持续写入
    // （活跃会话）时指纹每次都不一致，同一个 path 被反复全量解析。
    // 必须有两个同 sessionId 的 path：只有一个时 removeCrossRefs 会连 Set 一起删掉，
    // 迭代器结束，掩盖 delete+add 的重访行为。
    const fileA = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);
    const fileB = writeJsonl('-home-user-other', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);
    const targets = new Set([fileA, fileB]);

    const idx = new SessionIndex(projectsDir);
    idx.build();

    const originalStatSync = fs.statSync;
    let syntheticStats = 0;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((
      p: fs.PathLike,
      opts?: fs.StatSyncOptions,
    ) => {
      if (targets.has(String(p)) && syntheticStats < 8) {
        syntheticStats++;
        const n = syntheticStats;
        return {
          size: BigInt(1000 + n),
          mtimeNs: BigInt(1_000_000 + n),
          ctimeNs: BigInt(1_000_000 + n),
          dev: BigInt(1),
          ino: BigInt(1),
          mtimeMs: 1000 + n,
        } as unknown as fs.BigIntStats;
      }
      return (originalStatSync as (p: fs.PathLike, o?: fs.StatSyncOptions) => fs.Stats)(p, opts);
    }) as unknown as typeof fs.statSync);

    expect(idx.findBySessionIdAndCwd(FAKE_SESSION_ID_A, FAKE_CWD_2)).toBeUndefined();
    // 一次查询最多：两个 path 各 buildFingerprint + 更新条目 1 次 stat = 4。
    expect(syntheticStats).toBeLessThanOrEqual(4);
    spy.mockRestore();
  });

  it('returns undefined for nonexistent sessionId', () => {
    const idx = new SessionIndex(projectsDir);
    idx.build();

    const entry = idx.findBySessionIdAndCwd('no-such-id', FAKE_CWD_1);
    expect(entry).toBeUndefined();
  });
  it('subdir read failure preserves existing entries instead of deleting them', () => {
    // 红：单个 project 子目录 readdir 失败只记 debug 并 continue，文件不进
    // currentPaths；末尾「删除已消失文件」把该目录全部条目移出索引。EACCES/
    // EMFILE 这类可恢复读取失败会表现成「这些会话不存在」。
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);
    const idx = new SessionIndex(projectsDir);
    idx.build();
    expect(idx.listByCwd(FAKE_CWD_1)).toHaveLength(1);

    const originalReaddir = fs.readdirSync as unknown as (p: fs.PathLike, o?: unknown) => unknown;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((
      p: fs.PathLike,
      opts?: unknown,
    ) => {
      if (path.basename(String(p)) === '-home-user-project') {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return originalReaddir(p, opts);
    }) as unknown as typeof fs.readdirSync);

    idx.build();
    expect(idx.listByCwd(FAKE_CWD_1)).toHaveLength(1);
    spy.mockRestore();
  });
});

// ─── SessionIndex throttled refresh ─────────────────────────

describe('SessionIndex throttled refresh', () => {
  it('refresh within throttle interval is a no-op', () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 5000 });
    idx.build();

    // Change the file, then refresh immediately: throttle must skip the scan,
    // so the cached summary stays at the value captured by build().
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('updated'),
    ]);
    idx.refresh();
    expect(idx.listByCwd(FAKE_CWD_1)[0].summary).toBe('placeholder');
  });

  it('refresh after throttle interval actually scans', async () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    // Use very short throttle (1ms) so we can test actual refresh
    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();

    await new Promise((r) => setTimeout(r, 5));

    writeJsonl('-home-user-project', FAKE_SESSION_ID_B, [
      initLine(FAKE_CWD_1),
      userMessageLine('second task'),
    ]);

    idx.refresh();
    expect(idx.listByCwd(FAKE_CWD_1).length).toBe(2);
  });
});

// ─── cwd 判等键（回归锚）────────────────────
// 修复前 byCwd 倒排与 cwdSet.has 都按 JSONL 原样字符串精确键控，查询 cwd 与
// 记录 cwd 差一个大小写/分隔符/尾斜杠（win32 常态）时 /session list 静默漏会话。
// platform 注入使 win32 语义在任意宿主可测（seam 纪律）。
describe('SessionIndex cwd 判等键（pathKey 归一）', () => {
  it('win32 语义：大小写、\\// 分隔符、尾斜杠变体都能命中索引', () => {
    writeJsonl('C--Users-X-Proj', FAKE_SESSION_ID_A, [
      initLine('C:\\Users\\X\\Proj'),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { platform: 'win32' });
    idx.build();

    // 查询形态与记录形态逐字符不同，但按 win32 语义是同一目录
    expect(idx.listByCwd('c:/users/x/proj/').length).toBe(1);
    expect(idx.listByCwd('C:\\USERS\\x\\PROJ').length).toBe(1);
    expect(idx.listByCwd('c:/users/other').length).toBe(0);

    const entry = idx.findBySessionIdAndCwd(FAKE_SESSION_ID_A, 'C:/Users/x/Proj/');
    expect(entry?.sessionId).toBe(FAKE_SESSION_ID_A);
  });

  it('darwin 语义：大小写不敏感（linux 宿主默认档不受影响）', () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine('/home/user/Project'),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { platform: 'darwin' });
    idx.build();
    expect(idx.listByCwd('/HOME/USER/PROJECT/').length).toBe(1);
  });
});
