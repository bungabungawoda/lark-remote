import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InstanceAlreadyRunningError, InstanceLock } from './instance-lock.js';

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

describe('InstanceLock', () => {
  it('writes the current process pid when acquired', () => {
    new InstanceLock(lockPath).acquire();

    // P2-20: lock file now stores `pid\ncomm` (comm = owning process command
    // name, used to defend against PID reuse). The pid is the first line.
    const raw = fs.readFileSync(lockPath, 'utf-8');
    expect(raw.split('\n')[0]).toBe(String(process.pid));
  });

  it('rejects when another recorded process is still running', () => {
    fs.writeFileSync(lockPath, '12345\nnode', 'utf-8');
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number | NodeJS.Signals,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === 12345 && signal === 0) return true;
      return true;
    }) as typeof process.kill);

    expect(() => new InstanceLock(lockPath).acquire()).toThrow(InstanceAlreadyRunningError);
  });

  it('replaces a stale pid file', () => {
    fs.writeFileSync(lockPath, '12345\nold-process', 'utf-8');
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number | NodeJS.Signals,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === 12345 && signal === 0)
        throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);

    new InstanceLock(lockPath).acquire();

    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe(String(process.pid));
  });

  it('only releases a lock owned by the current process', () => {
    fs.writeFileSync(lockPath, '12345\nother', 'utf-8');

    new InstanceLock(lockPath).release();

    expect(fs.readFileSync(lockPath, 'utf-8').split('\n')[0]).toBe('12345');
  });
});

describe('InstanceLock acquire edge cases', () => {
  it('re-acquires after stale lock with pid\\ncomm format', () => {
    // Write a stale lock with the new format
    fs.writeFileSync(lockPath, '12345\nold-process', 'utf-8');

    // Mock isProcessRunning to say the old process is dead
    const lock = new InstanceLock(lockPath, {
      isProcessRunning: () => false,
    });

    lock.acquire();

    const raw = fs.readFileSync(lockPath, 'utf-8');
    expect(raw.split('\n')[0]).toBe(String(process.pid));
  });

  it('throws InstanceAlreadyRunningError when stale-lock retry hits EEXIST again (race)', () => {
    // Create a lock file that appears stale
    fs.writeFileSync(lockPath, '12345\nold-process', 'utf-8');

    // Mock openSync: first call throws EEXIST, after unlink the second call also throws EEXIST
    let _openCallCount = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((..._args: unknown[]) => {
      _openCallCount++;
      const err = new Error('file exists') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    });

    // isProcessRunning: both calls return true (process alive)
    const lock = new InstanceLock(lockPath, {
      isProcessRunning: () => true,
    });

    expect(() => lock.acquire()).toThrow(InstanceAlreadyRunningError);
  });

  it('throws InstanceAlreadyRunningError with pid=-1 when race lock has malformed content', () => {
    // Create initial lock
    fs.writeFileSync(lockPath, '12345\nold-process', 'utf-8');

    // Mock openSync: first call EEXIST (enters stale path), second call also EEXIST (race)
    let _openCallCount2 = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((..._args: unknown[]) => {
      _openCallCount2++;
      // After the first EEXIST triggers unlink+retry, write malformed content before second read
      if (_openCallCount2 === 2) {
        fs.writeFileSync(lockPath, 'not-a-number\n', 'utf-8');
      }
      const err = new Error('file exists') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    });

    // isProcessRunning: first call = dead (stale), second call = alive (race)
    let isRunningCallCount = 0;
    const lock = new InstanceLock(lockPath, {
      isProcessRunning: () => {
        isRunningCallCount++;
        return isRunningCallCount > 1; // stale=dead, race=alive
      },
    });

    try {
      lock.acquire();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InstanceAlreadyRunningError);
      // PID should be -1 because the malformed lock has no valid PID
      expect((err as InstanceAlreadyRunningError).pid).toBe(-1);
    }
  });

  it('re-throws non-EEXIST errors from openSync', () => {
    // Create lock file so the first openSync('wx') fails with EEXIST
    fs.writeFileSync(lockPath, '12345\nprocess', 'utf-8');

    // isProcessRunning returns false (stale), so we try to unlink + retry
    // On retry, throw a non-EEXIST error
    let openSyncCallCount = 0;
    const _origOpenSync = fs.openSync;
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

    const lock = new InstanceLock(lockPath, {
      isProcessRunning: () => false,
    });

    expect(() => lock.acquire()).toThrow('permission denied');
  });

  it('releases the lock when current process owns it', () => {
    const lock = new InstanceLock(lockPath, {
      isProcessRunning: () => false,
    });
    lock.acquire();
    expect(fs.existsSync(lockPath)).toBe(true);

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('InstanceLock registerExitHandlers', () => {
  it('registers exit, SIGINT, SIGTERM, and SIGHUP handlers', () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);

    const lock = new InstanceLock(lockPath, {
      isProcessRunning: () => false,
    });
    lock.registerExitHandlers();

    expect(onSpy).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    if (process.platform !== 'win32') {
      expect(onSpy).toHaveBeenCalledWith('SIGHUP', expect.any(Function));
    }
  });
});

describe('InstanceLock readPidAndComm edge cases', () => {
  it('handles malformed lock file by unlinking it and returning undefined', () => {
    // Write a lock file with non-numeric PID
    fs.writeFileSync(lockPath, 'not-a-pid\nsome-comm', 'utf-8');

    const lock = new InstanceLock(lockPath, {
      isProcessRunning: () => false,
    });

    // acquire should handle the malformed file: unlink it and proceed
    lock.acquire();

    // Lock should now contain our PID
    const raw = fs.readFileSync(lockPath, 'utf-8');
    expect(raw.split('\n')[0]).toBe(String(process.pid));
  });

  it('handles missing lock file gracefully', () => {
    const lock = new InstanceLock(lockPath, {
      isProcessRunning: () => false,
    });

    // release on non-existent lock should not throw
    lock.release();
  });
});

describe('defaultIsProcessRunning comm matching', () => {
  it('defends against PID reuse when comm name does not match', () => {
    fs.writeFileSync(lockPath, '12345\nnode', 'utf-8');

    // Simulate: pid is alive (ESRCH not thrown) but comm is different
    const lock = new InstanceLock(lockPath, {
      isProcessRunning: (pid, expectedComm) => {
        // When expectedComm is 'node', simulate PID reuse by returning false
        // (this would be called by the defaultIsProcessRunning logic)
        if (pid === 12345 && expectedComm === 'node') return false;
        return true;
      },
    });

    // Should succeed — comm mismatch means stale PID
    lock.acquire();

    const raw = fs.readFileSync(lockPath, 'utf-8');
    expect(raw.split('\n')[0]).toBe(String(process.pid));
  });

  it('rejects when pid is alive and comm matches', () => {
    fs.writeFileSync(lockPath, '12345\nnode', 'utf-8');

    const lock = new InstanceLock(lockPath, {
      isProcessRunning: () => true,
    });

    expect(() => lock.acquire()).toThrow(InstanceAlreadyRunningError);
  });
});
