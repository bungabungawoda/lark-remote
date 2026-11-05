/**
 * 结构等价拆分 characterization（router 命令层）。
 *
 * 直接调用 buildWsCommand / buildLsCommand / buildOrderCommand 的公共出口，
 * 用外部快照钉住**完整输出**（卡片元素形状、文案、callback payload 字段与
 * 顺序、分页栏、副作用调用记录）。快照由 `vitest -u` 从当前实现生成；
 * 拆分后不带 -u 重跑，快照必须逐字不变。
 *
 * 动态值（临时目录绝对路径及其父目录、路径分隔符、文件 mtime）在 norm() 里
 * 归一化，快照必须与宿主 OS 无关：同一份卡片在 macOS / Linux / Windows 三处
 * CI 与本机都要逐字一致。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWsCommand, type WsCommandDeps } from '../../src/router/commands/ws.js';
import { buildLsCommand } from '../../src/router/commands/ls.js';
import { buildOrderCommand, type OrderCommandDeps } from '../../src/router/commands/order.js';
import type { WorkspaceEntry } from '../../src/workspace/index.js';
import type { OrderEntry } from '../../src/order/index.js';

const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };

const tmpDirs: string[] = [];
/** 临时目录的父目录（卡片「上级」按钮指向它），与 tmpDir 一样是宿主专属路径。 */
const tmpParents: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-')));
  tmpDirs.push(d);
  const parent = path.dirname(d);
  if (!tmpParents.includes(parent)) tmpParents.unshift(parent);
  return d;
}

/**
 * 归一化动态值：临时目录及其父目录、win32 反斜杠、随机目录名、文件 mtime。
 * 三者缺一个，快照就只在生成它的那台宿主上成立——同一份卡片内容在 macOS 是
 * `/private/var/folders/…/T`、Linux 是 `/tmp`、win32 是 `C:\Users\…\Temp`。
 */
function normPathStr(s: string): string {
  for (const d of tmpDirs) s = s.replaceAll(d, '<TMP>');

  for (const p of tmpParents) s = s.replaceAll(p, '<TMPROOT>');
  return s
    .replaceAll(path.sep, '/')
    .replace(/equiv-[A-Za-z0-9]+/g, '<TMPNAME>')
    .replace(/修改时间: .*/g, '修改时间: <MTIME>');
}

/** 深度替换字符串叶子（在 JSON.stringify 之前，故 `\` 只可能是路径分隔符）。 */
function normValue(x: unknown): unknown {
  if (typeof x === 'string') return normPathStr(x);
  if (Array.isArray(x)) return x.map(normValue);
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, normValue(v)]));
  }
  return x;
}

/** 序列化归一化结果（快照跨 macOS / Linux / Windows 稳定）。 */
function norm(x: unknown): string {
  const s = JSON.stringify(normValue(x));
  // 比对也要按归一后的分隔符形态来，否则 win32 的宿主路径永远查不出来。
  const hosts = [...tmpDirs, ...tmpParents, os.tmpdir()].map((p) => p.replaceAll(path.sep, '/'));
  const leak = hosts.find((p) => s.includes(p));
  if (leak) throw new Error(`norm() 漏归一宿主路径：${leak}`);
  return s;
}

// ── /ws ────────────────────────────────────────────────────────────────────

const WS_ROWS = [
  { name: 'alpha', path: '/repo/alpha', lastUsedAt: 1700000000000 },
  { name: 'beta', path: '/repo/beta', lastUsedAt: 1700000000001 },
  { name: 'zeta', path: '/repo/zeta', lastUsedAt: 1700000000002 },
] as unknown as WorkspaceEntry[];

function makeWsDeps(overrides: Partial<WsCommandDeps> = {}): WsCommandDeps & { calls: string[] } {
  const calls: string[] = [];
  const rows = WS_ROWS.map((r) => ({ ...r }));
  const byName = new Map(rows.map((r) => [r.name, r.path]));
  return {
    calls,
    getCwd: () => '/fixture/cwd',
    saveWorkspace: (name, cwd) => {
      calls.push(`save:${name}:${cwd}`);
    },
    getWorkspace: (name) => byName.get(name),
    hasWorkspace: (name) => byName.has(name),
    removeWorkspace: (name) => {
      calls.push(`remove:${name}`);
      byName.delete(name);
    },
    touchWorkspace: (name) => {
      calls.push(`touch:${name}`);
    },
    listWorkspaces: () => rows.map((r) => ({ ...r })),
    getSortMode: () => 'recent',
    switchCwd: (_userId, cwd) => ({ text: `switched:${cwd}` }),
    ...overrides,
  };
}

