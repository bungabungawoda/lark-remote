/**
 * Anchor: SpawningRunner 的 pid 文件名消毒与 hash 消歧。
 *
 * spawn 编排的继承关系已由 `src/runner/runner-structure.test.ts` 的静态守卫
 * 覆盖；这里只保留行为锚点：消毒结果相同的 cwd 不能共用 pid 文件。
 */
import { describe, it, expect } from 'vitest';
import { pidFileSuffix } from '../../../src/runner/common/spawning-runner.js';

// ---------------------------------------------------------------------------
// pidFileSuffix 消毒碰撞消歧（review 2026-10-07 回归锚）
//
// 修复前后缀只有「非字母数字 → _」消毒段：`/w/a+b` 与 `/w/a_b` 消毒结果相同，
// 两个 workspace 共用一个 pid 文件——killOrphan 的身份校验只比对二进制名，
// 启动时可能误杀对方 workspace 存活的同名 agent。hash 段按原始 cwd 计算。
// ---------------------------------------------------------------------------
describe('pidFileSuffix', () => {
  it('消毒结果相同的 cwd 产出不同 pid 文件名（hash 段区分）', () => {
    expect(pidFileSuffix('/w/a+b')).not.toBe(pidFileSuffix('/w/a_b'));
    expect(pidFileSuffix('/w/a+b')).toBe(pidFileSuffix('/w/a+b'));
    expect(pidFileSuffix('/w/a+b').startsWith('-_w_a_b-')).toBe(true);
  });

  it('深 cwd 消毒段截断到 96 字符，仍靠 hash 段保持唯一', () => {
    const deep = `/w/${'x'.repeat(200)}`;
    const deep2 = `/w/${'x'.repeat(199)}y`;
    const s1 = pidFileSuffix(deep);
    expect(s1.length).toBeLessThan(120);
    expect(s1).not.toBe(pidFileSuffix(deep2));
  });
});
