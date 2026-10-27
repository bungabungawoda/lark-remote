/**
 * 模块依赖方向守卫（审计 #25-#28 落地的边，钉住不让反向长回来）。
 *
 * 每条被禁的边都真发生过：`config/index.ts` import runner 拿 `AgentKind`、
 * `session/dsh` import `runner/dsh/client` 只为拼一个 `args` 信封、
 * `card/run-renderer` import `router/usage-format`、`bridge` import
 * `router/card-helpers`。修法是把这些共享物搬到 `src/` 根的中立模块，
 * 于是反向边归零——但归零这件事以前只记在文档里，下一趟改动随时能悄悄加回来。
 *
 * 口径：只查 `src/<层>/**` 里的非测试文件，只看相对 import 的**目标层目录**；
 * `src/*.ts` 根上的中立模块（agent-kinds / session-contract / model-catalog）
 * 任何人都能 import，它们不在禁行表里。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.join(import.meta.dirname, '../../src');

/** 被禁的 import 边：from 层目录 → to 层目录。 */
const FORBIDDEN_EDGES: Array<{ from: string; to: string; note: string }> = [
  { from: 'session', to: 'runner', note: '#26：读取契约已下沉 src/session-contract.ts' },
  {
    from: 'runner',
    to: 'session',
    note: '#26：runner 的 reader 由构造器注入（src/index.ts 与 registry 共享同一实例），不 import 具体 session 层',
  },
  {
    from: 'config',
    to: 'runner',
    note: '#27：AgentKind 在 src/agent-kinds.ts，模型表在 src/model-catalog.ts',
  },
  { from: 'card', to: 'router', note: '#28：usage-format / card-helpers 归位 src/card/' },
  {
    from: 'card',
    to: 'bridge',
    note: 'card 是渲染层，不得为 bridge 的 ActiveRunSnapshot 反向依赖编排层',
  },
  { from: 'bridge', to: 'router', note: '#28：建卡共享工具归位 src/card/' },
];

function relativeSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...relativeSources(abs));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/** 一个 import 说明符落到哪个顶层模块（返回 '' 表示不是跨层相对 import）。 */
function importedTopModule(specifier: string, fromFile: string): string {
  if (!specifier.startsWith('.')) return '';
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const rel = path.relative(SRC_ROOT, resolved);
  if (rel.startsWith('..')) return '';
  return rel.split(path.sep)[0];
}

function edgesInto(fromLayer: string, toLayer: string): string[] {
  const layerDir = path.join(SRC_ROOT, fromLayer);
  if (!fs.existsSync(layerDir)) return [];
  const hits: string[] = [];
  for (const file of relativeSources(layerDir)) {
    const source = fs.readFileSync(file, 'utf-8');
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      if (importedTopModule(match[1]!, file) === toLayer) {
        hits.push(`${path.relative(SRC_ROOT, file)} → ${match[1]}`);
      }
    }
  }
  return hits;
}

describe('src 层间依赖方向', () => {
  for (const edge of FORBIDDEN_EDGES) {
    it(`src/${edge.from}/** 不得 import src/${edge.to}/**（${edge.note}）`, () => {
      expect(edgesInto(edge.from, edge.to)).toEqual([]);
    });
  }

  it('中立模块确实住在 src/ 根（反向边的替代方案，别搬回层里）', () => {
    for (const neutral of ['agent-kinds', 'session-contract', 'model-catalog']) {
      expect(fs.existsSync(path.join(SRC_ROOT, `${neutral}.ts`)), `${neutral}.ts`).toBe(true);
    }
  });
});
