import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomically write string content to a file via tmp + rename.
 * Falls back to copy+unlink when rename fails with EXDEV (cross-device).
 */
export function atomicWrite(
  filePath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8',
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
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
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      // Cross-device rename: copy then unlink (tmp cleanup handled by finally)
      fs.copyFileSync(tmpPath, filePath);
    } else {
      throw err;
    }
  } finally {
    // Best-effort cleanup: on success the tmp was renamed away (ENOENT here,
    // silently ignored); on EXDEV it was copied and now needs removal; on other
    // errors we must not leak the tmp file.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* already moved or never created */
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
