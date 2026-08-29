/**
 * OpencodeLogErrorMonitor: watches opencode's own log file for LLM stream
 * errors of the active ACP session and reports them immediately.
 *
 * Why this exists: opencode ACP (v1.18.x) does NOT forward retry/error state
 * to the client over the ACP protocol. Its session/update notifications are
 * limited to content deltas (agent_message_chunk / agent_thought_chunk /
 * tool_call / tool_call_update), usage and available-commands updates — there
 * is no error/retry/status event type, and session/list carries no status.
 * When a retryable provider error hits (e.g. opencode-go "Weekly usage limit
 * reached"), the session enters a retry backoff (often the full reset time,
 * ~1h) and session/prompt stays pending with zero events, so the client would
 * hang until its own idle watchdog.
 *
 * The only channel that carries the real error is opencode's own log file
 * (`$XDG_DATA_HOME/opencode/log/opencode.log`), where every LLM stream
 * failure is written as `message="stream error" ... session.id=<id>
 * small=false ... error.error="<reason>"`.
 *
 * This monitor tails the log (delta from the turn-start offset), scoped to
 * the active sessionId + `small=false` (main turn; the `small=true` title
 * stream must not kill the turn). Only limit/quota-class errors trigger the
 * callback — they are the ones opencode backs off for a long time; transient
 * 5xx/network errors retry in seconds and must be left to opencode's own
 * retry loop (the idle watchdog remains the fallback for silent hangs).
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OpencodeLogErrorMonitorOptions {
  /** Path to opencode's own log file (default: resolveOpencodeLogPath()). */
  logPath: string;
  /** Tail poll interval in milliseconds. Defaults to 2000. */
  pollIntervalMs?: number;
}

/** Error text we fail fast on: quota/limit conditions opencode backs off on. */
const LIMIT_ERROR_RE =
  /usage limit|quota|rate limit|rate_limit|too many requests|insufficient balance|free usage/i;

const STREAM_ERROR_RE = /message="stream error"/;
const MAIN_TURN_RE = /small=false/;
const ERROR_MESSAGE_RE = /error\.error="((?:[^"\\]|\\.)*)"/;

/**
 * Resolve opencode's log file path from the XDG data dir
 * (`$XDG_DATA_HOME/opencode/log/opencode.log`, default
 * `~/.local/share/opencode/log/opencode.log`). Matches opencode's own
 * data-dir layout (open source v1.18.x: `opencode/src/cli/global.ts`).
 */
export function resolveOpencodeLogPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'log', 'opencode.log');
}

export class OpencodeLogErrorMonitor {
  private readonly logPath: string;
  private readonly pollIntervalMs: number;
  private offset = 0;
  private pendingTail = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private onError: ((message: string) => void) | null = null;

  constructor(opts: OpencodeLogErrorMonitorOptions) {
    this.logPath = opts.logPath;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
  }

  /**
   * Start monitoring the given session. Replaces any previous monitor state;
   * the log offset is snapshotted now, so pre-existing entries never fire.
   */
  start(sessionId: string, onError: (message: string) => void): void {
    this.stop();
    this.sessionId = sessionId;
    this.onError = onError;
    this.offset = this.currentSize();
    this.pendingTail = '';
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stop monitoring and clear all state. Safe to call multiple times. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sessionId = null;
    this.onError = null;
    this.pendingTail = '';
  }

  private currentSize(): number {
    try {
      return statSync(this.logPath).size;
    } catch {
      return 0;
    }
  }

  private poll(): void {
    if (this.sessionId === null || this.onError === null) return;

    const size = this.currentSize();
    if (size < this.offset) {
      // Log rotated/truncated: restart from the top of the current file.
      this.offset = 0;
      this.pendingTail = '';
    }
    if (size > this.offset) {
      let chunk: string;
      try {
        const fd = openSync(this.logPath, 'r');
        try {
          const buf = Buffer.alloc(size - this.offset);
          readSync(fd, buf, 0, buf.length, this.offset);
          chunk = buf.toString('utf8');
        } finally {
          closeSync(fd);
        }
      } catch {
        return;
      }
      this.offset = size;
      this.pendingTail += chunk;
    }

    // Scan complete lines (and any trailing line without newline).
    for (const line of this.pendingTail.split('\n')) {
      const message = this.matchLimitError(line);
      if (message === null) continue;
      const onError = this.onError;
      this.stop();
      onError(message);
      return;
    }

    // Keep only the last partial line (everything before the last '\n' was
    // fully scanned above and did not match).
    const lastNewline = this.pendingTail.lastIndexOf('\n');
    if (lastNewline >= 0) {
      this.pendingTail = this.pendingTail.slice(lastNewline + 1);
    }
  }

  /** Match a main-turn stream error line for the monitored session with a
   *  limit/quota reason; returns the extracted error text or null. */
  private matchLimitError(line: string): string | null {
    if (this.sessionId === null) return null;
    if (!line.includes(this.sessionId)) return null;
    if (!STREAM_ERROR_RE.test(line)) return null;
    if (!MAIN_TURN_RE.test(line)) return null;
    const message = ERROR_MESSAGE_RE.exec(line)?.[1];
    if (!message || !LIMIT_ERROR_RE.test(message)) return null;
    return message;
  }
}
