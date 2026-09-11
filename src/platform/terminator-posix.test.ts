import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockProc, emitExit } from '../../tests/lib/mock-process.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../logger/index.js', () => ({ getLogger: () => mockLogger }));

import { createPosixTerminator, ProcessStopper } from './terminator-posix.js';

describe('createPosixTerminator', () => {
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

  it('优雅停止：SIGTERM 打到负 PID 进程组，grace 内退出 → cooperative', async () => {
    const terminator = createPosixTerminator({ graceMs: 5000 });
    const proc = createMockProc();
    const stopPromise = terminator.stop(proc, { immediate: false });

    emitExit(proc, 0, null);
    const result = await stopPromise;

    expect(result).toEqual({ requested: true, via: 'cooperative' });
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
  });

  it('grace 超时 → SIGKILL 补刀（仍走负 PID 组杀），via=taskkill', async () => {
    const terminator = createPosixTerminator({ graceMs: 1000 });
    const proc = createMockProc();
    const stopPromise = terminator.stop(proc, { immediate: false });

    await vi.advanceTimersByTimeAsync(1000);
    emitExit(proc, null, 'SIGKILL');
    const result = await stopPromise;

    expect(result).toEqual({ requested: true, via: 'taskkill' });
    expect(killSpy).toHaveBeenNthCalledWith(1, -12345, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, -12345, 'SIGKILL');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('did not exit within grace period'),
    );
  });

  it('immediate：SIGTERM+SIGKILL 连发且不留定时器，via=taskkill', async () => {
    const terminator = createPosixTerminator({ graceMs: 5000 });
    const result = await terminator.stop(createMockProc(), { immediate: true });

    expect(result).toEqual({ requested: true, via: 'taskkill' });
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(1, -12345, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, -12345, 'SIGKILL');

    await vi.advanceTimersByTimeAsync(30000);
    expect(killSpy).toHaveBeenCalledTimes(2);
  });

  it('immediate：SIGKILL ESRCH 容错（进程已死）不抛错（自 process-stopper.test.ts 迁入）', async () => {
    const terminator = createPosixTerminator({ graceMs: 5000 });
    const proc = createMockProc();

    // SIGTERM 成功，SIGKILL 抛 ESRCH（进程已消失）
    killSpy.mockImplementationOnce(() => true);
    killSpy.mockImplementationOnce(() => {
      const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      throw err;
    });

    await expect(terminator.stop(proc, { immediate: true })).resolves.toEqual({
      requested: true,
      via: 'taskkill',
    });
  });

  it('已退出 / 无 pid → already-exited，一个信号都不发', async () => {
    const terminator = createPosixTerminator({ graceMs: 5000 });
    await expect(
      terminator.stop(createMockProc({ exitCode: 0 }), { immediate: false }),
    ).resolves.toEqual({ requested: false, via: 'already-exited' });
    await expect(
      terminator.stop(createMockProc({ signalCode: 'SIGTERM' }), { immediate: true }),
    ).resolves.toEqual({ requested: false, via: 'already-exited' });
    await expect(
      terminator.stop(createMockProc({ pid: undefined }), { immediate: false }),
    ).resolves.toEqual({ requested: false, via: 'already-exited' });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('cleanupOnExit：存活进程 fire-and-forget SIGKILL，已退出则跳过', () => {
    const terminator = createPosixTerminator({ graceMs: 5000 });
    terminator.cleanupOnExit(createMockProc({ pid: 4242 }));
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');

    killSpy.mockClear();
    terminator.cleanupOnExit(createMockProc({ exitCode: 0 }));
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('ProcessStopper（既有调用方兼容壳）', () => {
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

  it('保留原契约：返回 void、接受 null proc', async () => {
    const stopper = new ProcessStopper({ graceMs: 5000 });
    await expect(stopper.stop(null)).resolves.toBeUndefined();

    const proc = createMockProc();
    const stopPromise = stopper.stop(proc);
    emitExit(proc, 0, null);
    await expect(stopPromise).resolves.toBeUndefined();
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
  });
});