describe('structure equivalence: buildWsCommand', () => {
  it('save 分支', () => {
    const deps = makeWsDeps();
    expect(
      norm({ r: buildWsCommand(['save', 'proj'], ctx, 0, undefined, deps), calls: deps.calls }),
    ).toMatchSnapshot();
    expect(norm(buildWsCommand(['save'], ctx, 0, undefined, makeWsDeps()))).toMatchSnapshot();
  });

  it('use 分支（存在 / 不存在 / 指向文件）', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'afile'), 'x');
    const deps = makeWsDeps({
      getWorkspace: (name) =>
        name === 'ok' ? root : name === 'file' ? path.join(root, 'afile') : undefined,
    });
    expect(
      norm({ r: buildWsCommand(['use', 'ok'], ctx, 0, undefined, deps), calls: deps.calls }),
    ).toMatchSnapshot();
    expect(norm(buildWsCommand(['use', 'nope'], ctx, 0, undefined, deps))).toMatchSnapshot();
    expect(norm(buildWsCommand(['use', 'file'], ctx, 0, undefined, deps))).toMatchSnapshot();
    expect(norm(buildWsCommand(['use'], ctx, 0, undefined, deps))).toMatchSnapshot();
  });

  it('remove 分支', () => {
    const deps = makeWsDeps();
    expect(
      norm({ r: buildWsCommand(['remove', 'alpha'], ctx, 0, undefined, deps), calls: deps.calls }),
    ).toMatchSnapshot();
    expect(
      norm(buildWsCommand(['remove', 'ghost'], ctx, 0, undefined, makeWsDeps())),
    ).toMatchSnapshot();
    expect(norm(buildWsCommand(['remove'], ctx, 0, undefined, makeWsDeps()))).toMatchSnapshot();
  });

  it('默认 list 分支（无 sub / list / 未知 / 大写）', () => {
    expect(norm(buildWsCommand([], ctx, 0, undefined, makeWsDeps()))).toMatchSnapshot();
    expect(norm(buildWsCommand(['list'], ctx, 0, undefined, makeWsDeps()))).toMatchSnapshot();
    expect(norm(buildWsCommand(['zoom'], ctx, 0, undefined, makeWsDeps()))).toMatchSnapshot();
    expect(norm(buildWsCommand(['LIST'], ctx, 0, undefined, makeWsDeps()))).toMatchSnapshot();
  });

  it('list + 筛选（命中 / 无匹配 / 清除）', () => {
    expect(norm(buildWsCommand([], ctx, 0, 'beta', makeWsDeps()))).toMatchSnapshot();
    expect(norm(buildWsCommand([], ctx, 0, 'zzz', makeWsDeps()))).toMatchSnapshot();
    expect(norm(buildWsCommand([], ctx, 0, '  ', makeWsDeps()))).toMatchSnapshot();
  });

  it('list + 分页 + alpha 排序', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      name: `ws${i}`,
      path: `/repo/ws${i}`,
      lastUsedAt: 1700000000000 + i,
    })) as unknown as WorkspaceEntry[];
    const deps = makeWsDeps({
      listWorkspaces: () => many.map((r) => ({ ...r })),
      getSortMode: () => 'alpha',
    });
    expect(norm(buildWsCommand([], ctx, 5, undefined, deps))).toMatchSnapshot();
  });
});

// ── /order ─────────────────────────────────────────────────────────────────

const ORDER_ROWS = [
  { id: 'o1', text: 'echo one', alias: 'one' },
  { id: 'o2', text: 'echo two' },
  { id: 'o3', text: 'x'.repeat(150), alias: 'three' },
] as unknown as OrderEntry[];

