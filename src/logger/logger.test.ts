import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Logger } from './index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-bridge-log-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Recursively find all .log files under tmpDir, returning relative paths. */
function readLogs(): string[] {
  const results: string[] = [];
  function walk(dir: string, prefix: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith('.log')) {
        results.push(rel);
      }
    }
  }
  walk(tmpDir, '');
  return results.sort();
}

/** Read file content by relative path under tmpDir. */
function readContent(rel: string): string {
  return fs.readFileSync(path.join(tmpDir, rel), 'utf-8');
}

describe('Logger', () => {
  it('writes to a file inside daily subdirectory', () => {
    const fixedDate = new Date('2026-06-17T12:00:00.000Z');
    const logger = new Logger({
      dir: tmpDir,
      level: 'info',
      pid: 12345,
      now: () => fixedDate,
    });
    logger.info('hello world');
    logger.close();

    const files = readLogs();
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('2026-06-17/lark-remote-12345.log');

    const content = readContent(files[0]);
    expect(content).toContain('[INFO]');
    expect(content).toContain('hello world');
    // P2-19②: timestamp is now a LOCAL ISO-with-offset string (not UTC 'Z'),
    // so its calendar date matches the daily directory date. The local date
    // for 2026-06-17T12:00:00.000Z in this timezone is 2026-06-17 (the
    // directory above), so the timestamp line must start with that local date
    // and carry an explicit +HH:MM / -HH:MM offset (never 'Z').
    expect(content).toContain('2026-06-17');
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('respects level filtering', () => {
    const fixedDate = new Date('2026-06-17T12:00:00.000Z');
    const logger = new Logger({
      dir: tmpDir,
      level: 'warn',
      pid: 1,
      now: () => fixedDate,
    });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.close();

    const content = readContent(readLogs()[0]);
    expect(content).not.toContain(']d');
    expect(content).not.toContain('[INFO]');
    expect(content).toContain('[WARN]');
    expect(content).toContain('[ERROR]');
  });

  it('rotates to a new subdirectory when the date changes', () => {
    // Use local-time dates that actually cross midnight in the host timezone.
    let current = new Date(2026, 5, 17, 23, 59, 0); // 2026-06-17 23:59 local
    const logger = new Logger({
      dir: tmpDir,
      level: 'info',
      pid: 99,
      now: () => current,
    });
    logger.info('day1');
    current = new Date(2026, 5, 18, 0, 1, 0); // 2026-06-18 00:01 local
    logger.info('day2');
    logger.close();

    const files = readLogs();
    expect(files).toHaveLength(2);
    expect(files).toContain('2026-06-17/lark-remote-99.log');
    expect(files).toContain('2026-06-18/lark-remote-99.log');
    expect(readContent('2026-06-17/lark-remote-99.log')).toContain('day1');
    expect(readContent('2026-06-18/lark-remote-99.log')).toContain('day2');
  });

  it('formats multiple arguments like console', () => {
    const fixedDate = new Date('2026-06-17T12:00:00.000Z');
    const logger = new Logger({
      dir: tmpDir,
      level: 'debug',
      pid: 1,
      now: () => fixedDate,
    });
    const err = new Error('boom');
    logger.error('failed:', err.message, { code: 42 });
    logger.close();

    const content = readContent(readLogs()[0]);
    expect(content).toContain('failed: boom');
    expect(content).toContain('code: 42');
  });

  it('does not write anything to stdout', () => {
    const fixedDate = new Date('2026-06-17T12:00:00.000Z');
    const logger = new Logger({
      dir: tmpDir,
      level: 'debug',
      pid: 1,
      now: () => fixedDate,
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger.info('nothing to stdout');
    logger.close();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
    errSpy.mockRestore();
  });
});
