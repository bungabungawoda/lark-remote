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
  /** 把固定 POSIX 绝对路径当**落盘位置**用的站点（见 fixedPathOffenders）。 */
  fixedPathSites: string[];
  /** 把固定 POSIX 绝对路径当 **cwd** 递给真实 spawn 的站点。 */
  fixedCwdSites: string[];
  /** 文件整体只在 posix 上跑（describePosix / skipIf(isWin32)）→ 允许 POSIX 路径。 */
  posixOnly: boolean;
  /** 文件 mock 掉了 spawn 出口 → cwd 只是断言数据，不触真文件系统。 */
  mocksSpawn: boolean;
};

/**
 * 固定 POSIX 绝对路径当落盘位置 —— 2026-09-22 实测出的 Windows 故障源。
 *
 * `/tmp` 这类**根绝对路径**在 win32 上没有盘符，`path.resolve('/tmp')` 会补成
 * 「当前盘符的 \tmp」，即仓库外的 `D:\tmp`。用它当落盘目录有三个叠加毛病：
 *   1. 仓库外、名字固定、跨进程共享 → 并行 worktree / 残留 worker 会抢写同一文件，
 *      win32 表现为 `EBUSY`（libuv 把 ERROR_SHARING_VIOLATION 映射成 EBUSY）；
 *   2. 不在 `os.tmpdir()` 下 → `sweepProjectTempDirs()` 兜底扫不到，残留永久留盘；
 *   3. 机器上恰好没有 `D:\tmp` 时，直接 ENOENT（见下面的 cwd 守卫）。
 *
 * 2026-09-22 首次暴雷：`src/update/version-check.test.ts` 把缓存写在
 * `path.join('/tmp', ...)`，全量并行时 1 例 EBUSY。收口后 `D:\tmp` 仍留有
 * `p2-16-test` / `p2-19-logger-test` / `spawning-runner-*` 等同源活残留。
 */
const WRITE_LOCATION_KEYS = [
  'pidDir',
  'pidFile',
  'logDir',
  'dir',
  'configPath',
  'workspacePath',
  'ordersPath',
  'cachePath',
  'statePath',
  'dbPath',
  'logPath',
] as const;

/** 位置类字段被先赋给常量、再传下去时，字面量落在赋值右侧。 */
const WRITE_LOCATION_VARS = [
  'pidDir',
  'logDir',
  'configDir',
  'PID_DIR',
  'LOG_DIR',
  'CONFIG_PATH',
  'WORKSPACE_PATH',
  'ORDERS_PATH',
  'CACHE_PATH',
  'STATE_PATH',
  'TMP_DIR',
] as const;

/** 把第一个参数当路径写盘的 fs API。 */
const FS_MUTATIONS = [
  'mkdirSync',
  'writeFileSync',
  'appendFileSync',
  'rmSync',
  'unlinkSync',
  'rmdirSync',
  'renameSync',
  'copyFileSync',
  'createWriteStream',
  'mkdtempSync',
] as const;

/** `/tmp` 或 `/tmp/<任意>`（不含引号）。 */
const POSIX_ABS = '/tmp(?:/[^\'"]*)?';

/** 会真正起进程、把 cwd 落到 shell/exec 上的调用。 */
const SPAWN_ENTRY_POINTS = ['run', 'runCompact', 'callSpawnChild'] as const;

/**
 * 行级白名单出口。个别站点必须写出「旧共享路径」这个字面量（例如断言
 * 「缓存路径不等于旧的固定共享路径」），那不是落盘点。放一个可 grep 的标记：
 *
 * ```ts
 * expect(cachePath).not.toBe(path.join('/tmp', 'x.json')); // temp-hygiene:allow-fixed-path
 * ```
 *
 * 标记写在命中行或其前一行都算。**不要**用它给真实的落盘点开后门 ——
 * 那等于把门禁关掉，只是看着绿。
 */
const ALLOW_MARKER = 'temp-hygiene:allow-fixed-path';

