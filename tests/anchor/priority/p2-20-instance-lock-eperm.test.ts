/**
 * Anchor Test: P2-20 实例锁 EPERM 必须视为「进程在运行」
 *
 * 背景（review.md P2-20）：isProcessRunning 用 process.kill(pid, 0) 探活，
 * catch 块无差别返回 false。当 pid 属于其他用户时 kill 抛 EPERM（进程确实
 * 在，只是无权发信号），却被吞成 false → 当成陈旧锁 → 允许第二个实例启动，
 * 破坏单例保证。
 *
 * 修复：EPERM 单独区分返回 true（进程存在，只是无权 signal）。
 *
 * 这个 anchor 让 process.kill 对记录的 pid 抛 EPERM，断言 acquire() 拒绝
 * （throw InstanceAlreadyRunningError）。真红 = 当前 EPERM 被吞成 false，
 * acquire() 走陈旧锁路径成功覆盖锁文件。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InstanceAlreadyRunningError, InstanceLock } from '../../../src/instance-lock.js';

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-20-instance-lock-'));
  lockPath = path.join(tmpDir, 'lark-remote.pid');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P2-20: instance lock treats EPERM as process-running', () => {
  it('test_anchor_instance_lock_eperm_means_running', () => {
    // A pid owned by another user: kill(pid, 0) throws EPERM. The process IS
    // alive (we just lack permission to signal it), so the lock must refuse.
    fs.writeFileSync(lockPath, '54321\nsome-process', 'utf-8');
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number | NodeJS.Signals,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === 54321 && signal === 0) {
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      }
      return true;
    }) as typeof process.kill);

    // GREEN: EPERM → process exists → refuse to acquire (single-instance holds).
    // RED today: EPERM swallowed as false → treated as stale lock → acquire()
    // silently OVERWRITES the pid file, allowing a second instance.
    expect(() => new InstanceLock(lockPath).acquire()).toThrow(InstanceAlreadyRunningError);

    // The pid file must NOT have been overwritten with our own pid (the other
    // instance legitimately owns the lock).
    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe('54321');
  });
});
