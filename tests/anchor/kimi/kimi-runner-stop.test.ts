/**
 * Anchor Test: KimiRunner.stop() 语义正确性
 *
 * 验证 KimiRunner.stop() 的 immediate 参数与 ProcessStopper 之间传递正确，
 * 不发生语义反转。
 *
 * Bug 描述：当前代码 `const graceful = !opts?.immediate; await stopper.stop(proc, { immediate: graceful })`
 * 当 immediate=true 时，graceful=false，传入 stopper.stop({immediate:false}) 反而走优雅关闭。
 * 对比 PiRunner 正确实现：`await stopper.stop(proc, { immediate: opts?.immediate })`。
 *
 * 重要性：用户 /stop 命令或超时场景需要立即杀死进程，语义反转会导致无法立即停止。
 *
 * Spec basis：AgentRunner.stop(opts?) 接口语义——immediate=true 表示立即终止，
 * 不可延迟等待；与 PiRunner 行为对齐。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
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

describe('KimiRunner.stop() immediate parameter semantics', () => {
  let runner: KimiRunner;

  beforeEach(() => {
    runner = new KimiRunner({ workspace: 'test' });
    // Stub the real stopper.stop so it resolves immediately (avoids timeout)
    vi.spyOn((runner as any).stopper, 'stop').mockResolvedValue(undefined);

    // Simulate a running process
    const fakeProc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: vi.fn(),
      stdout: null,
      stderr: null,
    } as unknown as ChildProcess;
    (runner as any).currentProcess = fakeProc;
  });

  it('test_anchor_kimi_stop_immediate_true_passes_true_to_stopper', async () => {
    const stopSpy = vi.spyOn((runner as any).stopper, 'stop');

    await runner.stop({ immediate: true });

    expect(stopSpy).toHaveBeenCalledOnce();
    const opts = stopSpy.mock.calls[0][1] as { immediate?: boolean };
    expect(opts.immediate).toBe(true);
  });

  it('test_anchor_kimi_stop_immediate_false_passes_false_to_stopper', async () => {
    const stopSpy = vi.spyOn((runner as any).stopper, 'stop');

    await runner.stop({ immediate: false });

    expect(stopSpy).toHaveBeenCalledOnce();
    const opts = stopSpy.mock.calls[0][1] as { immediate?: boolean };
    expect(opts.immediate).toBe(false);
  });

  it('test_anchor_kimi_stop_default_is_graceful', async () => {
    const stopSpy = vi.spyOn((runner as any).stopper, 'stop');

    await runner.stop();

    expect(stopSpy).toHaveBeenCalledOnce();
    const opts = stopSpy.mock.calls[0][1] as { immediate?: boolean };
    // Default (no opts) should be graceful = immediate is not true
    expect(opts.immediate).toBeFalsy();
  });
});
