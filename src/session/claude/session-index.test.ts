import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionIndex, buildFingerprint, parseSessionJsonl } from './session-index.js';

// ─── 合成 fixture 工厂 ───────────────────────────────────────
// 禁止真实会话数据：UUID 用 AABB 模式、cwd 用 /home/user/project、消息用 "placeholder"

const FAKE_SESSION_ID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const FAKE_SESSION_ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const FAKE_SESSION_ID_C = 'cccccccc-1111-2222-3333-444444444444';
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
    idx.build();

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
  it('unchanged files are NOT re-parsed (parse count stays same)', async () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();
    const parseCountAfterBuild = idx.parseCount;

    await new Promise((r) => setTimeout(r, 5));
    idx.refresh();
    const parseCountAfterRefresh = idx.parseCount;
    expect(parseCountAfterRefresh).toBe(parseCountAfterBuild);
  });

  it('changed file is re-parsed', async () => {
    const filePath = writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);

    const idx = new SessionIndex(projectsDir, { refreshIntervalMs: 1 });
    idx.build();
    const parseCountAfterBuild = idx.parseCount;

    // Modify the file
    await tickMtime();
    fs.writeFileSync(filePath, toJsonl([initLine(FAKE_CWD_1), userMessageLine('updated')]));

    await new Promise((r) => setTimeout(r, 5));
    idx.refresh();
    const parseCountAfterRefresh = idx.parseCount;
    expect(parseCountAfterRefresh).toBe(parseCountAfterBuild + 1);
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
      const result = origStatSync.apply(fs, args as [string, ...unknown[]]);
      const p = args[0];
      if (typeof p === 'string' && p.endsWith(`${FAKE_SESSION_ID_A}.jsonl`)) {
        targetStats++;
        if (targetStats === 2) {
          // bigint 模式下 size 是 bigint：+999n 保证 fpAfter 与 fpBefore 不同
          const resultRecord = result as Record<string, unknown>;
          const cloned = { ...resultRecord };
          cloned.size = (resultRecord.size as bigint) + 999n;
          return cloned as fs.Stats;
        }
      }
      return result;
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

  it('supports pagination with offset and limit', async () => {
    writeJsonl('-home-user-project', FAKE_SESSION_ID_A, [
      initLine(FAKE_CWD_1),
      userMessageLine('placeholder'),
    ]);
    await tickMtime();
    writeJsonl('-home-user-project', FAKE_SESSION_ID_B, [
      initLine(FAKE_CWD_1),
      userMessageLine('second task'),
    ]);
    await tickMtime();
    writeJsonl('-home-user-project', FAKE_SESSION_ID_C, [
      initLine(FAKE_CWD_1),
      userMessageLine('third task'),
    ]);

    const idx = new SessionIndex(projectsDir);
    idx.build();

    // Page 1: limit 2
    const page1 = idx.listByCwd(FAKE_CWD_1, { limit: 2, offset: 0 });
    expect(page1.length).toBe(2);
    expect(page1[0].sessionId).toBe(FAKE_SESSION_ID_C); // newest first

    // Page 2: offset 2
    const page2 = idx.listByCwd(FAKE_CWD_1, { limit: 2, offset: 2 });
    expect(page2.length).toBe(1);
    expect(page2[0].sessionId).toBe(FAKE_SESSION_ID_A); // oldest
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

  it('returns undefined for nonexistent sessionId', () => {
    const idx = new SessionIndex(projectsDir);
    idx.build();

    const entry = idx.findBySessionIdAndCwd('no-such-id', FAKE_CWD_1);
    expect(entry).toBeUndefined();
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

    // Immediate refresh should be a no-op (within throttle)
    idx.refresh();
    // Should not have re-scanned directories
    expect(idx.scanCount).toBe(1); // Only the initial build
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
