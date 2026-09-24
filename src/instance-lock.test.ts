import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  InstanceAlreadyRunningError,
  InstanceLock,
  type LockIdentityVerifier,
} from './instance-lock.js';
import { binaryName, type IdentityVerdict } from './platform/identity.js';

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-instance-lock-'));
  lockPath = path.join(tmpDir, 'lark-remote.pid');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 让「pid 存活」探测恒为真：身份裁决只有在进程存活时才被咨询。 */
function stubPidAlive(): void {
  vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
}

/** 让「pid 存活」探测按参数抛 ESRCH（进程已消失）。 */
function stubPidDead(): void {
  vi.spyOn(process, 'kill').mockImplementation((() => {
    throw Object.assign(new Error('missing'), { code: 'ESRCH' });
  }) as typeof process.kill);
}

/** 注入固定身份裁决。 */
function fixedVerdict(verdict: IdentityVerdict): LockIdentityVerifier {
  return async () => verdict;
}

describe('InstanceLock', () => {
  it('writes the current process pid and binary name when acquired', async () => {
    await new InstanceLock(lockPath).acquire();

    // Lock file stores `pid\nbinaryName`; binaryName is the single naming
    // convention shared with killOrphan / platform-identity.
    const raw = fs.readFileSync(lockPath, 'utf-8');
    expect(raw.split('\n')[0]).toBe(String(process.pid));
    expect(raw.split('\n')[1]).toBe(binaryName(process.execPath));
  });

  it('rejects when the recorded instance is alive and identity matches', async () => {
    fs.writeFileSync(lockPath, '12345\nnode', 'utf-8');
    stubPidAlive();

    const lock = new InstanceLock(lockPath, { verifyIdentity: fixedVerdict('match') });

    await expect(lock.acquire()).rejects.toThrow(InstanceAlreadyRunningError);
    // Lock not clobbered.
    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe('12345');
  });

  it('rejects when identity cannot be determined (fail-open, unknown)', async () => {
    // 与 killOrphan 方向相反：查不到身份时锁**不**判陈旧，否则 ps/CIM 一次超时
    // 就能让第二条实例接管一个其实还活着的锁。
    fs.writeFileSync(lockPath, '12345\nnode', 'utf-8');
    stubPidAlive();

    const lock = new InstanceLock(lockPath, { verifyIdentity: fixedVerdict('unknown') });

    await expect(lock.acquire()).rejects.toThrow(InstanceAlreadyRunningError);
    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe('12345');
  });

  it('replaces a stale pid file (recorded process is gone)', async () => {
    fs.writeFileSync(lockPath, '12345\nold-process', 'utf-8');
    stubPidDead();

    await new InstanceLock(lockPath).acquire();

    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe(String(process.pid));
  });

  it('takes over when the pid was recycled by an unrelated process', async () => {
    // pid 存活但身份不符 = pid 复用：锁已陈旧，可接管。
    fs.writeFileSync(lockPath, '12345\nnode', 'utf-8');
    stubPidAlive();

    const lock = new InstanceLock(lockPath, { verifyIdentity: fixedVerdict('mismatch') });

    await lock.acquire();

    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe(String(process.pid));
  });

  it('normalizes the recorded name before comparing it', async () => {
    // 老锁文件里存的是 ps comm 的全路径形态；不归一就会永远判「名字不符」。
    fs.writeFileSync(lockPath, '12345\n/usr/local/bin/node', 'utf-8');
    stubPidAlive();

    const seen: string[] = [];
    const lock = new InstanceLock(lockPath, {
      verifyIdentity: async (_pid, expectedBinary) => {
        seen.push(expectedBinary);
        return 'match';
      },
    });

    await expect(lock.acquire()).rejects.toThrow(InstanceAlreadyRunningError);
    expect(seen).toEqual(['node']);
  });

  it('only releases a lock owned by the current process', () => {
    fs.writeFileSync(lockPath, '12345\nother', 'utf-8');

    new InstanceLock(lockPath).release();

    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe('12345');
  });
});

