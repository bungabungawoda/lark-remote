import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { silentlyUnlink } from './common/fs.js';

export class InstanceAlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    readonly lockPath: string,
  ) {
    super(`lark-remote is already running for this config: pid ${pid}`);
  }
}

/**
 * Probe whether a pid is alive. P2-20:
 *  - process.kill(pid, 0) returning normally → alive.
 *  - ESRCH (no such process) → dead.
 *  - EPERM (operation not permitted) → the process EXISTS but is owned by
 *    another user; we just lack permission to signal it. Returning true here
 *    is correct: the single instance that owns the lock is still running, so
 *    we must refuse to acquire. Previously EPERM was swallowed as "not
 *    running", allowing a second instance to overwrite the lock.
 *  - EINVAL / other → conservative true (do not clobber a lock we cannot
 *    prove is stale).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM and any unexpected error → assume alive (never clobber a lock
    // we cannot disprove is held by a running instance).
    return true;
  }
}

export class InstanceLock {
  /**
   * P2-20: injectable process-running probe for testing, and a process-name
   * verifier to defend against PID reuse (a stale pid recycled by an unrelated
   * process would otherwise be misjudged as "our instance still running").
   * Default implementation checks the process name via `ps` when available.
   */
  private readonly isProcessRunning: (pid: number, expectedComm: string | undefined) => boolean;

  constructor(
    private readonly lockPath: string,
    opts?: { isProcessRunning?: (pid: number, expectedComm: string | undefined) => boolean },
  ) {
    this.isProcessRunning =
      opts?.isProcessRunning ?? ((pid, expectedComm) => defaultIsProcessRunning(pid, expectedComm));
  }

  acquire(): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });

    // Atomic create-with-exclusive: 'wx' fails if file already exists.
    // This eliminates the TOCTOU race between readPid+isProcessRunning
    // and writeFileSync in the previous implementation.
    try {
      const fd = fs.openSync(this.lockPath, 'wx');
      fs.writeSync(fd, this.lockContents(process.pid));
      fs.closeSync(fd);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock file exists — check if the owner is still alive
        const { pid, comm } = this.readPidAndComm();
        if (pid && this.isProcessRunning(pid, comm)) {
          throw new InstanceAlreadyRunningError(pid, this.lockPath);
        }
        // Stale lock: remove and retry once
        silentlyUnlink(this.lockPath);
        try {
          const fd = fs.openSync(this.lockPath, 'wx');
          fs.writeSync(fd, this.lockContents(process.pid));
          fs.closeSync(fd);
        } catch (retryErr: unknown) {
          if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
            // Another process created the lock between unlink and retry.
            // Bounded retry (max 1): give up rather than recurse.
            const { pid, comm } = this.readPidAndComm();
            if (pid && this.isProcessRunning(pid, comm)) {
              throw new InstanceAlreadyRunningError(pid, this.lockPath);
            }
            // New lock is also stale — give up rather than recurse.
            throw new InstanceAlreadyRunningError(pid ?? -1, this.lockPath);
          }
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
  }

  release(): void {
    const { pid } = this.readPidAndComm();
    if (pid === process.pid) {
      silentlyUnlink(this.lockPath);
    }
  }

  registerExitHandlers(): void {
    process.on('exit', () => this.release());
    process.on('SIGINT', () => {
      this.release();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      this.release();
      process.exit(143);
    });
    if (process.platform !== 'win32') {
      process.on('SIGHUP', () => {
        this.release();
        process.exit(129);
      });
    }
  }

  /**
   * Lock file stores `pid\ncomm` where comm is the owning process's command
   * name (captured at acquire time). On stale-lock checks we verify the
   * recorded pid is still alive AND still running a process whose comm
   * matches — defending against PID reuse where an unrelated process recycled
   * the stale pid.
   */
  private lockContents(pid: number): string {
    return `${pid}\n${currentComm()}`;
  }

  private readPidAndComm(): { pid: number | undefined; comm: string | undefined } {
    if (!fs.existsSync(this.lockPath)) return { pid: undefined, comm: undefined };
    const raw = fs.readFileSync(this.lockPath, 'utf-8').trim();
    const [pidStr, ...commParts] = raw.split('\n');
    const pid = Number(pidStr);
    const comm = commParts.join('\n') || undefined;
    if (Number.isInteger(pid) && pid > 0 && comm) return { pid, comm };
    // Malformed or missing comm — treat as corrupt, unlink and return undefined
    silentlyUnlink(this.lockPath);
    return { pid: undefined, comm: undefined };
  }
}

/**
 * Default probe: alive by ESRCH/EPERM semantics, plus a weak comm-name match
 * to reject PID reuse. If `ps` is unavailable we fall back to the pid-alive
 * check alone (no false negatives, only weaker reuse protection).
 */
function defaultIsProcessRunning(pid: number, expectedComm: string | undefined): boolean {
  if (!isPidAlive(pid)) return false;
  if (!expectedComm) return false;
  const actualComm = readComm(pid);
  if (actualComm === null) return true; // ps unavailable → trust pid-alive
  // Match on the basename so `/usr/local/bin/node` vs `node` still align.
  const base = (s: string) => s.split('/').pop() ?? s;
  return base(actualComm) === base(expectedComm) || actualComm.includes(expectedComm);
}

function currentComm(): string {
  return readComm(process.pid) ?? 'lark-remote';
}

function readComm(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
