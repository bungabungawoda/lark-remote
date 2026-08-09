import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpawnHeartbeat } from './spawn-heartbeat.js';

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
  initLogger: () => mockLogger,
}));

/**
 * SpawnHeartbeat 的契约是纯时钟逻辑（start/notifyStdout/clear + setTimeout），
 * 与真实子进程无关。用 fake timers 确定性验证，杜绝「真实时钟 vs 真实进程
 * 谁先谁后」的 wall-clock 竞态（见 claude-runner.test.ts 集成用例的重写）。
 */
describe('SpawnHeartbeat', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires exactly one WARN with pid/binary/cwd when no stdout arrives within the window', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const heartbeat = new SpawnHeartbeat(50, 'claude-runner');
    heartbeat.start({ pid: 12345, binary: '/mock/claude', cwd: '/tmp/ws' });

    vi.advanceTimersByTime(50);

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const message = String(mockLogger.warn.mock.calls[0][0]);
    expect(message).toContain('[claude-runner] spawn stage stalled');
    expect(message).toContain('pid=12345');
    expect(message).toContain('/mock/claude');
    expect(message).toContain('/tmp/ws');

    // One-shot timer: advancing further must not duplicate the WARN.
    vi.advanceTimersByTime(10_000);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('suppresses the WARN when notifyStdout() arrives within the window', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const heartbeat = new SpawnHeartbeat(50, 'claude-runner');
    heartbeat.start({ pid: 1, binary: 'x', cwd: '/tmp' });

    heartbeat.notifyStdout();
    vi.advanceTimersByTime(10_000);

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('clear() before the window cancels the WARN', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const heartbeat = new SpawnHeartbeat(50, 'claude-runner');
    heartbeat.start({ pid: 1, binary: 'x', cwd: '/tmp' });

    heartbeat.clear();
    vi.advanceTimersByTime(10_000);

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('a subsequent start() resets firstStdoutSeen and starts a fresh timer', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const heartbeat = new SpawnHeartbeat(50, 'claude-runner');

    // First run: stdout arrives in time → no WARN.
    heartbeat.start({ pid: 1, binary: 'x', cwd: '/tmp' });
    heartbeat.notifyStdout();
    vi.advanceTimersByTime(10_000);
    expect(mockLogger.warn).not.toHaveBeenCalled();

    // Second run: no stdout → the new timer must fire with the new context.
    heartbeat.start({ pid: 2, binary: 'y', cwd: '/tmp' });
    vi.advanceTimersByTime(50);

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(String(mockLogger.warn.mock.calls[0][0])).toContain('pid=2');
  });
});
