import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { createMockProc, emitExit } from '../../tests/lib/mock-process.js';

// 不真起 taskkill：全部断言基于 spawn 入参与状态机分支
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { AgentStopperRegistry, createTerminator } from './terminator.js';
import { createWin32Terminator } from './terminator-win32.js';
import { isWin32 } from './select.js';

const mockSpawn = vi.mocked(spawn);

/** taskkill 自身返回一个即启即退的假进程（实现不依赖其输出）。 */
function fakeTaskkill(): ChildProcess {
  const proc = createMockProc({ pid: 777 });
  setTimeout(() => emitExit(proc, 0, null), 0);
  return proc;
}

beforeEach(() => {
  mockSpawn.mockReset();
  mockSpawn.mockReturnValue(fakeTaskkill());
});

/** 存活进程（exitCode/signalCode 均为 null）。 */
function aliveProc(pid = 4242): ChildProcess {
  return createMockProc({ pid, exitCode: null, signalCode: null });
}

function exitedProc(pid = 4242): ChildProcess {
  return createMockProc({ pid, exitCode: 0, signalCode: null });
}

/** 最后一次 spawn 调用摊平成 ['taskkill', '/PID', ...] 形式。 */
function lastSpawnCommand(): string[] | undefined {
  const call = mockSpawn.mock.calls.at(-1) as [string, string[], unknown] | undefined;
  return call ? [call[0], ...call[1]] : undefined;
}

