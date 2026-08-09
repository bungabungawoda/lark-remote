/**
 * Anchor Test: P2-20 实例锁 PID 复用——comm 名不匹配视为陈旧锁
 *
 * 背景（review.md P2-20①）：陈旧锁里的 pid 被无关进程复用 → isProcessRunning
 * 只看 pid 活着就永久误报「在运行」，导致同 configDir 永远启动不了新实例。
 *
 * 修复：锁文件记 `{pid}\n{comm}`（启动时进程名），校验时 pid 活着但 comm 名
 * 不匹配 → 判陈旧锁，允许覆盖。isProcessRunning 抽成可注入依赖以便测试。
 *
 * 这个 anchor 注入一个 probe：pid 活着但 comm 与锁文件记录的不匹配，断言
 * acquire() 覆盖陈旧锁（而非拒绝）。真红 = 旧实现只看 pid 不看 comm，会拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InstanceLock } from '../../../src/instance-lock.js';

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-20-reuse-'));
  lockPath = path.join(tmpDir, 'lark-remote.pid');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P2-20: instance lock detects PID reuse via comm mismatch', () => {
  it('test_anchor_instance_lock_pid_reuse_treated_as_stale', () => {
    // Stale lock recorded pid 54321 running comm "lark-remote". PID 54321 was
    // recycled by an UNRELATED process ("some-other-daemon"). The injected
    // probe reports: pid alive, but comm does NOT match the recorded one.
    fs.writeFileSync(lockPath, '54321\nlark-remote', 'utf-8');

    const lock = new InstanceLock(lockPath, {
      isProcessRunning: (_pid, expectedComm) => {
        // pid is alive, but it's now a different program → NOT our instance.
        return expectedComm === 'some-other-daemon';
      },
    });

    // GREEN: comm mismatch → stale lock → acquire overwrites with our pid.
    // RED with old impl: only pid-alive was checked (ignoring comm), so a
    // recycled pid permanently blocked new instances.
    lock.acquire();
    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe(String(process.pid));
  });

  it('test_anchor_instance_lock_comm_match_refuses', () => {
    // Same pid, same comm → genuinely our instance still running → refuse.
    fs.writeFileSync(lockPath, '54321\nlark-remote', 'utf-8');

    const lock = new InstanceLock(lockPath, {
      isProcessRunning: (_pid, expectedComm) => expectedComm === 'lark-remote',
    });

    expect(() => lock.acquire()).toThrow();
    // Lock not overwritten.
    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe('54321');
  });
});
