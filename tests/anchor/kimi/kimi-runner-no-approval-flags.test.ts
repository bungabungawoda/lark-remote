/**
 * Anchor Test: KimiRunner buildArgv 不再传 --auto/--yolo（kimi 0.26+ 互斥修复）
 *
 * Behavior verified (①):
 *   kimi 0.26+ 的 `-p`（非交互 prompt）模式与 `--auto`/`--yolo` 互斥，
 *   CLI 会以 "Cannot combine --prompt with --auto" 立即报错退出。
 *   KimiRunner 始终使用 `-p` 模式，因此 buildArgv 绝不能传 --auto/--yolo。
 *   同时 KimiRunnerConfig.approvalMode 字段应被移除（非交互模式无权限概念）。
 *
 * What goes wrong if missing/incorrect (②):
 *   每次 kimi 调用都 exit=1 报错，kimi 完全不可用。
 *
 * Spec basis (③):
 *   kimi 0.26 CLI 破坏性变更：-p 与 --auto/--yolo 互斥。
 *   非交互单次运行无权限审批循环，权限 flag 无意义。
 */
import { describe, it, expect, vi } from 'vitest';
import { KimiRunner } from '../../../src/runner/kimi/index.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

describe('KimiRunner buildArgv: no --auto/--yolo flags (kimi 0.26+ compatibility)', () => {
  it('buildArgv does NOT include --auto', () => {
    const runner = new KimiRunner({ workspace: 'test', binary: 'kimi' });
    (runner as any).currentMessage = 'hello';
    const args = (runner as any).buildArgv({ cwd: '/tmp' });
    expect(args).not.toContain('--auto');
  });

  it('buildArgv does NOT include --yolo', () => {
    const runner = new KimiRunner({ workspace: 'test', binary: 'kimi' });
    (runner as any).currentMessage = 'hello';
    const args = (runner as any).buildArgv({ cwd: '/tmp' });
    expect(args).not.toContain('--yolo');
  });

  it('KimiRunnerConfig does not accept approvalMode', () => {
    // approvalMode 字段应从 config interface 中移除
    // 如果类型仍然存在，以下代码不会在编译时报错
    // 我们用运行时检查验证：构造函数忽略 approvalMode
    const runner = new KimiRunner({ workspace: 'test', binary: 'kimi' } as any);
    // approvalMode 不应作为实例属性存在
    expect((runner as any).approvalMode).toBeUndefined();
  });

  it('buildArgv still includes required flags (-p, --output-format, -m)', () => {
    const runner = new KimiRunner({ workspace: 'test', binary: 'kimi', model: 'kimi-code/k3' });
    (runner as any).currentMessage = 'hello';
    const args = (runner as any).buildArgv({ cwd: '/tmp' });

    expect(args).toContain('-p');
    expect(args).toContain('hello');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('-m');
    expect(args).toContain('kimi-code/k3');
  });

  it('buildArgv includes -r when sessionId is provided', () => {
    const runner = new KimiRunner({ workspace: 'test', binary: 'kimi' });
    (runner as any).currentMessage = 'hello';
    const args = (runner as any).buildArgv({ cwd: '/tmp', sessionId: 'sess-123' });
    expect(args).toContain('-r');
    expect(args).toContain('sess-123');
    expect(args).not.toContain('--auto');
  });
});