describe('InstanceLock acquire edge cases', () => {
  it('re-acquires after stale lock with pid\\nname format', async () => {
    fs.writeFileSync(lockPath, '12345\nold-process', 'utf-8');
    stubPidAlive();

    const lock = new InstanceLock(lockPath, { verifyIdentity: fixedVerdict('mismatch') });

    await lock.acquire();

    const raw = fs.readFileSync(lockPath, 'utf-8');
    expect(raw.split('\n')[0]).toBe(String(process.pid));
  });

  it('throws InstanceAlreadyRunningError when stale-lock retry hits EEXIST again (race)', async () => {
    fs.writeFileSync(lockPath, '12345\nold-process', 'utf-8');
    stubPidAlive();

    // Mock openSync: first call throws EEXIST, after unlink the second call also throws EEXIST
    vi.spyOn(fs, 'openSync').mockImplementation((..._args: unknown[]) => {
      const err = new Error('file exists') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    });

    const lock = new InstanceLock(lockPath, { verifyIdentity: fixedVerdict('match') });

    await expect(lock.acquire()).rejects.toThrow(InstanceAlreadyRunningError);
  });

  it('throws InstanceAlreadyRunningError with pid=-1 when race lock has malformed content', async () => {
    fs.writeFileSync(lockPath, '12345\nold-process', 'utf-8');
    stubPidAlive();

    // Mock openSync: first call EEXIST (enters stale path), second call also EEXIST (race)
    let openCallCount = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((..._args: unknown[]) => {
      openCallCount++;
      // After the first EEXIST triggers unlink+retry, write malformed content before second read
      if (openCallCount === 2) {
        fs.writeFileSync(lockPath, 'not-a-number\n', 'utf-8');
      }
      const err = new Error('file exists') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    });

    // identity verdict: the surviving pid's identity does not match → stale.
    const lock = new InstanceLock(lockPath, { verifyIdentity: fixedVerdict('mismatch') });

    try {
      await lock.acquire();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InstanceAlreadyRunningError);
      // PID should be -1 because the malformed lock has no valid PID
      expect((err as InstanceAlreadyRunningError).pid).toBe(-1);
    }
  });

  it('re-throws non-EEXIST errors from openSync', async () => {
    fs.writeFileSync(lockPath, '12345\nprocess', 'utf-8');
    stubPidAlive();

    let openSyncCallCount = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((..._args) => {
      openSyncCallCount++;
      if (openSyncCallCount === 1) {
        // First call: throw EEXIST to enter stale-lock path
        const err = new Error('file exists') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      // Second call: throw a non-EEXIST error
      throw new Error('permission denied');
    });

    const lock = new InstanceLock(lockPath, { verifyIdentity: fixedVerdict('mismatch') });

    await expect(lock.acquire()).rejects.toThrow('permission denied');
  });

  it('releases the lock when current process owns it', async () => {
    const lock = new InstanceLock(lockPath);
    await lock.acquire();
    expect(fs.existsSync(lockPath)).toBe(true);

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('InstanceLock registerExitHandlers', () => {
  it('registers exit, SIGINT, SIGTERM, and SIGHUP handlers', () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);

    const lock = new InstanceLock(lockPath);
    lock.registerExitHandlers();

    expect(onSpy).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    if (process.platform !== 'win32') {
      expect(onSpy).toHaveBeenCalledWith('SIGHUP', expect.any(Function));
    }
  });
});

describe('InstanceLock readPidAndName edge cases', () => {
  it('handles malformed lock file by unlinking it and returning undefined', async () => {
    // Write a lock file with non-numeric PID
    fs.writeFileSync(lockPath, 'not-a-pid\nsome-name', 'utf-8');

    // acquire should handle the malformed file: unlink it and proceed
    await new InstanceLock(lockPath).acquire();

    const raw = fs.readFileSync(lockPath, 'utf-8');
    expect(raw.split('\n')[0]).toBe(String(process.pid));
  });

  it('handles missing lock file gracefully', () => {
    const lock = new InstanceLock(lockPath);

    // release on non-existent lock should not throw
    expect(() => lock.release()).not.toThrow();
  });
});
