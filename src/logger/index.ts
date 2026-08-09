import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { format } from 'node:util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_UPPER: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

interface LoggerOptions {
  /** Log directory. Defaults to ~/.lark-remote/logs */
  dir?: string;
  /** Minimum level to write. Defaults to 'info'. */
  level?: LogLevel;
  /** File prefix. Defaults to 'lark-remote'. */
  prefix?: string;
  /** Override pid (for testing). */
  pid?: number;
  /** Override now() (for testing). */
  now?: () => Date;
}

function todayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function timestampStr(d: Date): string {
  // P2-19②: local ISO 8601 with milliseconds and explicit offset, e.g.
  // 2026-08-03T01:30:00.000+08:00. Previously this used toISOString() (UTC)
  // while the daily directory boundary (todayStr) used local time — after
  // local midnight in a +08:00 zone the new day's directory held lines
  // timestamped with the previous UTC day. Local offset keeps the timestamp's
  // calendar date consistent with the directory date across all timezones.
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absOff = Math.abs(offsetMin);
  const offH = pad(Math.floor(absOff / 60));
  const offM = pad(absOff % 60);
  return `${y}-${mo}-${da}T${h}:${mi}:${s}.${ms}${sign}${offH}:${offM}`;
}

/**
 * File-based logger with daily rotation.
 *
 * - Each day gets its own subdirectory: `<dir>/YYYY-MM-DD/`.
 * - Log files are named `<prefix>-<pid>.log` inside the daily subdirectory.
 * - When the calendar date changes (across midnight), a new directory and file
 *   are created automatically, so each file never spans two days.
 * - Nothing is written to stdout/stderr; all output goes to the file.
 * - Writes are synchronous (fs.appendFileSync) — log volume is low and this
 *   guarantees ordering without leaving dangling file handles on exit.
 */
export class Logger {
  private dir: string;
  private level: number;
  private prefix: string;
  private pid: number;
  private now: () => Date;

  private currentDate: string = '';
  private currentFile: string = '';

  constructor(opts: LoggerOptions = {}) {
    this.dir = opts.dir ?? path.join(os.homedir(), '.lark-remote', 'logs');
    this.level = LEVEL_ORDER[opts.level ?? 'info'];
    this.prefix = opts.prefix ?? 'lark-remote';
    this.pid = opts.pid ?? process.pid;
    this.now = opts.now ?? (() => new Date());
  }

  /** Get the current log file path (e.g., ~/.lark-remote/logs/2026-07-11/lark-remote-12345.log). */
  getCurrentLogFile(): string {
    // Ensure the file is up-to-date before returning
    this.ensureFile(this.now());
    return this.currentFile;
  }

  private ensureFile(date: Date): string {
    const dateStr = todayStr(date);
    if (this.currentFile && this.currentDate === dateStr) return this.currentFile;

    // Date changed (or first call): rotate to a new daily subdirectory
    const dayDir = path.join(this.dir, dateStr);
    fs.mkdirSync(dayDir, { recursive: true });
    this.currentFile = path.join(dayDir, `${this.prefix}-${this.pid}.log`);
    this.currentDate = dateStr;
    // P2-19①: prune daily log directories older than the retention window so
    // the logs directory does not grow without bound (single-day size cap is
    // out of scope; bounded retention by day is the requested guard). Wrapped
    // defensively so cleanup failure never blocks logging.
    this.pruneOldDirs(dateStr);
    return this.currentFile;
  }

  /**
   * P2-19①: remove daily subdirectories older than the retention window.
   * Best-effort — any error is swallowed (logging must never throw).
   */
  private pruneOldDirs(currentDateStr: string): void {
    const RETENTION_DAYS = 30;
    try {
      const entries = fs.readdirSync(this.dir, { withFileTypes: true });
      const cutoff = new Date(`${currentDateStr}T00:00:00`).getTime() - RETENTION_DAYS * 86400000;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Only prune directories that look like YYYY-MM-DD daily dirs.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
        const t = new Date(`${entry.name}T00:00:00`).getTime();
        if (Number.isNaN(t)) continue;
        if (t < cutoff) {
          fs.rmSync(path.join(this.dir, entry.name), { recursive: true, force: true });
        }
      }
    } catch {
      /* best-effort cleanup; never throw */
    }
  }

  private write(level: LogLevel, args: unknown[]): void {
    if (LEVEL_ORDER[level] < this.level) return;

    const date = this.now();
    const ts = timestampStr(date);
    const message = format(...args);
    const line = `${ts} [${LEVEL_UPPER[level]}] ${message}\n`;

    const file = this.ensureFile(date);
    // P2-19③: never let a disk error (EACCES / ENOSPC / EROFS) escape write().
    // If logging itself throws — especially inside an uncaughtException handler
    // that calls logger.error(...) — a re-throw would abort Node and skip
    // instanceLock.release(), leaking the singleton lock. Logging must never
    // kill the process. Fall back to a single stderr line for diagnosis.
    try {
      fs.appendFileSync(file, line);
    } catch {
      try {
        process.stderr.write(`[logger] failed to write log: ${message}\n`);
      } catch {
        /* nothing left to do; never throw */
      }
    }
  }

  debug(...args: unknown[]): void {
    this.write('debug', args);
  }
  info(...args: unknown[]): void {
    this.write('info', args);
  }
  warn(...args: unknown[]): void {
    this.write('warn', args);
  }
  error(...args: unknown[]): void {
    this.write('error', args);
  }

  /** Reset internal file state so the next write rotates to a fresh daily file. */
  close(): void {
    this.currentFile = '';
    this.currentDate = '';
  }
}

// --- Singleton ---

let defaultLogger: Logger = new Logger();

/**
 * Initialize (or reinitialize) the global logger. Must be called once at
 * startup, before any logging is expected to land in the right place.
 * Returns the initialized logger.
 */
export function initLogger(opts: LoggerOptions): Logger {
  defaultLogger.close();
  defaultLogger = new Logger(opts);
  return defaultLogger;
}

export function getLogger(): Logger {
  return defaultLogger;
}
