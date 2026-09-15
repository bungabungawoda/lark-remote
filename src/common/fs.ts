import fs from 'node:fs';
import { getLogger } from '../logger/index.js';
import { currentPlatform, isWin32 } from '../platform/select.js';

/**
 * Unlink a file, silently ignoring ENOENT and other errors.
 *
 * Use for cleanup paths (pid files, temp files, stale locks) where the
 * file may already be gone or was never created — a missing file is not
 * an error worth propagating.
 */
export function silentlyUnlink(path: string): void {
  try {
    withBusyRetry(() => fs.unlinkSync(path));
  } catch (err) {
    // 占用放弃（win32 重试耗尽 / posix 首次占用即失败）：按设计「告警，
    // 不静默吞」，但清理路径不向调用方抛错（保持本函数契约）
    getLogger().warn(`[fs] silentlyUnlink gave up on busy file ${path}: ${String(err)}`);
  }
}

/**
 * win32 句柄占用重试：rename/unlink 目标被
 * 其他句柄持有时报 EPERM/EBUSY（共享冲突），短暂退避后重试通常即可成功。
 * 仅 win32 启用重试：posix 上这两个错误码不是「占用瞬态」语义（如 NFS 权限
 * 问题），立即失败——避免忙等阻塞单线程 lark-remote 的事件循环。
 */
const BUSY_CODES = new Set(['EPERM', 'EBUSY']);

/**
 * 退避参数（取参照项目上线验证值）：
 * 最多 5 次，第 n 次失败后睡 BASE_RETRY_DELAY_MS × n——总阻塞上界 ~250ms。
 * Windows 上杀毒/索引器持锁更久，窗口比短退避更稳。
 */
const BASE_RETRY_DELAY_MS = 25;
const MAX_RETRY_ATTEMPTS = 5;

export function isBusyError(err: unknown): boolean {
  return BUSY_CODES.has((err as NodeJS.ErrnoException | null)?.code ?? '');
}

function busySleep(ms: number): void {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  // 同步退避只能忙等（调用方均为 sync API）；总上界 ~250ms
  while (Date.now() < end) {
    /* spin */
  }
}

export interface BusyRetryOptions {
  /** 平台注入（测试用）；默认当前宿主。占用重试仅 win32 生效 */
  platform?: NodeJS.Platform;
  /** 重试耗尽（或 posix 首次占用即失败）时回调，用于告警/保留现场 */
  onGiveUp?: (err: unknown) => void;
}

/**
 * 对 sync 文件操作套占用退避重试：win32 上遇 EPERM/EBUSY 按退避序列重试，
 * 其他错误或重试耗尽后抛最后一个错误；posix 上占用错误不重试、立即失败。
 * `onGiveUp` 仅在「占用导致的放弃」时回调（告警/保留现场）；非占用错误
 * （如 EXDEV）不走回调、直接透传，避免误触发调用方的占用善后逻辑。
 */
export function withBusyRetry<T>(op: () => T, opts?: BusyRetryOptions): T {
  const win32 = isWin32(opts?.platform ?? currentPlatform);
  for (let attempt = 1; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      if (!win32 || attempt >= MAX_RETRY_ATTEMPTS) {
        // 真正放弃才回调：中间重试失败不能触发「保留现场」类善后
        opts?.onGiveUp?.(err);
        throw err;
      }
      busySleep(BASE_RETRY_DELAY_MS * attempt);
    }
  }
}
