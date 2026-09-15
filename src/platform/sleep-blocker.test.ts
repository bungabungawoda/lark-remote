import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockChildProcess, emitExit } from '../../tests/lib/mock-process.js';
import type { spawnProcess } from './spawn.js';

const mockWarn = vi.fn();
const mockInfo = vi.fn();
vi.mock('../logger/index.js', () => ({
  getLogger: () => ({ info: mockInfo, warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
}));

import { startSleepBlocker, win32SleepBlockerScript } from './sleep-blocker.js';

function spawnReturning(proc: MockChildProcess): typeof spawnProcess {
  return vi.fn(() => proc);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('startSleepBlocker', () => {
  it('darwin：spawn caffeinate -i -w <pid>，stdio ignore', () => {
    const proc = new MockChildProcess({ pid: 777 });
    const spawnFn = spawnReturning(proc);
    const blocker = startSleepBlocker({ platform: 'darwin', pid: 4242, spawnFn });
    expect(blocker).not.toBeNull();
    expect(spawnFn).toHaveBeenCalledWith('caffeinate', ['-i', '-w', '4242'], {
      stdio: 'ignore',
    });
    expect(mockInfo).toHaveBeenCalledWith('[sleep-blocker] active via caffeinate pid=777');
  });

  it('win32：spawn powershell.exe 托管脚本，含 ES flags 与父 pid 轮询', () => {
    const proc = new MockChildProcess({ pid: 888 });
    const spawnFn = spawnReturning(proc);
    const blocker = startSleepBlocker({ platform: 'win32', pid: 4242, spawnFn });
    expect(blocker).not.toBeNull();
    const call = vi.mocked(spawnFn).mock.calls[0];
    expect(call[0]).toBe('powershell.exe');
    expect(call[1].slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    const script = call[1][3];
    expect(script).toContain('SetThreadExecutionState(0x80000001)');
    expect(script).toContain('Get-Process -Id 4242');
    expect(mockInfo).toHaveBeenCalledWith('[sleep-blocker] active via powershell.exe pid=888');
  });

  it('linux 等其他平台：no-op 返回 null，不 spawn', () => {
    const spawnFn = spawnReturning(new MockChildProcess());
    expect(startSleepBlocker({ platform: 'linux', pid: 4242, spawnFn })).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawn 抛错：warn + 返回 null，不阻断启动', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const blocker = startSleepBlocker({ platform: 'darwin', pid: 4242, spawnFn });
    expect(blocker).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      '[sleep-blocker] failed to spawn caffeinate:',
      expect.any(Error),
    );
  });

  it('spawn 二进制缺失（pid undefined）：warn + 返回 null', () => {
    const proc = new MockChildProcess({ pid: undefined });
    const blocker = startSleepBlocker({
      platform: 'darwin',
      pid: 4242,
      spawnFn: spawnReturning(proc),
    });
    expect(blocker).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      '[sleep-blocker] caffeinate unavailable (spawn failed), sleep prevention off',
    );
  });

  it('helper error 事件：只 warn 不 throw', () => {
    const proc = new MockChildProcess({ pid: 777 });
    const blocker = startSleepBlocker({
      platform: 'darwin',
      pid: 4242,
      spawnFn: spawnReturning(proc),
    });
    expect(blocker).not.toBeNull();
    expect(() => proc.emit('error', new Error('boom'))).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith('[sleep-blocker] caffeinate error:', expect.any(Error));
  });

  it('stop() 杀 helper；helper 已死时静默忽略', () => {
    const kill = vi.fn(() => true);
    const proc = new MockChildProcess({ pid: 777, kill });
    const blocker = startSleepBlocker({
      platform: 'darwin',
      pid: 4242,
      spawnFn: spawnReturning(proc),
    });
    blocker?.stop();
    expect(kill).toHaveBeenCalled();

    const deadKill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    const blocker2 = startSleepBlocker({
      platform: 'darwin',
      pid: 4242,
      spawnFn: spawnReturning(new MockChildProcess({ pid: 778, kill: deadKill })),
    });
    expect(() => blocker2?.stop()).not.toThrow();
  });

  // helper 自己死了 = 防休眠静默失效（如 win32 上 Add-Type 被企业策略禁掉动态
  // 编译、Get-Process 权限失败；darwin 上 caffeinate 早退）。桥还活着，这是唯一
  // 能留痕的时机——否则日志里只有当初那句 "active"，用户以为防休眠在生效。
  it('helper 意外退出：warn 记录，防休眠已失效可见', () => {
    const proc = new MockChildProcess({ pid: 888 });
    const blocker = startSleepBlocker({
      platform: 'win32',
      pid: 4242,
      spawnFn: spawnReturning(proc),
    });
    expect(blocker).not.toBeNull();
    expect(mockWarn).not.toHaveBeenCalled();

    emitExit(proc, 1, null);
    expect(mockWarn).toHaveBeenCalledWith(
      '[sleep-blocker] powershell.exe exited unexpectedly (code=1, signal=null), sleep prevention off',
    );
  });

  it('stop() 之后的退出不告警（正常清理路径）', () => {
    const proc = new MockChildProcess({ pid: 777 });
    const blocker = startSleepBlocker({
      platform: 'darwin',
      pid: 4242,
      spawnFn: spawnReturning(proc),
    });
    blocker?.stop();
    emitExit(proc, null, 'SIGTERM');
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe('win32SleepBlockerScript', () => {
  it('脚本：P/Invoke kernel32 + ES_CONTINUOUS|ES_SYSTEM_REQUIRED + 父 pid 看门循环', () => {
    const script = win32SleepBlockerScript(1234);
    expect(script).toContain('DllImport("kernel32.dll")');
    expect(script).toContain('SetThreadExecutionState(0x80000001)');
    expect(script).toContain('Get-Process -Id 1234 -ErrorAction SilentlyContinue');
    expect(script).toContain('Start-Sleep -Seconds 30');
  });
});
