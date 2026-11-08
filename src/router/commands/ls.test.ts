import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLsCommand, LS_PAGE_SIZE } from './ls.js';
import type { CommandContext } from '../../bridge/index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const ctx = { userId: 'u1', chatId: 'c1' } as unknown as CommandContext;

describe('/ls 分页后按需 stat', () => {
  it('万级目录下只对当前页文件 stat（不再全量 statSync）', () => {
    const dir = makeTempDir('lark-ls-bench-');
    // 300 个文件：旧实现对每个 entry statSync；新实现只 stat 当前页 ≤30 个。
    for (let i = 0; i < 300; i++) {
      fs.writeFileSync(path.join(dir, `file-${String(i).padStart(3, '0')}.txt`), 'x');
    }

    const statSpy = vi.spyOn(fs, 'statSync');
    const result = buildLsCommand([], ctx, { cwd: dir });

    expect(result.card).toBeDefined();
    // readdir 本身不 stat；inspectPath(1) + 当前页 30 文件 + 分页栏等少量固定开销。
    // 旧实现这里是 300+ 次；阈值放宽到 50 也不会被全量扫描满足。
    expect(statSpy.mock.calls.length).toBeLessThanOrEqual(50);
    // 当前页文件按钮仍带 size 标签。
    const labels = JSON.stringify(result.card);
    expect(labels).toContain('file-000.txt');
    expect(labels).toContain('(1B)');
  });

  it('翻页后 stat 的是新页的文件', () => {
    const dir = makeTempDir('lark-ls-page-');
    for (let i = 0; i < 70; i++) {
      fs.writeFileSync(path.join(dir, `f-${String(i).padStart(2, '0')}.bin`), 'data');
    }
    // 全部为文件（无目录），第 2 页从 offset=30 开始。
    const statSpy = vi.spyOn(fs, 'statSync');
    const result = buildLsCommand([], ctx, { cwd: dir, offset: LS_PAGE_SIZE });
    const labels = JSON.stringify(result.card);
    expect(labels).toContain('f-30.bin');
    expect(labels).not.toContain('f-00.bin');
    // stat 的路径都在目标目录且属于新页范围附近（数量 ≤ 页大小 + 固定开销）。
    const statTargets = statSpy.mock.calls.map((call) => String(call[0]));
    expect(statTargets.length).toBeLessThanOrEqual(LS_PAGE_SIZE + 10);
    expect(statTargets.some((p) => p.endsWith('f-30.bin'))).toBe(true);
    expect(statTargets.some((p) => p.endsWith('f-00.bin'))).toBe(false);
  });

  it('目录条目不需要 stat（Dirent 直接分类），文件大小缺失时不标 size', () => {
    const dir = makeTempDir('lark-ls-dirs-');
    for (let i = 0; i < 5; i++) {
      fs.mkdirSync(path.join(dir, `dir-${i}`));
    }
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');

    const statSpy = vi.spyOn(fs, 'statSync');
    const result = buildLsCommand([], ctx, { cwd: dir });
    const labels = JSON.stringify(result.card);
    expect(labels).toContain('dir-0');
    expect(labels).toContain('a.txt (5B)');
    // 1 目录 + 1 文件的目录：stat 次数个位数（inspectPath + 页内 1 文件）。
    expect(statSpy.mock.calls.length).toBeLessThanOrEqual(8);
  });
});
