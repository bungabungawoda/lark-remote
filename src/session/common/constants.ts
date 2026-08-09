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
