import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from './logger/index.js';

/**
 * Self-restart without an external watchdog/cron: the only process that can
 * reliably start the successor is the dying bridge itself. The old process
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
 * Spawn a detached replacement bridge with the same executable and argv
 * (including --config-dir) and return its pid. The caller is expected to
 * exit right after. stdio is redirected to restart-child.log so early
 * startup failures (before the file logger initializes) are not lost.
 */
export function spawnReplacementBridge(logsDir: string): number {
  fs.mkdirSync(logsDir, { recursive: true });
  const out = fs.openSync(path.join(logsDir, 'restart-child.log'), 'a');
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env, [RESTART_WAIT_PID_ENV]: String(process.pid) },
    detached: true,
    stdio: ['ignore', out, out],
  });
  // Late spawn errors (e.g. binary removed mid-run) must not crash the
  // exiting parent via an unhandled 'error' event. Attach BEFORE the pid
  // check — a failed spawn emits 'error' asynchronously (ENOENT/EACCES),
  // and the pid check below throws synchronously first, so attaching after
  // the throw would leave the 'error' event unhandled → uncaughtException
  // → the old bridge exits despite having promised to stay alive.
  child.on('error', () => {});
  fs.closeSync(out);
  if (child.pid === undefined) {
    throw new Error('spawn replacement bridge failed: no pid');
  }
  child.unref();
  return child.pid;
}

/**
 * On startup, if this process was spawned as a restart replacement, wait for
 * the previous bridge process to exit (and release the instance lock) before
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
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  getLogger().warn(
    `[restart] previous instance pid=${pid} still alive after ${WAIT_TIMEOUT_MS}ms, proceeding anyway`,
  );
}
