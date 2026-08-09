import type { ChildProcess } from 'node:child_process';
import { getLogger } from '../../logger/index.js';

interface ProcessStopperOptions {
  graceMs: number;
}

interface StopOptions {
  immediate?: boolean;
}

/**
 * Unified process stop logic: SIGTERM → grace period → SIGKILL.
 *
 * Extracts the common pattern shared by ClaudeRunner and BashProcessRunner
 * so both use identical stop semantics.
 */
export class ProcessStopper {
  private graceMs: number;

  constructor(opts: ProcessStopperOptions) {
    this.graceMs = opts.graceMs;
  }

  /**
   * Stop a child process: SIGTERM → wait grace → SIGKILL.
   *
   * Uses negative PID to kill the entire process group, ensuring child
   * processes (shell wrappers, sub-processes) are also terminated.
   *
   * Pass `immediate: true` to skip the grace window — SIGTERM and SIGKILL
   * are sent back-to-back. Safe to call on an already-exited process.
   */
  async stop(proc: ChildProcess, opts?: StopOptions): Promise<void> {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }

    const pid = proc.pid;
    if (pid === undefined) {
      return;
    }

    // Use negative PID to kill the entire process group.
    // This ensures child processes (shell wrappers, sub-processes) are also killed.
    // If the process is not a group leader, kill(-pid) behaves same as kill(pid).
    const pgid = -pid;

    const immediate = opts?.immediate === true;

    getLogger().debug(`[process-stopper] sending SIGTERM to pgid=${pgid} immediate=${immediate}`);
    try {
      process.kill(pgid, 'SIGTERM');
    } catch {
      /* process may have exited */
    }

    if (immediate) {
      // Don't wait — send SIGKILL back-to-back. Even if proc just exited
      // from SIGTERM, kill(SIGKILL) on a dead pid throws ESRCH which we ignore.
      try {
        process.kill(pgid, 'SIGKILL');
      } catch {}
    } else {
      // Wait for exit with grace period. Use `once` so repeated stop() calls
      // don't accumulate listeners on the proc. P2-15: save the grace timer id
      // and clear it once the race settles — otherwise the timer lingers after
      // an early exit, keeping the event loop alive and accumulating across
      // frequent stop() calls.
      let graceTimer: NodeJS.Timeout | undefined;
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
          proc.once('exit', () => resolve(true));
        }),
        new Promise<boolean>((resolve) => {
          graceTimer = setTimeout(() => resolve(false), this.graceMs);
        }),
      ]);

      if (graceTimer) clearTimeout(graceTimer);

      if (!exited) {
        getLogger().info(
          `[process-stopper] process group ${pgid} did not exit within grace period, sending SIGKILL`,
        );
        try {
          process.kill(pgid, 'SIGKILL');
        } catch {}
      }
    }
  }
}
