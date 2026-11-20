import type { ChildProcess } from 'node:child_process';

/** Upper bound for the spawn lead-in when the child never emits `error`. */
export const SPAWN_ERROR_TIMEOUT_MS = 5000;

/**
 * Await the spawn `error` event when `proc.pid === undefined`.
 *
 * Node guarantees `error` for ENOENT/EACCES, but some binaries fail silently.
 * The timeout keeps the caller from hanging forever (and blocking the queue).
 */
export function awaitSpawnError(
  proc: ChildProcess,
  timeoutMs: number = SPAWN_ERROR_TIMEOUT_MS,
): Promise<Error | undefined> {
  return Promise.race([
    new Promise<Error>((resolve) => {
      proc.once('error', (err: Error) => resolve(err));
    }),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
}
