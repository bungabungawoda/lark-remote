/**
 * Anchor Test: P2-19 logger.write 磁盘失败时绝不能抛出杀进程
 *
 * 背景（review.md P2-19③）：write() 里 fs.appendFileSync 无 try/catch。磁盘
 * 满/只读/权限丢失时 appendFileSync 抛出；若发生在 uncaughtException 处理器
 * 里 logger.error(...)，会二次抛出 → Node abort → instanceLock.release() 不
 * 执行，单例锁泄漏。日志绝不能杀进程。
 *
 * 修复：write() 整体 try/catch，吞掉写入异常（最多 stderr 兜底一行）。
 *
 * 这个 anchor 让 fs.appendFileSync 抛出 EACCES，断言 logger.error/info 调用
 * 不抛、返回 undefined。真红 = 当前实现 write 抛出穿透调用方。
 *
 * 同轮一并修 P2-19②：timestampStr 用 toISOString()（UTC），与 todayStr（本地
 * 时区）不一致——本地午夜后前 8 小时新目录里的日志行时间戳还是前一天。修复
 * 后时间戳改本地 ISO 偏移格式，与 todayStr 同一时区。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { Logger } from '../../../src/logger/index.js';

describe('P2-19: logger.write never throws on disk failure', () => {
  let appendSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
  });
  afterEach(() => {
    appendSpy.mockRestore();
  });

  it('test_anchor_logger_write_does_not_throw_on_disk_error', () => {
    const logger = new Logger({ dir: '/tmp/p2-19-logger-test', level: 'info', pid: 12345 });
    // RED today: write() does not catch appendFileSync → this throws EACCES
    // up through error(), which in an uncaughtException handler would abort
    // Node and skip instanceLock.release(). GREEN: write() swallows the
    // disk error so logging never kills the process.
    expect(() => logger.error('something failed')).not.toThrow();
    expect(() => logger.info('info line')).not.toThrow();
    // The append was attempted (proves we reached the write path).
    expect(appendSpy).toHaveBeenCalled();
  });

  it('test_anchor_logger_timestamp_uses_local_timezone', () => {
    // P2-19②: timestampStr used toISOString() (UTC) while todayStr (the
    // directory boundary) used local time. After local midnight in a +08:00
    // zone, the new day's directory held log lines timestamped with the
    // previous UTC day. Fix: timestamp must be a LOCAL ISO-with-offset string
    // so its date matches the daily directory.
    //
    // TZ-independent structural assertion: the bug's toISOString() ALWAYS
    // ends the timestamp token with 'Z' (UTC). The fix's local-offset format
    // ends with '+HH:MM' / '-HH:MM' (never 'Z'). This is deterministic on
    // every timezone, including UTC (where local offset is +00:00, still not
    // 'Z').
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    const now = new Date('2026-08-02T17:30:00.000Z');
    const logger = new Logger({
      dir: '/tmp/p2-19-logger-test',
      level: 'info',
      pid: 12346,
      now: () => now,
    });
    logger.info('local-time line');
    const line = appendSpy.mock.calls.at(-1)?.[1] as string;
    // The timestamp token is everything before ' ['.
    const tsToken = line.split(' [')[0];
    // GREEN: local-offset format, e.g. 2026-08-03T01:30:00.000+08:00.
    // RED today: 2026-08-02T17:30:00.000Z (UTC, ends with 'Z').
    expect(tsToken.endsWith('Z')).toBe(false);
    // And it must carry an explicit offset sign.
    expect(/[+-]\d{2}:\d{2}$/.test(tsToken)).toBe(true);
  });
});
