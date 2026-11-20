/**
 * Probe whether a pid is alive.
 *
 * - `process.kill(pid, 0)` returning normally → alive.
 * - ESRCH → dead.
 * - EPERM and any unexpected error → conservatively alive: the process may
 *   exist but be owned by another user, and callers use this to decide
 *   whether a lock can be reclaimed.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
