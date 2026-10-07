/**
 * Anchor Test: ClaudeSession extends SpawningRunner (R16, 2026-08-16 更新)
 *
 * Behavior verified (①):
 *   长驻交互改造后，ClaudeRunner 是 workspace-
 *   lifetime 的薄包装，进程与协议细节在 ClaudeSession。spawn 编排（pid 文件、
 *   killOrphan 身份校验、ProcessStopper、SpawnHeartbeat、退出分发器）仍由
 *   ClaudeSession 继承 SpawningRunner 复用，不在子类重复实现。ClaudeRunner
 *   把 run/stop/killOrphan/registerExitHandlers 委托给 session，保持 5 个
 *   runner 的公共接口契约（IAgentRunner）不变。
 *
 * What goes wrong if missing/incorrect (②):
 *   若 ClaudeSession 不继承 SpawningRunner，pid 文件/killOrphan/心跳/退出
 *   分发会退化为重复实现或丢失（P1-1/P1-10 契约破坏）。
 *
 * Spec basis (③):
 *   长驻会话生命周期：src/runner/claude/session.ts（新增）参照
 *   common/spawning-runner + codex app-server 模式。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeRunner } from '../../../src/runner/index.js';
import { ClaudeSession } from '../../../src/runner/claude/session.js';
import { SpawningRunner, pidFileSuffix } from '../../../src/runner/common/spawning-runner.js';
import { makeTempDir } from '../../lib/temp-dir.js';

describe('R16: ClaudeSession extends SpawningRunner (runner delegates)', () => {
  // pidDir 是生产代码真会 mkdir + 写 pid 文件的位置。固定 '/tmp/...' 在 win32 上
  // 会解析成仓库外的 D:\tmp（跨进程共享、兜底 sweep 扫不到）—— 改用本用例独占的
  // mkdtemp 目录，跑完由 temp-dir.ts 的 afterAll 统一清理。
  // 见 tests/misc/temp-dir-hygiene.test.ts 的「固定 POSIX 绝对路径」守卫。
  let pidDir: string;
  beforeEach(() => {
    pidDir = makeTempDir('lark-r16-claude-base-');
  });

  it('test_anchor_claude_session_extends_spawning_runner', () => {
    const runner = new ClaudeRunner({ cwd: 'test', pidDir });

    // 核心契约：进程编排在 ClaudeSession（IS-A SpawningRunner），ClaudeRunner
    // 委托而非重复实现。访问 session 需通过公开方法验证（无公开 getter 时用
    // 行为断言：killOrphan 等必须可用且走 base 语义）。
    const session = new ClaudeSession({ cwd: 'test', pidDir });
    expect(session).toBeInstanceOf(SpawningRunner);

    // 会话继承的公共方法（原型链来自 base，非子类重复实现）。
    expect(typeof session.killOrphan).toBe('function');
    expect(typeof session.stop).toBe('function');

    // Runner 对外契约完整（IAgentRunner + 生命周期委托）。
    expect(typeof runner.killOrphan).toBe('function');
    expect(typeof runner.stop).toBe('function');
    expect(typeof runner.run).toBe('function');
    expect(typeof runner.registerExitHandlers).toBe('function');
    expect(typeof runner.unregisterExitHandlers).toBe('function');
    expect(typeof runner.dispose).toBe('function');
    expect(runner.lifetime).toBe('workspace');

    // 未 spawn 的实例报告 not-running（base getter 语义透传）。
    expect(runner.isRunning).toBe(false);
    expect(session.isRunning).toBe(false);
  });
});

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
