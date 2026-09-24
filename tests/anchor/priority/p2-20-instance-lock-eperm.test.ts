/**
 * Anchor Test: P2-20 实例锁 EPERM 必须视为「进程在运行」
 *
 * 背景（review.md P2-20）：存活探测用 process.kill(pid, 0)，catch 块无差别返回
 * false。当 pid 属于其他用户时 kill 抛 EPERM（进程确实在，只是无权发信号），
 * 却被吞成 false → 当成陈旧锁 → 允许第二个实例启动，破坏单例保证。
 *
 * 修复：EPERM 单独区分返回 true（进程存在，只是无权 signal）。
 *
 * 迁移说明（2026-09-20）：身份判定收口到 `platform/identity` 三态后，存活探测
 * （isPidAlive）成为身份判定之前的第一道闸——**EPERM 被吞成 false 的后果变成
 * 「根本不会去咨询身份判定」**。因此本 anchor 除了断言拒绝取锁，还断言身份
 * 判定确实被咨询过：漏掉这条，把 kill 探活整个删掉也能让「拒绝」成立。
 *
 * 守住的失败模式：EPERM 被吞成 false → acquire() 走陈旧锁路径成功覆盖锁文件。
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
  it('test_anchor_instance_lock_eperm_means_running', async () => {
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

    let identityQueries = 0;
    const lock = new InstanceLock(lockPath, {
      // 查不到身份 → fail-open 认定锁还活着。这里注入固定 `unknown` 是为了让
      // 用例不依赖真实 ps/CIM；重点是「探活过了 EPERM 这一关、真的走到身份判定」。
      verifyIdentity: async () => {
        identityQueries++;
        return 'unknown';
      },
    });

    // GREEN: EPERM → 进程存在 → 咨询身份判定 → 拒绝取锁（单例保证成立）。
    // RED today: EPERM swallowed as false → treated as stale lock → acquire()
    // silently OVERWRITES the pid file, allowing a second instance.
    await expect(lock.acquire()).rejects.toThrow(InstanceAlreadyRunningError);
    expect(identityQueries).toBe(1);

    // The pid file must NOT have been overwritten with our own pid (the other
    // instance legitimately owns the lock).
    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe('54321');
  });
});
