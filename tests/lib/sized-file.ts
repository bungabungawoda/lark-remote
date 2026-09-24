/**
 * 造一个「只有大小是真的」的文件：稀疏文件，实际磁盘占用为 0。
 *
 * 用于只断言 `fs.statSync(...).size` 的用例（30MB 上传门禁那一类）。原来写
 * `fs.writeFileSync(p, Buffer.alloc(31 * 1024 * 1024))` 会真的落 31 MiB 零字节，
 * 一轮全量回归光这些文件就写 246 MiB；`ftruncate` 得到的 `stat.size` 完全一致。
 *
 * 注意：读出来的内容是全零，不是任何有意义的正文。凡是用例会读文件内容的，
 * 必须用真实数据写入，不要用本函数。
 */
import fs from 'node:fs';

export function writeSizedFile(filePath: string, sizeBytes: number): void {
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.ftruncateSync(fd, sizeBytes);
  } finally {
    fs.closeSync(fd);
  }
}
