import { spawnProcess } from './platform/spawn.js';
import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from './logger/index.js';
import { sleep } from './common/sleep.js';

/**
 * Self-restart without an external watchdog/cron: the only process that can
 * reliably start the successor is the dying lark-remote itself. The old process
 * spawns a detached replacement (same executable + argv, hence same
 * --config-dir), then exits cleanly. The child learns the old pid via env
 * and waits for it to die before acquiring the instance lock, so the lock
 * file stays the single source of truth for the handoff.
 */

/** Env var telling a replacement child which parent pid to wait for before acquiring the instance lock. */
export const RESTART_WAIT_PID_ENV = 'LARK_REMOTE_RESTART_WAIT_PID';
const WAIT_TIMEOUT_MS = 20_000;
const POLL_MS = 100;

/**
 * Spawn a detached lark-remote process (shared by /restart replacement and /clone
 * new-instance) whose early output — before the child's own file logger
 * initializes — lands on logFilePath. Returns the child pid, or null when
 * spawn failed synchronously / no pid; filesystem errors (unwritable log
 * dir) propagate. Caller picks throw-vs-degrade semantics.
 *
 * Two disciplines live here so every caller inherits them for free:
 * - windowsHide: win32 detached children would flash a console window (§3.7);
 * - the 'error' handler is attached BEFORE the pid check — a failed spawn
 *   emits 'error' asynchronously (ENOENT/EACCES), and the synchronous pid
 *   check throws/returns first, so attaching after would leave the 'error'
 *   event unhandled → uncaughtException kills the parent.
 */
export function spawnDetachedBridge(
  args: string[],
  logFilePath: string,
  opts?: { env?: NodeJS.ProcessEnv },
): number | null {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  const out = fs.openSync(logFilePath, 'a');
  try {
    const child = spawnProcess(process.execPath, args, {
      cwd: process.cwd(),
      env: opts?.env ?? process.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    child.on('error', () => {});
    if (child.pid === undefined) return null;
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(out);
  }
}

/**
 * Spawn a detached replacement lark-remote with the same executable and argv
 * (including --config-dir) and return its pid. The caller is expected to
 * exit right after. stdio is redirected to restart-child.log so early
 * startup failures (before the file logger initializes) are not lost.
 */
export function spawnReplacementBridge(logsDir: string): number {
  const pid = spawnDetachedBridge(process.argv.slice(1), path.join(logsDir, 'restart-child.log'), {
    env: { ...process.env, [RESTART_WAIT_PID_ENV]: String(process.pid) },
  });
  if (pid === null) {
    throw new Error('spawn replacement lark-remote failed: no pid');
  }
  return pid;
}

/**
 * On startup, if this process was spawned as a restart replacement, wait for
 * the previous lark-remote process to exit (and release the instance lock) before
 * continuing. No-op for normal starts. On timeout, proceed anyway — lock
 * acquisition remains the authority.
 */
export async function waitForPreviousInstance(): Promise<void> {
  const raw = process.env[RESTART_WAIT_PID_ENV];
  delete process.env[RESTART_WAIT_PID_ENV];
  if (!raw) return;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      getLogger().info(`[restart] previous instance pid=${pid} exited, continuing startup`);
      return;
    }
    await sleep(POLL_MS);
  }
  getLogger().warn(
    `[restart] previous instance pid=${pid} still alive after ${WAIT_TIMEOUT_MS}ms, proceeding anyway`,
  );
}
