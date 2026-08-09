import { getLogger } from '../../logger/index.js';

/**
 * Spawn-stage heartbeat: warns when a spawned process emits no stdout within
 * a configured window. Covers the gap between spawn and the first stdout
 * chunk (OAuth prompt, stdio fd misroute, cwd not reachable) where the
 * idle watchdog has not started yet.
 *
 * Extracted from ClaudeRunner and CodexRunner which had identical patterns
 * (field trio + setTimeout + three clearTimeout call sites).
 *
 * Only logs a WARN — never auto-stops. Spawn-stage issues usually need user
 * intervention (re-login OAuth), so killing automatically would confuse users.
 */
export class SpawnHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private firstStdoutSeen = false;

  constructor(
    private readonly ms: number,
    private readonly logTag: string,
  ) {}

  /**
   * Start the heartbeat timer. If no stdout is observed within `ms`,
   * log a WARN with the spawn context. Safe to call again after `clear()`
   * (e.g. across multiple runs).
   */
  start(ctx: { pid: number; binary: string; cwd: string }): void {
    this.firstStdoutSeen = false;
    this.clear();
    this.timer = setTimeout(() => {
      if (!this.firstStdoutSeen) {
        getLogger().warn(
          `[${this.logTag}] spawn stage stalled: pid=${ctx.pid} binary=${ctx.binary} ` +
            `cwd=${ctx.cwd} — process spawned ${this.ms / 1000}s ago with no stdout output.`,
        );
      }
    }, this.ms);
  }

  /** Mark that stdout has been observed; clears the timer. */
  notifyStdout(): void {
    this.firstStdoutSeen = true;
    this.clear();
  }

  /** Clear the timer (safe to call multiple times). */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
