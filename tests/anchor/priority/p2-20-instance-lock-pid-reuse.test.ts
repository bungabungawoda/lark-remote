/**
 * Anchor Test: P2-20 实例锁 PID 复用——身份不匹配视为陈旧锁
 *
 * 背景（review.md P2-20①）：陈旧锁里的 pid 被无关进程复用 → 只按 pid 存活判
 * 就会永久误报「在运行」，导致同 configDir 永远启动不了新实例。
 *
 * 修复：锁文件记 `{pid}\n{进程名}`，校验时 pid 活着但身份不匹配 → 判陈旧锁，
 * 允许覆盖。
 *
 * 迁移说明（2026-09-20）：身份判定从「comm 子串比」换成 `platform/identity`
 * 的三态裁决（与 killOrphan 同一判定源），判定函数由构造参数注入。语义与
 * 目标不变：match → 拒绝，mismatch → 接管。
 *
 * 守住的失败模式：只看 pid 不看身份会拒绝取锁（旧实例复活后无法启动）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InstanceLock } from '../../../src/instance-lock.js';

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-20-reuse-'));
  lockPath = path.join(tmpDir, 'lark-remote.pid');
  // 身份裁决只在进程存活时才被咨询：两组用例都要求「pid 活着但换了程序」。
  vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P2-20: instance lock detects PID reuse via identity mismatch', () => {
  it('test_anchor_instance_lock_pid_reuse_treated_as_stale', async () => {
    // Stale lock recorded pid 54321 as "lark-remote". PID 54321 was recycled by
    // an UNRELATED process. Identity verdict: alive, but not our binary.
    fs.writeFileSync(lockPath, '54321\nlark-remote', 'utf-8');

    const seen: string[] = [];
    const lock = new InstanceLock(lockPath, {
      verifyIdentity: async (_pid, expectedBinary) => {
        seen.push(expectedBinary);
        return 'mismatch';
      },
    });

    // GREEN: 身份不匹配 → 陈旧锁 → acquire 覆盖为我们的 pid。
    // RED with old impl: only pid-alive was checked (ignoring identity), so a
    // recycled pid permanently blocked new instances.
    await lock.acquire();
    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe(String(process.pid));
    // 记录名以同一个 binaryName 口径归一后交给判定（两侧口径必须一致）。
    expect(seen).toEqual(['lark-remote']);
  });

  it('test_anchor_instance_lock_identity_match_refuses', async () => {
    // Same pid, same identity → genuinely our instance still running → refuse.
    fs.writeFileSync(lockPath, '54321\nlark-remote', 'utf-8');

    const lock = new InstanceLock(lockPath, { verifyIdentity: async () => 'match' });

    await expect(lock.acquire()).rejects.toThrow();
    // Lock not overwritten.
    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe('54321');
  });
});
