/**
 * 单实例锁（configDir 粒度）。
 *
 * 锁文件固定两行：`pid\n<进程名>`。进程名用于 pid 复用防护——锁定进程崩溃后
 * pid 可能被系统回收给无关进程，纯 `kill(pid, 0)` 存活探测分不出来。
 *
 * 校验单源 = `platform/identity`（与 killOrphan 同一套判定、同一套名字口径）：
 *   - posix `ps -o command=`（**不用 comm**：bash/垫片包装的进程 comm 只会给
 *     解释器名，拿它比对会假阴性）；
 *   - win32 CIM `Get-CimInstance Win32_Process`（Windows 没有 ps）。
 * 名字两侧都必须过 `binaryName`：记录值与比较口径各写一份就会永远判「名字
 * 不符 → 陈旧」，等于自造一次半迁移。
 *
 * 与 killOrphan 的差异：killOrphan 是 fail-closed（身份不明就不杀进程），
 * 这里是 fail-open（身份不明就认定锁还活着，绝不 clobber 无法证伪的锁）。
 * 两者方向相反，因此身份判定取三态而不是布尔。
 */
import fs from 'node:fs';
import path from 'node:path';
import { silentlyUnlink } from './common/fs.js';
import { binaryName, verifyPidIdentityVerdict, type IdentityVerdict } from './platform/identity.js';

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

/** 锁持有者身份判定（测试注入点）；默认 = platform/identity 的真实查询。 */
export type LockIdentityVerifier = (
  pid: number,
  expectedBinary: string,
) => Promise<IdentityVerdict>;

export interface InstanceLockOptions {
  /**
   * 注入身份判定（测试用）。缺省走真实查询；win32 上一次查询要拉起
   * PowerShell（冷启动约 1s），但只在「锁文件已存在」（陈旧锁/取锁竞态）
   * 这条路径上发生，不在正常启动路径上。
   */
  verifyIdentity?: LockIdentityVerifier;
}

export class InstanceLock {
  private readonly verifyIdentity: LockIdentityVerifier;

  constructor(
    private readonly lockPath: string,
    opts?: InstanceLockOptions,
  ) {
    this.verifyIdentity =
      opts?.verifyIdentity ??
      ((pid, expectedBinary) => verifyPidIdentityVerdict(pid, { expectedBinary }));
  }

  /**
   * 取锁。**异步**是接口的一部分：身份校验走 platform/identity（win32 侧是
   * 异步 CIM 查询），调用方必须 await——漏 await 会在校验完成前就放行第二条
   * 实例（这正是锁要防的事）。
   */
  async acquire(): Promise<void> {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });

    // Atomic create-with-exclusive: 'wx' fails if file already exists.
    // This eliminates the TOCTOU race between readPid+verification
    // and writeFileSync in the previous implementation.
    try {
      const fd = fs.openSync(this.lockPath, 'wx');
      fs.writeSync(fd, this.lockContents(process.pid));
      fs.closeSync(fd);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock file exists — check if the owner is still alive
        const { pid, name } = this.readPidAndName();
        if (pid && (await this.isHeldByLiveInstance(pid, name))) {
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
            const { pid, name } = this.readPidAndName();
            if (pid && (await this.isHeldByLiveInstance(pid, name))) {
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
    const { pid } = this.readPidAndName();
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
    } else {
      // win32 无 SIGHUP；CTRL_BREAK 退出前也要释放锁（§3.5，对照 cli.ts 信号转发）
      process.on('SIGBREAK', () => {
        this.release();
        process.exit(149);
      });
    }
  }

  /**
   * Lock file stores `pid\nbinaryName`, the owning process's executable name
   * captured at acquire time. `binaryName(process.execPath)` 是唯一在
   * posix/win32 都稳定可比的口径：win32 没有 ps，而 execPath（`C:\...\node.exe`）
   * 与 CIM CommandLine 首 token 归一后必然一致（bun/node 垫片场景亦然）。
   */
  private lockContents(pid: number): string {
    return `${pid}\n${binaryName(process.execPath)}`;
  }

  private readPidAndName(): { pid: number | undefined; name: string | undefined } {
    if (!fs.existsSync(this.lockPath)) return { pid: undefined, name: undefined };
    const raw = fs.readFileSync(this.lockPath, 'utf-8').trim();
    const [pidStr, ...nameParts] = raw.split('\n');
    const pid = Number(pidStr);
    const name = nameParts.join('\n') || undefined;
    if (Number.isInteger(pid) && pid > 0 && name) return { pid, name };
    // Malformed or missing name — treat as corrupt, unlink and return undefined
    silentlyUnlink(this.lockPath);
    return { pid: undefined, name: undefined };
  }

  /**
   * 锁是否仍由「我们的」实例持有（fail-open 三态）：
   *   - 进程不存在             → false（陈旧）
   *   - 无记录名（老/损坏文件）→ false（无法验证，与迁移前同口径按陈旧处理）
   *   - 身份 match             → true（锁定实例还在跑，拒绝取锁）
   *   - 身份 mismatch          → false（pid 已复用给无关进程，陈旧可接管）
   *   - 身份 unknown           → true（查不到身份，宁可拒绝也不 clobber）
   */
  private async isHeldByLiveInstance(pid: number, name: string | undefined): Promise<boolean> {
    if (!isPidAlive(pid)) return false;
    if (!name) return false;
    // 记录名过 binaryName 归一：老锁文件里存的是 ps comm 的全路径形态，
    // 不归一的话升级后第一次启动会把它误判成「名字不符 → 陈旧」。
    const verdict = await this.verifyIdentity(pid, binaryName(name));
    return verdict !== 'mismatch';
  }
}
