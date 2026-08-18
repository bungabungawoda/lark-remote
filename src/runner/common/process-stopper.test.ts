import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProcessStopper } from './process-stopper.js';
import type { ChildProcess } from 'node:child_process';
import { createMockProc } from '../../../tests/lib/mock-process.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logger/index.js', () => ({
  getLogger: () => mockLogger,
}));

/**
 * Simulate the OS delivering an exit event on the mock process.
 * Node sets exitCode/signalCode and emits 'exit'.
 */
function simulateExit(proc: ChildProcess, code: number | null, signal: string | null) {
  Object.assign(proc, { exitCode: code, signalCode: signal });
  proc.emit('exit', code, signal);
}

describe('ProcessStopper', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    killSpy.mockRestore();
  });

  describe('normal SIGTERM exit', () => {
    it('resolves when process exits after SIGTERM within grace period', async () => {
      const stopper = new ProcessStopper({ graceMs: 5000 });
      const proc = createMockProc();

      const stopPromise = stopper.stop(proc);

      // Process exits normally after SIGTERM
      simulateExit(proc, 0, null);

      await stopPromise;

      // SIGTERM sent to process group (negative PID), SIGKILL not sent
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    });

    it('does not send SIGKILL if process exits quickly', async () => {
      const stopper = new ProcessStopper({ graceMs: 5000 });
      const proc = createMockProc();

      const stopPromise = stopper.stop(proc);

      // Exit before grace period
      simulateExit(proc, 1, null);

      await stopPromise;

      expect(killSpy).toHaveBeenCalledTimes(1);
      // Only SIGTERM to process group
      expect(killSpy).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
    });

    it('handles process killed by SIGTERM (signalCode set)', async () => {
      const stopper = new ProcessStopper({ graceMs: 5000 });
      const proc = createMockProc();

      const stopPromise = stopper.stop(proc);
      simulateExit(proc, null, 'SIGTERM');

      await stopPromise;

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    });
  });

  describe('grace period timeout triggers SIGKILL', () => {
    it('sends SIGKILL when process does not exit within grace period', async () => {
      const stopper = new ProcessStopper({ graceMs: 1000 });
      const proc = createMockProc();

      const stopPromise = stopper.stop(proc);

      // Advance past grace period without process exiting
      await vi.advanceTimersByTimeAsync(1000);

      // Now resolve the stop promise (SIGKILL already sent, but process
      // may still be alive; simulate its exit to settle the promise)
      simulateExit(proc, null, 'SIGKILL');

      await stopPromise;

      expect(killSpy).toHaveBeenCalledTimes(2);
      expect(killSpy).toHaveBeenNthCalledWith(1, -12345, 'SIGTERM');
      expect(killSpy).toHaveBeenNthCalledWith(2, -12345, 'SIGKILL');
    });

    it('logs info message when grace period expires', async () => {
      const stopper = new ProcessStopper({ graceMs: 2000 });
      const proc = createMockProc();

      const stopPromise = stopper.stop(proc);

      await vi.advanceTimersByTimeAsync(2000);
      simulateExit(proc, null, 'SIGKILL');

      await stopPromise;

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('did not exit within grace period'),
      );
    });
  });

  describe('immediate: true', () => {
    it('sends SIGTERM and SIGKILL back-to-back without waiting', async () => {
      const stopper = new ProcessStopper({ graceMs: 5000 });
      const proc = createMockProc();

      const stopPromise = stopper.stop(proc, { immediate: true });

      // Resolves immediately without needing process to exit
      await stopPromise;

      // Both signals sent to process group
      expect(killSpy).toHaveBeenCalledTimes(2);
      expect(killSpy).toHaveBeenNthCalledWith(1, -12345, 'SIGTERM');
      expect(killSpy).toHaveBeenNthCalledWith(2, -12345, 'SIGKILL');
    });

    it('does not set any timers', async () => {
      const stopper = new ProcessStopper({ graceMs: 5000 });
      const proc = createMockProc();

      await stopper.stop(proc, { immediate: true });

      // Advance time significantly — nothing should happen
      await vi.advanceTimersByTimeAsync(30000);

      // Still only 2 kill calls from the immediate stop
      expect(killSpy).toHaveBeenCalledTimes(2);
    });

    it('ignores ESRCH errors on SIGKILL (process already dead)', async () => {
      const stopper = new ProcessStopper({ graceMs: 5000 });
      const proc = createMockProc();

      // SIGTERM succeeds, SIGKILL throws ESRCH (process already gone)
      killSpy.mockImplementationOnce(() => true);
      killSpy.mockImplementationOnce(() => {
        const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        throw err;
      });

      // Should not throw
      await expect(stopper.stop(proc, { immediate: true })).resolves.toBeUndefined();
    });
  });

  describe('already-exited process', () => {
    it('returns immediately if exitCode is already set', async () => {
      const stopper = new ProcessStopper({ graceMs: 5000 });
      const proc = createMockProc({ exitCode: 0 });

      await stopper.stop(proc);

      expect(killSpy).not.toHaveBeenCalled();
    });

    it('returns immediately if pid is undefined', async () => {
      const stopper = new ProcessStopper({ graceMs: 5000 });
      const proc = createMockProc({ pid: undefined });

      await stopper.stop(proc);

      expect(killSpy).not.toHaveBeenCalled();
    });

    it('returns immediately if proc is nullish', async () => {
      const stopper = new ProcessStopper({ graceMs: 5000 });

      await stopper.stop(null);

      expect(killSpy).not.toHaveBeenCalled();
    });
  });
});
