/**
 * Unit tests for OpencodeLogErrorMonitor: tails opencode's own log file and
 * reports limit/quota stream errors for the active ACP session.
 *
 * All fixture data is synthetic (AABB session ids, placeholder messages).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpencodeLogErrorMonitor } from './error-monitor.js';

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
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-opencode-monitor-'));
    logPath = join(tmpDir, 'opencode.log');
    writeFileSync(logPath, '');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the real limit error for the monitored session', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    appendFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(100);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Weekly usage limit reached'));
    monitor.stop();
  });

  it('ignores stream errors for other sessions', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    appendFileSync(logPath, logLine(OTHER_SESSION) + '\n');
    vi.advanceTimersByTime(100);

    expect(onError).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('ignores the title-stream (small=true) failure of the same session', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    appendFileSync(logPath, logLine(SESSION, { small: true }) + '\n');
    vi.advanceTimersByTime(100);

    expect(onError).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('ignores transient stream errors that opencode retries (no limit/quota reason)', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    appendFileSync(
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

    appendFileSync(
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
    writeFileSync(logPath, logLine(SESSION) + '\n');

    monitor.start(SESSION, onError);
    appendFileSync(logPath, logLine(OTHER_SESSION) + '\n');
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
    appendFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(200);

    expect(onError).not.toHaveBeenCalled();
  });

  it('recovers from log rotation (truncate + rewrite) and still reports', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    appendFileSync(logPath, 'x'.repeat(2000) + '\n');

    monitor.start(SESSION, onError);
    vi.advanceTimersByTime(50);

    // Rotated: file truncated and rewritten with a smaller error line.
    writeFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(100);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Weekly usage limit reached'));
    monitor.stop();
  });

  it('reports an error line written without a trailing newline', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    appendFileSync(logPath, logLine(SESSION));
    vi.advanceTimersByTime(100);

    expect(onError).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('does not double-report after a hit (monitor stops itself)', () => {
    const monitor = makeMonitor(logPath);
    const onError = vi.fn();
    monitor.start(SESSION, onError);

    appendFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(100);
    appendFileSync(logPath, logLine(SESSION) + '\n');
    vi.advanceTimersByTime(200);

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