describe('createWin32Terminator — 立即停止', () => {
  it('taskkill /PID <pid> /T /F', async () => {
    const proc = aliveProc(4242);
    const terminator = createWin32Terminator({ graceMs: 1000 });
    const result = await terminator.stop(proc, { immediate: true });
    expect(result).toEqual({ requested: true, via: 'taskkill' });
    expect(lastSpawnCommand()).toEqual(['taskkill', '/PID', '4242', '/T', '/F']);
  });

  it('无 pid（spawn 未成功）→ already-exited，不得谎报已请求终止', async () => {
    const terminator = createWin32Terminator({ graceMs: 1000 });
    const result = await terminator.stop(createMockProc({ pid: undefined }), {
      immediate: true,
    });
    expect(result).toEqual({ requested: false, via: 'already-exited' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('进程已退出 → 不树杀，via=already-exited', async () => {
    const proc = exitedProc(4242);
    const terminator = createWin32Terminator({ graceMs: 1000 });
    const result = await terminator.stop(proc, { immediate: true });
    expect(result).toEqual({ requested: false, via: 'already-exited' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('createWin32Terminator — 优雅停止', () => {
  it('有协议通道且 grace 内退出 → cooperative，不树杀（grace 内不等满窗口）', async () => {
    const proc = aliveProc();
    const stopper = vi.fn(() => {
      setTimeout(() => emitExit(proc, 0, null), 5);
    });
    const stoppers = new AgentStopperRegistry();
    stoppers.register('claude', stopper);
    const terminator = createWin32Terminator({ graceMs: 200, stoppers, agent: 'claude' });

    const started = Date.now();
    const result = await terminator.stop(proc, { immediate: false });
    // 原独立「grace 等待器」用例的计时断言（W3.7 并入）：grace 200ms 内 5ms 退出
    expect(Date.now() - started).toBeLessThan(200);
    expect(stopper).toHaveBeenCalledTimes(1);
    expect(stopper.mock.calls[0]![0]).toBe(proc);
    expect(result).toEqual({ requested: true, via: 'cooperative' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('有协议通道但 grace 后仍存活 → 补 taskkill /T /F', async () => {
    const proc = aliveProc(909);
    const stopper = vi.fn(async () => {});
    const stoppers = new AgentStopperRegistry();
    stoppers.register('codex', stopper);
    const terminator = createWin32Terminator({ graceMs: 5, stoppers, agent: 'codex' });

    const result = await terminator.stop(proc, { immediate: false });
    expect(stopper).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ requested: true, via: 'taskkill' });
    expect(lastSpawnCommand()).toEqual(['taskkill', '/PID', '909', '/T', '/F']);
  });

  it('无协议通道 → 打日志显式跳过优雅段并直接树杀（不等一个不会来的事件）', async () => {
    const proc = aliveProc();
    const log = vi.fn();
    const waitForExit = vi.fn(async () => true);
    const terminator = createWin32Terminator({
      graceMs: 1000,
      stoppers: new AgentStopperRegistry(),
      agent: 'pi',
      waitForExit,
      log,
    });

    const result = await terminator.stop(proc, { immediate: false });
    expect(result).toEqual({ requested: true, via: 'skipped-no-channel' });
    expect(waitForExit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0]![0])).toContain('pi');
    expect(lastSpawnCommand()).toEqual(['taskkill', '/PID', '4242', '/T', '/F']);
  });

  it('协议停止抛错 → 不吞异常，继续走树杀', async () => {
    const proc = aliveProc();
    const log = vi.fn();
    const stoppers = new AgentStopperRegistry();
    stoppers.register('claude', () => {
      throw new Error('stdin closed');
    });
    const terminator = createWin32Terminator({ graceMs: 5, stoppers, agent: 'claude', log });

    const result = await terminator.stop(proc, { immediate: false });
    expect(result).toEqual({ requested: true, via: 'taskkill' });
    expect(log).toHaveBeenCalled();
  });

  it('进程已退出 → 不调用协议通道也不树杀', async () => {
    const proc = exitedProc();
    const stopper = vi.fn();
    const stoppers = new AgentStopperRegistry();
    stoppers.register('claude', stopper);
    const terminator = createWin32Terminator({ graceMs: 5, stoppers, agent: 'claude' });

    const result = await terminator.stop(proc, { immediate: false });
    expect(result).toEqual({ requested: false, via: 'already-exited' });
    expect(stopper).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('createWin32Terminator — cleanupOnExit', () => {
  it('进程仍存活 → fire-and-forget 树杀', () => {
    const terminator = createWin32Terminator({ graceMs: 10 });
    terminator.cleanupOnExit(aliveProc(555));
    expect(lastSpawnCommand()).toEqual(['taskkill', '/PID', '555', '/T', '/F']);
  });

  it('进程已退出 → 不做无用功', () => {
    const terminator = createWin32Terminator({ graceMs: 10 });
    terminator.cleanupOnExit(exitedProc(555));
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('AgentStopperRegistry', () => {
  it('register/get/has 按 agent key 隔离', () => {
    const registry = new AgentStopperRegistry();
    const claude = vi.fn();
    const codex = vi.fn();
    expect(registry.has('claude')).toBe(false);
    expect(registry.get('claude')).toBeUndefined();

    registry.register('claude', claude);
    registry.register('codex', codex);
    expect(registry.has('claude')).toBe(true);
    expect(registry.get('claude')).toBe(claude);
    expect(registry.get('codex')).toBe(codex);
    expect(registry.has('pi')).toBe(false);
  });

  it('重复注册同一 agent 以最后一次为准', () => {
    const registry = new AgentStopperRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register('claude', first);
    registry.register('claude', second);
    expect(registry.get('claude')).toBe(second);
  });

  it('clear 清空全部通道', () => {
    const registry = new AgentStopperRegistry();
    registry.register('claude', vi.fn());
    registry.clear();
    expect(registry.has('claude')).toBe(false);
    expect(registry.get('claude')).toBeUndefined();
  });
});

describe('createTerminator — 平台分发', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('posix：无协议通道也按组杀语义发 SIGTERM，超时补 SIGKILL', async () => {
    const terminator = createTerminator({ platform: 'linux', graceMs: 5, agent: 'claude' });
    const result = await terminator.stop(aliveProc(4242), { immediate: false });
    expect(result).toEqual({ requested: true, via: 'taskkill' });
    expect(killSpy).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('win32：无协议通道则走 taskkill 树杀，不发信号', async () => {
    const terminator = createTerminator({
      platform: 'win32',
      graceMs: 5,
      agent: 'pi',
      stoppers: new AgentStopperRegistry(),
    });
    const result = await terminator.stop(aliveProc(4242), { immediate: false });
    expect(result).toEqual({ requested: true, via: 'skipped-no-channel' });
    expect(lastSpawnCommand()).toEqual(['taskkill', '/PID', '4242', '/T', '/F']);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('未显式注入 platform 时取当前宿主平台', async () => {
    const terminator = createTerminator({ graceMs: 5 });
    const result = await terminator.stop(aliveProc(4242), { immediate: true });
    if (isWin32()) {
      expect(result.via).toBe('taskkill');
      expect(lastSpawnCommand()).toEqual(['taskkill', '/PID', '4242', '/T', '/F']);
    } else {
      expect(killSpy).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM');
      expect(killSpy).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL');
    }
  });
});
