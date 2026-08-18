import fs from 'node:fs';

/**
 * Unlink a file, silently ignoring ENOENT and other errors.
 *
 * Use for cleanup paths (pid files, temp files, stale locks) where the
 * file may already be gone or was never created — a missing file is not
 * an error worth propagating.
 */
export function silentlyUnlink(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    /* ignore — file may not exist */
  }
}
