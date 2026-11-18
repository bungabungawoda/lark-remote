import fs from 'node:fs';
import path from 'node:path';
import { bestEffortUnlink, withBusyRetry } from '../common/fs.js';
import { getLogger } from '../logger/index.js';

function uniqueSiblingPath(targetPath: string, kind: 'tmp' | 'copy'): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${kind}-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`,
  );
}

function syncFile(pathToSync: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(pathToSync, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* fsync is best-effort; some filesystems do not support it. */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closing after a successful fsync is cleanup-only */
      }
    }
  }
}

function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* Directory fsync is best-effort and unsupported on some platforms. */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close failure */
      }
    }
  }
}

/**
 * Move across filesystems without ever writing directly to the target:
 * copy to a sibling, sync its data, then atomically rename it into place.
 */
function moveAcrossDevices(srcPath: string, destPath: string): void {
  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });
  const siblingPath = uniqueSiblingPath(destPath, 'copy');
  try {
    fs.copyFileSync(srcPath, siblingPath);
    syncFile(siblingPath);
    withBusyRetry(() => fs.renameSync(siblingPath, destPath));
    syncDirectory(destDir);
  } finally {
    bestEffortUnlink(siblingPath);
  }
}

/**
 * Atomically write content (string or binary Buffer) to a file via tmp + rename.
 * Falls back to copy+unlink when rename fails with EXDEV (cross-device).
 * rename 目标被占用（win32 EPERM/EBUSY）时短暂退避重试；重试耗尽后
 * 保留 tmp 现场并告警，再抛出原错误。
 */
export function atomicWrite(
  filePath: string,
  content: string | Buffer,
  encoding: BufferEncoding = 'utf-8',
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // tmp 命名：pid-ts-rand 后缀，避免固定
  // `.tmp` 名在异常残留后被下一次写入复用/误判；必须与目标同目录（rename 原子性）
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`,
  );
  // Buffer 内容忽略 encoding（writeFileSync 对 Buffer 自动以二进制写出）。
  fs.writeFileSync(tmpPath, content, encoding);
  // fsync the tmp file before rename so its data is durable on disk;
  // rename itself is only a metadata change, so without fsync a crash after
  // rename could leave the target as a 0-byte file. Best-effort: some
  // filesystems (tmpfs) may not support fsync — ignore those errors.
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* fsync unavailable on this fs — best-effort durability */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close failure */
      }
    }
  }
  let preserveTmpScene = false;
  try {
    withBusyRetry(() => fs.renameSync(tmpPath, filePath), {
      onGiveUp: (err) => {
        // 保留现场：tmp 里是已写好的完整内容，重试耗尽（win32）或 posix 首次
        // 占用即失败都说明目标不可达；留着 tmp 供人工恢复，只告警不静默
        preserveTmpScene = true;
        getLogger().warn(
          `[atomic-write] rename to ${filePath} still busy after retries; ` +
            `tmp preserved at ${tmpPath}: ${String(err)}`,
        );
      },
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      moveAcrossDevices(tmpPath, filePath);
    } else {
      throw err;
    }
  } finally {
    // Best-effort cleanup: on success the tmp was renamed away (ENOENT here,
    // silently ignored); on EXDEV it was copied and now needs removal; on other
    // errors we must not leak the tmp file — except when the scene is
    // deliberately preserved after busy-retry exhaustion.
    if (!preserveTmpScene) {
      bestEffortUnlink(tmpPath);
    }
  }
}

/**
 * Atomically write JSON data to a file via tmp + rename.
 * Ensures a crash mid-write cannot leave a truncated file.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

/**
 * 把已写好的文件原子移动到目标位置（rename 同设备即原子；EXDEV 跨设备
 * 回退 copy + unlink）。失败时抛出，由调用方负责清理源文件（best-effort）。
 * 用于入站媒体：下载已流式写入临时文件，落盘只需一次 move，不再复制进内存。
 */
export function atomicMoveFile(srcPath: string, destPath: string): void {
  try {
    withBusyRetry(() => fs.renameSync(srcPath, destPath));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      moveAcrossDevices(srcPath, destPath);
      bestEffortUnlink(srcPath);
    } else {
      throw err;
    }
  }
}
