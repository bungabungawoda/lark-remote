/**
 * 测试临时目录与磁盘写入的架构守卫。
 *
 * 为什么值得写静态测试（对照 dev-workflow「结构型静态测试只保留架构守卫」）：
 * 这三条都是编译器拦不住的不变量，且违反时的症状是**静默**的 —— 泄漏要到
 * %TEMP% 攒到 2.5 GB 才被发现，多写 246 MiB 零字节只会让回归慢一点没人追问。
 * 2026-09-22 实测过这两笔账，这里把它钉成门禁。
 *
 * 分工（详见 tests/lib/temp-dir.ts 顶部说明）：
 *   主动线 makeTempDir() + afterAll —— 登记即清；
 *   兜底   sweepProjectTempDirs()  —— 覆盖被强杀/超时、钩子根本没跑的场景。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { OUR_TEMP_PREFIXES } from '../lib/tmp-cleanup.js';

/** 收集 src/ 与 tests/ 下全部测试文件（跳过依赖与嵌套 worktree）。 */
function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.worktrees', '.git', 'coverage'].includes(entry.name)) continue;
      collectTestFiles(full, out);
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const ROOT = process.cwd();
const testFiles = [...collectTestFiles('src'), ...collectTestFiles('tests')];

type FileFacts = {
  file: string;
  source: string;
  /** 该文件在 os.tmpdir() 下创建的目录字面量前缀（不含嵌套创建的子目录）。 */
  tmpRootPrefixes: string[];
  usesMakeTempDir: boolean;
  hasCleanupCall: boolean;
};

/**
 * `mkdtempSync(path.join(os.tmpdir(), 'x-'))` 才算「在临时根下建目录」；
 * `mkdtempSync(path.join(tmpRoot, 'kimi'))` 这种建在已登记目录里的不算 ——
 * 它随父目录一起被回收，不需要单独的前缀覆盖。
 */
function readFacts(file: string): FileFacts {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const tmpRootPrefixes: string[] = [];
  for (const call of source.matchAll(/mkdtempSync\(([^)]*tmpdir\(\)[^)]*),\s*['"]([^'"]+)['"]/g)) {
    tmpRootPrefixes.push(call[2]);
  }
  for (const call of source.matchAll(/makeTempDir\(\s*['"]([^'"]+)['"]/g)) {
    tmpRootPrefixes.push(call[1]);
  }
  return {
    file,
    source,
    tmpRootPrefixes,
    usesMakeTempDir: /makeTempDir\(/.test(source),
    hasCleanupCall: /rmRf\(|rmSync\(/.test(source),
  };
}

const facts = testFiles.map(readFacts);
const creating = facts.filter((f) => f.tmpRootPrefixes.length > 0);
const allPrefixes = creating.flatMap((f) => f.tmpRootPrefixes);

/**
 * 找出 MiB 量级的内存分配（`Buffer.alloc` / `allocUnsafe` / `new Uint8Array`）。
 *
 * 按括号配对取实参而不是按行匹配：原来 `media.test.ts` 的 101 MiB 写法就是
 * `writeFileSync(` 与 `Buffer.alloc(` 分处三行，按行匹配对它是盲的 —— 那样
 * 的守卫等于没有。
 */
function findMibAllocations(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(Buffer\.alloc|Buffer\.allocUnsafe|new Uint8Array)\s*\(/g)) {
    let cursor = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let arg = '';
    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === '(') depth++;
      else if (char === ')') depth--;
      if (depth > 0) arg += char;
      cursor++;
    }
    if (/\d+\s*\*\s*1024\s*\*\s*1024/.test(arg) || /\b[1-9]\d{6,}\b/.test(arg)) {
      found.push(`${match[1]}(${arg.trim().slice(0, 60)})`);
    }
  }
  return found;
}

describe('测试临时目录卫生守卫', () => {
  it('扫描范围非空（守卫自身退化成恒真时必须先红）', () => {
    expect(testFiles.length).toBeGreaterThan(300);
    expect(creating.length).toBeGreaterThan(100);
    expect(OUR_TEMP_PREFIXES.length).toBeGreaterThan(0);
  });

  it('不存在「建了临时根目录、却既不登记也不自清」的测试文件', () => {
    const unowned = creating
      .filter((f) => !f.usesMakeTempDir && !f.hasCleanupCall)
      .map((f) => f.file);
    expect(
      unowned,
      `这些文件在 os.tmpdir() 下建目录但没人删它：改用 makeTempDir()，或把前缀加进 OUR_TEMP_PREFIXES`,
    ).toEqual([]);
  });

  it('OUR_TEMP_PREFIXES 里没有已失效的前缀', () => {
    // 兜底扫描按前缀删目录；清单里留死条目说明测试已经改名/删掉，
    // 而改名后的新前缀大概率根本没进清单 —— 这正是漂移的信号。
    const dead = OUR_TEMP_PREFIXES.filter(
      (prefix) => !allPrefixes.some((created) => created.startsWith(prefix)),
    );
    expect(dead, `这些 sweep 前缀仓库里已无人创建，删掉或补回对应测试`).toEqual([]);
  });

  it('测试不分配 MiB 量级的缓冲（要大文件用 writeSizedFile，要大字符串用 repeat）', () => {
    // 生产侧 30MB 门禁读的是 stat.size，稀疏文件完全等价；改前 7 处
    // `Buffer.alloc(N * 1024 * 1024)` 每轮全量白写 246 MiB 零字节。
    const offenders: string[] = [];
    for (const f of facts) {
      for (const alloc of findMibAllocations(f.source)) {
        offenders.push(`${f.file} → ${alloc}`);
      }
    }
    expect(
      offenders,
      `落盘换 tests/lib/sized-file.ts 的 writeSizedFile()；内存里要大字符串用 'x'.repeat(n)`,
    ).toEqual([]);
  });
});