/**
 * 把注释替换成等长空白（**保留偏移**，行号不变）。
 *
 * 必要性：注释里经常引用这些字面量作为**反例**（本文件自己的文档就在写
 * `path.join('/tmp', ...)`），不剥掉就会把说明文字当成违规站点。
 * 字符串内的 `//` 会被正确忽略；模板字面量整体当字符串处理（本守卫匹配的字面量
 * 都带引号，模板串本来也不该被算落盘点）。
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out += c;
      i++;
      continue;
    }
    if (state === 'line') {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\n') state = 'code';
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    // 字符串内部
    if (c === '\\') {
      out += c + (next ?? '');
      i += 2;
      continue;
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
    }
    out += c;
    i++;
  }
  return out;
}

function collectSites(rawSource: string, patterns: string[][], label: string): string[] {
  const code = stripComments(rawSource);
  const lines = rawSource.split('\n');
  const found: string[] = [];
  for (const [pattern, kind] of patterns) {
    for (const match of code.matchAll(new RegExp(pattern, 'g'))) {
      const lineNo = code.slice(0, match.index).split('\n').length;
      const window = [lines[lineNo - 2] ?? '', lines[lineNo - 1] ?? ''].join('\n');
      if (window.includes(ALLOW_MARKER)) continue;
      found.push(`${label} L${lineNo} ${kind}: ${match[0].replace(/\s+/g, ' ')}`);
    }
  }
  return found;
}

/**
 * 静态守卫只能看出「字面量直接当路径用」，看不出变量里装的是什么 ——
 * 因此这里只覆盖直接字面量，间接传递（`const p = '/tmp/x'` 后再 `run(p)`）
 * 由 code review 兜。宁可漏一点，也不要造出会误伤别人的假阳性门禁。
 */
function fixedPathOffenders(source: string): string[] {
  return collectSites(
    source,
    [
      [`\\b(?:${WRITE_LOCATION_KEYS.join('|')})\\s*:\\s*['"](${POSIX_ABS})['"]`, '落盘字段字面量'],
      [`\\b(?:${WRITE_LOCATION_VARS.join('|')})\\s*=\\s*['"](${POSIX_ABS})['"]`, '位置常量字面量'],
      [`\\b(?:${FS_MUTATIONS.join('|')})\\s*\\(\\s*['"](${POSIX_ABS})['"]`, 'fs 调用字面量'],
      [`path\\.join\\(\\s*['"](${POSIX_ABS})['"]`, 'path.join 字面量'],
    ],
    'fixed-path',
  );
}

function fixedCwdOffenders(source: string): string[] {
  return collectSites(
    source,
    [
      [
        `\\.(?:${SPAWN_ENTRY_POINTS.join('|')})\\([^)]{0,140}?cwd:\\s*['"](${POSIX_ABS})['"]`,
        'cwd 字面量',
      ],
    ],
    'fixed-cwd',
  );
}

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
    fixedPathSites: fixedPathOffenders(source),
    fixedCwdSites: fixedCwdOffenders(source),
    posixOnly: /describePosix\(/.test(source),
    mocksSpawn: /vi\.mock\(\s*['"][^'"]*(?:node:child_process|platform\/spawn\.js)['"]/.test(
      source,
    ),
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

  it('不把固定 POSIX 绝对路径当落盘位置（win32 会解析成仓库外的 \\tmp，抢写/漏扫/ENOENT）', () => {
    const offenders = facts
      .filter((f) => !f.posixOnly)
      .flatMap((f) => f.fixedPathSites.map((site) => `${f.file} → ${site}`));
    expect(
      offenders,
      `固定 /tmp/... 在 win32 是「当前盘符的 \\tmp」：仓库外、跨进程共享、sweep 扫不到。` +
        `改写 makeTempDir()（见 tests/lib/temp-dir.ts），或把前缀登记进 OUR_TEMP_PREFIXES。`,
    ).toEqual([]);
  });

  it('不把固定 POSIX 绝对路径当 cwd 递给真实 spawn（机器上没有该目录时 ENOENT）', () => {
    // mock 掉 spawn 出口的文件里 cwd 只是断言数据，不触文件系统 —— 放行。
    const offenders = facts
      .filter((f) => !f.posixOnly && !f.mocksSpawn)
      .flatMap((f) => f.fixedCwdSites.map((site) => `${f.file} → ${site}`));
    expect(
      offenders,
      `cwd 传 '/tmp' 时进程真实 cwd 是 D:\\tmp：本机恰好存在才侥幸绿，干净机器上 spawn ENOENT。` +
        `改用本用例的 tmpDir（mkdtemp / makeTempDir）。`,
    ).toEqual([]);
  });
});
