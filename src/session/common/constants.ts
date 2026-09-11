/**
 * Session-related constants shared across agent session readers.
 */

/**
 * Threshold (in milliseconds) after which a session is considered inactive.
 *
 * Set to 1 hour — well above the typical 15-minute idle watchdog, so a
 * legitimately paused session is not prematurely marked stale. A file whose
 * mtime is older than this threshold cannot be from a running process.
 */
export const STALE_MS = 60 * 60 * 1000;

/**
 * A session file is stale (cannot be from a running process) when its
 * timestamp is older than STALE_MS. All readers share this single
 * comparison — previously it was re-derived per reader as
 * `Date.now() - mtimeMs > STALE_MS` (or its `< STALE_MS` negation).
 */
export function isStale(timestampMs: number, now: number = Date.now()): boolean {
  return now - timestampMs > STALE_MS;
}
