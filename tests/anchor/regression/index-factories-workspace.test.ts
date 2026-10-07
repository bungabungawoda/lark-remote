/**
 * index.ts 各 agent 工厂必须把 cwd 透传给 runner
 *
 * ① 验证什么行为：
 *   src/index.ts 中 claude / pi 两个 spawn 型 agent 工厂必须把 registry 传入的
 *   cwd 参数以 `cwd: ws` 形式透传给各自的 runner 构造，使 pid 文件
 *   按 cwd 隔离。codex / opencode / kimi 是 ACP/app-server（cwd
 *   生命周期持久连接，cwd 由 ConnectionManager 按工作目录 spawn），不走
 *   pid 文件，工厂不接收 cwd（参数为 `_ws`）。
 *
 * ② 缺失/错误会导致什么问题：
 *    runner 侧已支持 cwd 选项，但 index.ts 工厂如果不传 cwd——
 *    生产 wiring 不接上，pid 文件依旧全局共享，cwd B 的 killOrphan
 *    照旧误杀 cwd A 的 run（「src/index.ts
 *    工厂统一接收 (ws) 并传 cwd: ws」）。
 *
 * ③ 依据：修复后 claude 工厂也改用 registry 模式（从 configContainer
 *   读取最新配置），与 pi 一致。两工厂各传 `cwd: ws` → 恰好 2 次。
 *   注：index.ts 的 initializeRunner 不导出、工厂闭包不可注入测试，故用源码级
 *   守卫（项目已有先例：kimi-runner-stream-error 对 runner.ts 源码断言）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const indexSource = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');

describe('index.ts factory cwd wiring', () => {
  it('test_anchor_index_factories_pass_workspace_to_all_runners', () => {
    // 两工厂（claude/pi）各传 `cwd: ws` → 恰好 2 次。
    const occurrences = indexSource.match(/cwd:\s*ws/g) ?? [];
    expect(occurrences).toHaveLength(2);
    // opencode/kimi 为纯 ACP：注册 ACP runner，cwd 不经 pid 文件透传。
    expect(indexSource).toMatch(/register\('opencode'[\s\S]*?new OpencodeAcpRunner\(/);
    expect(indexSource).toMatch(/register\('kimi'[\s\S]*?new KimiAcpRunner\(/);
  });
});
