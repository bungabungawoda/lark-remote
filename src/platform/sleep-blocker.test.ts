import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockChildProcess, emitExit } from '../../tests/lib/mock-process.js';
import { spawnProcess } from './spawn.js';
import { describeWin32 } from '../../tests/lib/platform.js';

const mockWarn = vi.fn();
const mockInfo = vi.fn();
vi.mock('../logger/index.js', () => ({
  getLogger: () => ({ info: mockInfo, warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
}));

import { startSleepBlocker, win32SleepBlockerScript } from './sleep-blocker.js';

function spawnReturning(proc: MockChildProcess): typeof spawnProcess {
  return vi.fn(() => proc);
}

/** ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x00000001)，按无符号 32 位取值。 */
const ES_FLAGS_UINT32 = (0x80000000 | 0x00000001) >>> 0;

/**
 * 一个绝不可能存在的父 pid：让脚本里的看门循环首轮即为假、立刻退出，
 * 于是真实执行用例不会留下长驻 helper 进程。
 */
const NONEXISTENT_PID = 999_999_999;

/** 真起一次 powershell.exe 跑给定脚本，收集退出码与 stderr。 */
function runPowershell(
  script: string,
  timeoutMs = 25_000,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // 已自行退出
      }
      resolve({ code, stderr });
    };
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code));
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
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
    expect(script).toContain(`SetThreadExecutionState(${ES_FLAGS_UINT32})`);
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
    expect(script).toContain(`SetThreadExecutionState(${ES_FLAGS_UINT32})`);
    expect(script).toContain('Get-Process -Id 1234 -ErrorAction SilentlyContinue');
    expect(script).toContain('Start-Sleep -Seconds 30');
  });

  // 0x80000001 = 2147483649 超出 Int32 正数上界（2147483647）。PowerShell 的数字
  // 字面量在 Int32 范围内按 Int32 解析，`0x80000001` 因而被解析成 -2147483647，
  // 传给 P/Invoke 声明的 `uint` 形参时抛 MethodArgumentConversionInvalidCastArgument。
  // 该死的是它属于**非终止错误**：脚本不停，后面的 while 看门循环照跑 → helper
  // 进程活着、"helper 退出"这条唯一的失效告警通道不触发 → 防休眠静默失效
  // （2026-09-22 真机复现，日志里只有 active，Kernel-Power 照记 System Idle 睡眠）。
  it('ES flags 以十进制插入：避开 PowerShell 的 Int32 字面量陷阱', () => {
    const script = win32SleepBlockerScript(1234);
    expect(script).not.toContain('0x80000001');
    expect(script).toContain(`SetThreadExecutionState(${ES_FLAGS_UINT32})`);
    // 位运算在 JS 里是有符号 Int32：`0x80000000 | 1` 得 -2147483647，必须 `>>> 0` 归位。
    expect(0x80000000 | 0x00000001).toBe(-2147483647);
    expect(ES_FLAGS_UINT32).toBe(2147483649);
    // 对照：JS 侧的字面量本身无害（Number 是 double，0x80000001 = 2147483649），
    // 溢出成负数是 **PowerShell** 的数字字面量解析规则 —— 两边不能混为一谈，
    // 这正是「脚本里插什么写法」必须单独测的理由。
    expect(0x80000001).toBe(2147483649);
  });

  it('脚本把非终止错误升级为终止错误：失效时 helper 必须退出并留痕', () => {
    const script = win32SleepBlockerScript(1234);
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
  });
});

describeWin32('win32SleepBlockerScript 真实执行', () => {
  // 字符串断言看不见这个 bug：「脚本里写着 0x80000001」和「API 真的被调用成功」
  // 是两件事。凡是「生成一段脚本串交给另一个解释器执行」的模块，必须有真实执行
  // 用例，否则只能在真机上静默失效。
  it('真实执行：stderr 为空且退出码 0', async () => {
    const script = win32SleepBlockerScript(NONEXISTENT_PID);
    const { code, stderr } = await runPowershell(script);
    expect(stderr.trim()).toBe('');
    expect(code).toBe(0);
  }, 30_000);
});
