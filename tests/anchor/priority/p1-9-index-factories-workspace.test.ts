/**
 * Anchor Test: P1-9 — index.ts 五个 agent 工厂必须把 workspace 透传给 runner
 *
 * ① 验证什么行为：
 *   src/index.ts 中 claude / codex / opencode / pi / kimi 五个 agent 工厂必须把
 *   registry 传入的 workspace 参数以 `workspace: ws` 形式透传给各自的 runner
 *   构造，使 pid 文件按 workspace 隔离。
 *
 * ② 缺失/错误会导致什么问题：
 *    runner 侧已支持 workspace 选项（Round 1/2 已修 codex/opencode，pi/kimi
 *    构造本来支持），但 index.ts 工厂如果不传 workspace——生产 wiring 不接上，
 *    pid 文件依旧全局共享，workspace B 的 killOrphan 照旧误杀 workspace A 的
 *    run（review §P1-9 修复建议②：「src/index.ts 工厂统一接收 (ws) 并传
 *    workspace: ws」）。
 *
 * ③ 依据：P1-15 修复后 claude 工厂也改用 registry 模式（从 configContainer 读取
 *   最新配置），与其他四个 agent 一致。五工厂各传 `workspace: ws` → 恰好 5 次。
 *   注：index.ts 的 initializeRunner 不导出、工厂闭包不可注入测试，故用源码级
 *   守卫（项目已有先例：kimi-runner-stream-error 对 runner.ts 源码断言）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const indexSource = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');

describe('P1-9: index.ts factory workspace wiring', () => {
  it('test_anchor_index_factories_pass_workspace_to_all_runners', () => {
    // 五工厂（claude/codex/opencode/pi/kimi）各传 `workspace: ws` → 恰好 5 次。
    const occurrences = indexSource.match(/workspace:\s*ws/g) ?? [];
    expect(occurrences).toHaveLength(5);
  });
});
