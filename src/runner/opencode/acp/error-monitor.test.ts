/**
 * Unit tests for OpencodeLogErrorMonitor: tails opencode's own log file and
 * reports limit/quota stream errors for the active ACP session.
 *
 * All fixture data is synthetic (AABB session ids, placeholder messages).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpencodeLogErrorMonitor } from './error-monitor.js';
import { mockLogger } from '../../../../tests/lib/logger-mock.js';

vi.mock('../../../logger/index.js', async () =>
  (await import('../../../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

const SESSION = 'ses_aaaaaaaa111122223333444444444444';
const OTHER_SESSION = 'ses_bbbbbbbb111122223333444444444444';

/** Build an opencode.log line (key=value bunyan-ish format, as written by
 *  opencode's logger). */
function logLine(
  sessionId: string,
  opts: {
    message?: string;
    error?: string;
    small?: boolean;
    level?: string;
  } = {},
): string {
  const small = opts.small ?? false;
  const message = opts.message ?? 'stream error';
  const error = opts.error ?? 'AI_APICallError: Weekly usage limit reached. Resets in 1hr 6min.';
  const level = opts.level ?? 'ERROR';
  return `timestamp=2026-08-24T06:32:16.666Z level=${level} run=abc123 message="${message}" providerID=opencode-go modelID=deepseek-v4-flash session.id=${sessionId} small=${small} agent=build mode=primary error.error="${error}"`;
}

function makeMonitor(logPath: string, pollIntervalMs = 50): OpencodeLogErrorMonitor {
  return new OpencodeLogErrorMonitor({ logPath, pollIntervalMs });
}

describe('OpencodeLogErrorMonitor', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(tmpdir(), 'lark-opencode-monitor-'));
    logPath = join(tmpDir, 'opencode.log');
    fs.writeFileSync(logPath, '');
    vi.useFakeTimers();
    mockLogger.warn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the real limit error for the monitored session', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    fs.appendFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(100);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Weekly usage limit reached'));
    monitor.stop();
  });

  it('ignores stream errors for other sessions', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    fs.appendFileSync(logPath, logLine(OTHER_SESSION) + '\n');
    vi.advanceTimersByTime(100);

    expect(onError).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('ignores the title-stream (small=true) failure of the same session', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    fs.appendFileSync(logPath, logLine(SESSION, { small: true }) + '\n');
    vi.advanceTimersByTime(100);

    expect(onError).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('ignores transient stream errors that opencode retries (no limit/quota reason)', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    fs.appendFileSync(
      logPath,
      logLine(SESSION, {
        error:
          'AI_APICallError: Cannot connect to API: The socket connection was closed unexpectedly.',
      }) + '\n',
    );
    vi.advanceTimersByTime(100);

    expect(onError).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('ignores non-error log lines (message=stream INFO entries)', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    fs.appendFileSync(
      logPath,
      logLine(SESSION, {
        message: 'stream',
        level: 'INFO',
        error: 'not-an-error',
      }) + '\n',
    );
    vi.advanceTimersByTime(100);

    expect(onError).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('does not fire on log content written before start (offset snapshot)', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    fs.writeFileSync(logPath, logLine(SESSION) + '\n');

    monitor.start(SESSION, onError);
    fs.appendFileSync(logPath, logLine(OTHER_SESSION) + '\n');
    vi.advanceTimersByTime(100);

    expect(onError).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('stops monitoring after stop()', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);
    vi.advanceTimersByTime(50);

    monitor.stop();
    fs.appendFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(200);

    expect(onError).not.toHaveBeenCalled();
  });

  it('recovers from log rotation (truncate + rewrite) and still reports', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    fs.appendFileSync(logPath, 'x'.repeat(2000) + '\n');

    monitor.start(SESSION, onError);
    vi.advanceTimersByTime(50);

    // Rotated: file truncated and rewritten with a smaller error line.
    fs.writeFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(100);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Weekly usage limit reached'));
    monitor.stop();
  });

  it('reports an error line written without a trailing newline', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    fs.appendFileSync(logPath, logLine(SESSION));
    vi.advanceTimersByTime(100);

    expect(onError).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('does not double-report after a hit (monitor stops itself)', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    fs.appendFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(100);
    fs.appendFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(200);

    expect(onError).toHaveBeenCalledTimes(1);
  });

  /**
   * noteIoError：监视器自身读不到日志时的留痕契约。故障 code 由 failStat 注入
   * 给定——原先靠「父路径被普通文件占住」向宿主要 ENOTDIR，而 win32 的 stat 对
   * 同一形态报 ENOENT（= 日志还没生成的正常空态出口），故障分支走不到。同一个
   * 故障在不同 OS 给的 code 不一样，用例就不能依赖宿主报错。
   */
  describe('IO 故障留痕', () => {
    /** 只对目标日志路径的 statSync 注入给定 code，其余 stat 走真实实现。 */
    function throwOnStat(target: string, code: string): void {
      const orig = fs.statSync;
      vi.spyOn(fs, 'statSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
        if (p === target) throw Object.assign(new Error(`${code}: stat failed`), { code });
        return (orig as (...a: unknown[]) => unknown).apply(fs, [p, ...rest]);
      }) as never);
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** 日志读不到时的路径形态；故障由 throwOnStat 注入，不靠宿主报错。 */
    function blockedLogPath(): string {
      return join(tmpDir, 'not-a-dir', 'opencode.log');
    }

    it('warns once with the fallback hint when the log cannot be stat-ed', () => {
      const blocked = blockedLogPath();
      throwOnStat(blocked, 'ENOTDIR');
      const monitor = makeMonitor(blocked);

      expect(() => monitor.start(SESSION, vi.fn())).not.toThrow();

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      const warning = String(mockLogger.warn.mock.calls[0][0]);
      expect(warning).toContain(blocked);
      expect(warning).toContain('limit errors will fall back to the idle watchdog');
      monitor.stop();
    });

    it('treats a missing log as an empty state and reports once it appears', () => {
      const missing = join(tmpDir, 'later.log');
      const monitor = makeMonitor(missing);
      const onError = vi.fn();

      monitor.start(SESSION, onError);
      expect(mockLogger.warn).not.toHaveBeenCalled();

      fs.writeFileSync(missing, logLine(SESSION) + '\n');
      vi.advanceTimersByTime(100);

      expect(onError).toHaveBeenCalledWith(expect.stringContaining('Weekly usage limit reached'));
      monitor.stop();
    });

    it('throttles repeated identical IO failures to one warning per minute', () => {
      const blocked = blockedLogPath();
      const monitor = makeMonitor(blocked, 50);
      throwOnStat(blocked, 'EACCES');
      monitor.start(SESSION, vi.fn());

      vi.advanceTimersByTime(50);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
      monitor.stop();
    });
  });
});
