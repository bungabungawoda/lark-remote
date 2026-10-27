/**
 * /config 卡片的「控件 ↔ 处理端」一致性守卫（第一原则：卡片只放配得了的控件）。
 *
 * 2026-10-27 删掉整套 boolean 开关时发现：控件形态、渲染端、router 处理分支、
 * 串行名单是四个地方，以前没有任何东西把它们钉在一起。曾经就出现过
 * 「boolean 已无人声明但按钮还渲染得出来」的状态——一旦有人声明它，点下去的
 * 行为取决于别人有没有记得补 handler。
 *
 * 静态读源码，不调 builder：opencode 的 buildFields 会 execSync 真二进制，
 * 那是项目红线（测试禁止 spawn 真 coding agent）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = import.meta.dirname; // src/router/config
const renderSource = fs.readFileSync(path.join(SRC, 'common/render.ts'), 'utf-8');
const typesSource = fs.readFileSync(path.join(SRC, 'types.ts'), 'utf-8');
const routerSource = fs.readFileSync(path.join(SRC, '../index.ts'), 'utf-8');

/** `ConfigField.type` 声明支持的控件形态。 */
const declaredTypes = (typesSource.match(/type:\s*((?:'[a-z]+'\s*\|?\s*)+)/)![1] ?? '')
  .split('|')
  .map((s) => s.trim().replace(/'/g, ''))
  .filter(Boolean);

/** render.ts 里真正实现了 builder 的形态（含无分支的兜底 input）。 */
const implementedTypes = [
  ...[...renderSource.matchAll(/field\.type === '([a-z]+)'/g)].map((m) => m[1]!),
  // else 分支的兜底控件
  'input',
];

/** render.ts 会发出去的 cardAction cmd。 */
const emittedCmds = [...renderSource.matchAll(/cmd:\s*'(config\.[a-z]+)'/g)].map((m) => m[1]!);

/** router 的 config.* 处理分支。 */
const handledCmds = [...routerSource.matchAll(/case '(config\.[a-z]+)':/g)].map((m) => m[1]!);

/** router 的即时（不进串行队列）名单。 */
const immediateCmds = [
  ...(
    routerSource.match(/const IMMEDIATE_ACTION_CMDS[\s\S]*?=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] ??
    ''
  ).matchAll(/'(config\.[a-z]+)'/g),
].map((m) => m[1]!);

describe('/config 卡片控件一致性', () => {
  it('声明的每种控件形态都有对应 builder', () => {
    expect(declaredTypes.length).toBeGreaterThan(0);
    expect(declaredTypes.filter((t) => !implementedTypes.includes(t))).toEqual([]);
  });

  it('渲染出去的每个 cmd 都有 router 处理分支（禁「按钮渲染得出、点了没人处理」）', () => {
    expect(emittedCmds.length).toBeGreaterThan(0);
    expect(emittedCmds.filter((cmd) => !handledCmds.includes(cmd))).toEqual([]);
  });

  it('config.* 控件动作全部在即时名单里（否则连击会排在串行队列后卡死，2026-07-04）', () => {
    expect(immediateCmds.length).toBeGreaterThan(0);
    expect(emittedCmds.filter((cmd) => !immediateCmds.includes(cmd))).toEqual([]);
  });

  it('boolean/config.toggle 这套控件已经成套删除，不许只长回来一半', () => {
    expect(declaredTypes).not.toContain('boolean');
    expect(renderSource).not.toMatch(/config\.toggle|buildBooleanElement/);
    expect(handledCmds).not.toContain('config.toggle');
  });
});
