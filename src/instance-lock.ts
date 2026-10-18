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
 *
 * 陈旧锁接管是「原子改名 + 复核」两步：
 * 旧实现 read→isHeldByLive→unlink→create 四个动作不是原子的，两个进程可以
 * 先后 unlink 掉对方刚创建的锁，双双认为自己持锁。现在改成：
 *   1. `rename(lock → quarantine.<pid>.<rand>)`：rename 是原子的，同一时刻
 *      只有一个进程能把当前锁文件「夺走」；
 *   2. 复核夺到的 quarantine 内容——它可能已经不是刚才读到的陈旧锁（原持有者
 *      恰好释放、其它进程刚创建），活的就原地 link 回去并拒绝；
 *   3. 确认陈旧后才 `open(..., 'wx')` 建新锁；拿到 EEXIST 说明别的进程抢先，
 *      重新读取并按「活锁 → 拒绝 / 陈旧 → 下一轮」处理（有限重试 + 退避）。
 * 任何一步失败都不会直接 unlink 当前锁，避免把别人刚建好的锁删掉。
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { bestEffortUnlink } from './common/fs.js';
import { isWin32 } from './platform/select.js';
import { binaryName, verifyPidIdentityVerdict, type IdentityVerdict } from './platform/identity.js';

export class InstanceAlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    readonly lockPath: string,
  ) {
    super(`lark-remote is already running for this config: pid ${pid}`);
  }
}

/** 陈旧锁接管的最大轮次（每轮都是「读 → 原子改名 → 复核 → 尝试创建」）。 */
const MAX_ACQUIRE_ATTEMPTS = 10;

/** 每轮退避 5–25ms（含抖动），让并发启动的进程错开而不是持续碰撞。 */
function acquireBackoffMs(): number {
  return 5 + Math.floor(Math.random() * 20);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe whether a pid is alive.
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

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      // 1) 原子创建：'wx' 在文件已存在时失败，正常路径一步到位。
      if (this.tryCreate()) return;

      // 2) 锁已存在：活的就拒绝，无法证伪也拒绝（fail-open）。
      const owner = this.readPidAndName(this.lockPath);
      if (owner.pid && (await this.isHeldByLiveInstance(owner.pid, owner.name))) {
        throw new InstanceAlreadyRunningError(owner.pid, this.lockPath);
      }

      // 3) 判为陈旧：原子地把当前锁文件改名到 quarantine（不直接 unlink）。
      const quarantine = `${this.lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
      try {
        fs.renameSync(this.lockPath, quarantine);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // 别的进程先一步夺走/释放了锁：重新进入创建竞争。
          await sleep(acquireBackoffMs());
          continue;
        }
        throw err;
      }

      // 4) 复核夺到的锁：读→rename 之间可能已被新实例替换成活锁。
      // 内容与刚才读到的陈旧锁一致 = 同一个文件，直接沿用第 2 步的裁决（陈旧），
      // 不重复查身份（win32 上每次身份查询要拉 PowerShell）。
      const stolen = this.readPidAndName(quarantine);
      const unchanged = stolen.pid === owner.pid && stolen.name === owner.name;
      if (!unchanged && stolen.pid && (await this.isHeldByLiveInstance(stolen.pid, stolen.name))) {
        this.restoreQuarantine(quarantine);
        throw new InstanceAlreadyRunningError(stolen.pid, this.lockPath);
      }

      // 5) 确属陈旧：创建新锁。失败 = 别的进程在 rename 与 create 之间抢先。
      const created = this.tryCreate();
      bestEffortUnlink(quarantine);
      if (created) return;

      const winner = this.readPidAndName(this.lockPath);
      if (winner.pid && (await this.isHeldByLiveInstance(winner.pid, winner.name))) {
        throw new InstanceAlreadyRunningError(winner.pid, this.lockPath);
      }
      await sleep(acquireBackoffMs());
    }

    // 有限重试耗尽：仍然拿不到，按「有（可能是陈旧的）锁存在」报错，
    // 不递归、不无界重试（并发启动风暴下宁可失败也不双开）。
    throw new InstanceAlreadyRunningError(
      this.readPidAndName(this.lockPath).pid ?? -1,
      this.lockPath,
    );
  }

  release(): void {
    const { pid } = this.readPidAndName(this.lockPath);
    if (pid === process.pid) {
      bestEffortUnlink(this.lockPath);
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
    if (!isWin32()) {
      process.on('SIGHUP', () => {
        this.release();
        process.exit(129);
      });
    } else {
      // win32 无 SIGHUP；CTRL_BREAK 退出前也要释放锁（对照 cli.ts 信号转发）
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

  /** 原子创建锁文件；已存在返回 false，其它 IO 错误向上抛。 */
  private tryCreate(): boolean {
    try {
      const fd = fs.openSync(this.lockPath, 'wx');
      try {
        fs.writeSync(fd, this.lockContents(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }

  /**
   * 把夺来的活锁放回原位。优先 `link`（目标已存在会失败，不会覆盖更新的锁），
   * 再删 quarantine。目标已被更新锁占据时放弃恢复——此时当前锁文件属于一个
   * 活实例，拒绝取锁仍然是对的。
   */
  private restoreQuarantine(quarantine: string): void {
    try {
      fs.linkSync(quarantine, this.lockPath);
    } catch {
      // EEXIST：已有更新的锁（不要覆盖）；文件系统不支持 hardlink 时目标通常
      // 仍不存在，退化为 rename 恢复（目标已存在则不碰）。
      if (!fs.existsSync(this.lockPath)) {
        try {
          fs.renameSync(quarantine, this.lockPath);
        } catch {
          /* 放弃恢复：当前锁文件仍可能属于一个活实例，拒绝取锁是对的。 */
        }
      }
    }
    bestEffortUnlink(quarantine);
  }

  /** 读取锁文件内容（无副作用：不再在读取失败时 unlink 当前锁）。 */
  private readPidAndName(file: string): {
    pid: number | undefined;
    name: string | undefined;
  } {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8').trim();
    } catch {
      return { pid: undefined, name: undefined };
    }
    const [pidStr, ...nameParts] = raw.split('\n');
    const pid = Number(pidStr);
    const name = nameParts.join('\n') || undefined;
    if (Number.isInteger(pid) && pid > 0 && name) return { pid, name };
    // Malformed or missing name — treat as corrupt/stale (caller quarantines it).
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
