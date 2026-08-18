/**
 * Anchor Test: P1-9 — index.ts 各 agent 工厂必须把 workspace 透传给 runner
 *
 * ① 验证什么行为：
 *   src/index.ts 中 claude / pi 两个 spawn 型 agent 工厂必须把 registry 传入的
 *   workspace 参数以 `workspace: ws` 形式透传给各自的 runner 构造，使 pid 文件
 *   按 workspace 隔离。codex / opencode / kimi 是 ACP/app-server（workspace
 *   生命周期持久连接，workspace 由 ConnectionManager 按工作目录 spawn），不走
 *   pid 文件，工厂不接收 workspace（参数为 `_ws`）。
 *
 * ② 缺失/错误会导致什么问题：
 *    runner 侧已支持 workspace 选项，但 index.ts 工厂如果不传 workspace——
 *    生产 wiring 不接上，pid 文件依旧全局共享，workspace B 的 killOrphan
 *    照旧误杀 workspace A 的 run（review §P1-9 修复建议②：「src/index.ts
 *    工厂统一接收 (ws) 并传 workspace: ws」）。
 *
 * ③ 依据：P1-15 修复后 claude 工厂也改用 registry 模式（从 configContainer
 *   读取最新配置），与 pi 一致。两工厂各传 `workspace: ws` → 恰好 2 次。
 *   注：index.ts 的 initializeRunner 不导出、工厂闭包不可注入测试，故用源码级
 *   守卫（项目已有先例：kimi-runner-stream-error 对 runner.ts 源码断言）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const indexSource = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');

describe('P1-9: index.ts factory workspace wiring', () => {
  it('test_anchor_index_factories_pass_workspace_to_all_runners', () => {
    // 两工厂（claude/pi）各传 `workspace: ws` → 恰好 2 次。
    const occurrences = indexSource.match(/workspace:\s*ws/g) ?? [];
    expect(occurrences).toHaveLength(2);
    // opencode/kimi 为纯 ACP：注册 ACP runner，workspace 不经 pid 文件透传。
    expect(indexSource).toMatch(/register\('opencode'[\s\S]*?new OpencodeAcpRunner\(/);
    expect(indexSource).toMatch(/register\('kimi'[\s\S]*?new KimiAcpRunner\(/);
  });
});
