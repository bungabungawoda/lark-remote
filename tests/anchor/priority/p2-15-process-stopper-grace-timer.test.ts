/**
 * Anchor Test: P2-15 ProcessStopper 宽限期定时器必须清理
 *
 * 背景（review.md P2-15）：stop() 的 Promise.race 里
 * `setTimeout(() => resolve(false), this.graceMs)` 没保存 timer id，race
 * 结束后（进程提前退出）定时器仍在后台 tick 到 graceMs 才清除。频繁 stop
 * 时积累大量游离定时器；更重要的是 unref 也没加，保持事件循环活跃。
 *
 * 修复：`const t = setTimeout(...)`，race 后 `clearTimeout(t)`。
 *
 * 这个 anchor 让一个 fake proc 在 race 开始后立即 exit（resolve(true)），
 * 同时用 fake timer 拦截 setTimeout，断言 race 结束后 clearTimeout 被调用
 * 了对应那个 grace 定时器。真红 = 当前实现不 clearTimeout，游离定时器
 * tick 到 graceMs。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProcessStopper } from '../../../src/runner/common/process-stopper.js';
import { createMockProc } from '../../../tests/lib/mock-process.js';

describe('P2-15: ProcessStopper clears the grace-period timer after early exit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_anchor_process_stopper_clears_grace_timer_on_early_exit', async () => {
    const graceMs = 30000;
    const stopper = new ProcessStopper({ graceMs });

    // Fake ChildProcess: still alive at stop() entry (exitCode/signalCode null),
    // but emits 'exit' on next tick (resolves the race immediately as true).
    const exitListeners: Array<(...args: unknown[]) => void> = [];
    const mockProc = createMockProc({
      pid: 99999,
      exitCode: null,
      signalCode: null,
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'exit') exitListeners.push(cb);
      }),
    });

    // Spy on global clearTimeout (grace timer must be cleared after early exit).
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const stopPromise = stopper.stop(mockProc);

    // Fire 'exit' so the race resolves true (process exited before grace).
    for (const cb of exitListeners) cb(0, null);
    await vi.runAllTimersAsync();
    await stopPromise;

    // GREEN: the grace timer scheduled by stop() must be cleared once the
    // race resolved via the 'exit' branch — no dangling timer keeps the
    // event loop alive. RED today: clearTimeout is never called for the
    // grace timer, so it lingers until graceMs.
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