function makeOrderDeps(): OrderCommandDeps & { calls: string[] } {
  const calls: string[] = [];
  const rows = ORDER_ROWS.map((r) => ({ ...r }));
  return {
    calls,
    reload: () => {
      calls.push('reload');
    },
    list: () => rows.map((r) => ({ ...r })),
    save: (text) => {
      calls.push(`save:${text}`);
    },
    updateText: (id, text) => {
      calls.push(`updateText:${id}:${text}`);
    },
    setAlias: (id, alias) => {
      calls.push(`setAlias:${id}:${alias ?? ''}`);
    },
    resolveTarget: (target) => rows.find((r) => r.id === target) ?? rows[Number(target) - 1],
  };
}

function orderCase(args: string[]): string {
  const deps = makeOrderDeps();
  return norm({ args, r: buildOrderCommand(args, ctx, 0, deps), calls: deps.calls });
}

describe('structure equivalence: buildOrderCommand', () => {
  it('list 默认 / 显式 / 大写 / 未知 sub', () => {
    expect(orderCase([])).toMatchSnapshot();
    expect(orderCase(['list'])).toMatchSnapshot();
    expect(orderCase(['LIST'])).toMatchSnapshot();
    expect(orderCase(['zoom'])).toMatchSnapshot();
  });

  it('save 分支', () => {
    expect(orderCase(['save', 'hello', 'world'])).toMatchSnapshot();
    expect(orderCase(['save'])).toMatchSnapshot();
  });

  it('edit 分支', () => {
    expect(orderCase(['edit', 'o2', 'new text'])).toMatchSnapshot();
    expect(orderCase(['edit', '1'])).toMatchSnapshot();
    expect(orderCase(['edit', 'ghost', 'x'])).toMatchSnapshot();
  });

  it('alias 分支（add / rm / list / 缺参 / 未知）', () => {
    expect(orderCase(['alias', 'add', 'o2', 'two'])).toMatchSnapshot();
    expect(orderCase(['alias', 'add', 'o2'])).toMatchSnapshot();
    expect(orderCase(['alias', 'add', 'ghost', 'x'])).toMatchSnapshot();
    expect(orderCase(['alias', 'rm', 'o1'])).toMatchSnapshot();
    expect(orderCase(['alias', 'rm', 'o2'])).toMatchSnapshot();
    expect(orderCase(['alias', 'rm', 'ghost'])).toMatchSnapshot();
    expect(orderCase(['alias'])).toMatchSnapshot();
    expect(orderCase(['alias', 'list'])).toMatchSnapshot();
    expect(orderCase(['alias', 'zoom'])).toMatchSnapshot();
  });
});

// ── /ls ────────────────────────────────────────────────────────────────────

function makeLsTree(): string {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'adir'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bdir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'f1.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'f2.txt'), 'world!!');
  return root;
}

describe('structure equivalence: buildLsCommand', () => {
  it('无 cwd → 提示文本', () => {
    expect(norm(buildLsCommand([], ctx, {}))).toMatchSnapshot();
  });

  it('列目录（默认 / 筛选命中 / 筛选无匹配）', () => {
    const root = makeLsTree();
    expect(norm(buildLsCommand([], ctx, { cwd: root }))).toMatchSnapshot();
    expect(norm(buildLsCommand([], ctx, { cwd: root, q: 'f1' }))).toMatchSnapshot();
    expect(norm(buildLsCommand([], ctx, { cwd: root, q: 'zzz' }))).toMatchSnapshot();
  });

  it('root 全程透传', () => {
    const root = makeLsTree();
    expect(
      norm(buildLsCommand([], ctx, { cwd: root, rootDir: path.join(root, 'adir') })),
    ).toMatchSnapshot();
  });

  it('args 指向文件 / 指向不存在', () => {
    const root = makeLsTree();
    expect(norm(buildLsCommand(['f1.txt'], ctx, { cwd: root }))).toMatchSnapshot();
    expect(norm(buildLsCommand(['ghost'], ctx, { cwd: root }))).toMatchSnapshot();
  });

  it('分页（35 个文件，offset=30）', () => {
    const root = tmp();
    for (let i = 0; i < 35; i++)
      fs.writeFileSync(path.join(root, `f${String(i).padStart(2, '0')}.txt`), 'x');
    expect(norm(buildLsCommand([], ctx, { cwd: root, offset: 30 }))).toMatchSnapshot();
  });
});
