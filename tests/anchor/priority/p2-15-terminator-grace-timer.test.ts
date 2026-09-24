/**
 * Anchor Test: P2-15 Terminator 宽限期定时器必须清理
 *
 * 背景（review.md P2-15）：posix 终止器 stop() 的 Promise.race 里
 * `setTimeout(() => resolve(false), graceMs)` 若没保存 timer id，race
 * 结束后（进程提前退出）定时器仍在后台 tick 到 graceMs 才清除。频繁 stop
 * 时积累大量游离定时器；更重要的是 unref 也没加，保持事件循环活跃。
 *
 * 修复：`graceTimer = setTimeout(...)`，race 后 `clearTimeout(graceTimer)`。
 *
 * 迁移说明（2026-09-20）：原 `ProcessStopper` 兼容壳已删除，本 anchor 改为
 * 直接钉住 seam 实现 `createPosixTerminator`——该守卫必须跟着生产实现走，
 * 否则壳删了、守卫还绿着，等于没守。
 *
 * 这个 anchor 让一个 fake proc 在 race 开始后立即 exit（resolve(true)），
 * 同时用 fake timer 拦截 setTimeout，断言 race 结束后 clearTimeout 被调用
 * 了对应那个 grace 定时器。守住的失败模式：不 clearTimeout，游离定时器
 * tick 到 graceMs。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPosixTerminator } from '../../../src/platform/terminator-posix.js';
import { createMockProc } from '../../../tests/lib/mock-process.js';

describe('P2-15: Terminator clears the grace-period timer after early exit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_anchor_terminator_clears_grace_timer_on_early_exit', async () => {
    const graceMs = 30000;
    const terminator = createPosixTerminator({ graceMs, log: () => {} });

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

    const stopPromise = terminator.stop(mockProc, { immediate: false });

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
