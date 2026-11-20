import { describe, it, expect, vi, afterEach } from 'vitest';
import { atomicMoveFile, atomicWrite, atomicWriteJson } from './atomic-write.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 目录里残留的 tmp 文件（命名：.{name}.tmp-{pid}-{ts}-{rand}）。 */
function tmpLeftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
}

describe('atomicWriteJson', () => {
  it('writes JSON data atomically via tmp+rename', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
    const filePath = path.join(dir, 'data.json');
    try {
      const data = { name: 'test', value: 42 };
      await atomicWriteJson(filePath, data);

      // File exists and contains correct JSON
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual(data);

      // No .tmp file left behind
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the tmp file (.{name}.tmp-{pid}-{ts}-{rand}) and cleans it up', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-tmpname-'));
    const filePath = path.join(dir, 'data.json');
    try {
      // 用 renameSync 间谍捕获 tmp 路径（先取 mock.calls 再 restore：
      // mockRestore 会清空调用记录）
      const renameSpy = vi.spyOn(fs, 'renameSync');
      atomicWrite(filePath, 'x');
      const calls = renameSpy.mock.calls.map((c) => String(c[0]));
      renameSpy.mockRestore();

      expect(calls.length).toBe(1);
      expect(calls[0]).toMatch(/\.data\.json\.tmp-\d+-\d+-[a-z0-9]+$/);
      expect(path.dirname(calls[0])).toBe(dir);
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Anchor: atomicWrite 必须 fsync 临时文件后再 rename，保证掉电耐久性。
 *
 * 验证行为：atomicWrite 在 renameSync 之前对 tmp 文件描述符调用 fs.fsyncSync，
 * 确保数据刷盘，掉电/崩溃后目标文件不会是空的或截断的。
 *
 * 缺失后果：当前实现 writeFileSync 后直接 renameSync，无 fsync。
 * 在掉电场景下 tmp 内容可能仅停留在 OS page cache，rename 仅是元数据操作，
 * 掉电后目标文件可能为空文件（0 字节），违反"原子写不丢数据"契约。
 *
 * 依据：POSIX 原子写标准模式 = write tmp → fsync(tmp) → close → rename → fsync(dir)。
 * 缺少 fsync 的 "atomic write" 在掉电下不原子。项目约束明确要求
 * "原子写入 tmp+rename"，fsync 是该契约的完整性组成。
 */
describe('atomicWrite durability', () => {
  it('test_anchor_atomic_write_fsyncs_before_rename', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-fsync-'));
    const filePath = path.join(dir, 'target.json');
    try {
      const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
      const openSpy = vi.spyOn(fs, 'openSync');
      const renameSpy = vi.spyOn(fs, 'renameSync');

      atomicWrite(filePath, '{"a":1}');

      // 目标文件正常写入
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"a":1}');

      // fsync 必须作用在 tmp 文件的 fd 上，且发生在 rename 之前。
      const tmpOpenIndex = openSpy.mock.calls.findIndex(([p]) => String(p).includes('.tmp-'));
      expect(tmpOpenIndex).toBeGreaterThanOrEqual(0);
      const tmpFd = openSpy.mock.results[tmpOpenIndex]!.value;
      expect(fsyncSpy).toHaveBeenCalledWith(tmpFd);
      expect(fsyncSpy.mock.invocationCallOrder[0]).toBeLessThan(
        renameSpy.mock.invocationCallOrder[0]!,
      );

      fsyncSpy.mockRestore();
      openSpy.mockRestore();
      renameSpy.mockRestore();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('atomicWrite EXDEV fallback', () => {
  let renameSpy: ReturnType<typeof vi.spyOn>;
  let copyFileSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    renameSpy?.mockRestore();
    copyFileSpy?.mockRestore();
  });

  it('falls back to sibling copy, fsync, and rename when renameSync throws EXDEV', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-exdev-'));
    const filePath = path.join(dir, 'target.txt');
    const content = 'hello exdev';

    const originalRename = fs.renameSync;
    renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      if (String(args[0]).includes('.target.txt.tmp-')) {
        const err = new Error('cross-device link') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }
      return originalRename(...args);
    });
    copyFileSpy = vi.spyOn(fs, 'copyFileSync');
    const openSpy = vi.spyOn(fs, 'openSync');

    try {
      atomicWrite(filePath, content);

      expect(copyFileSpy).toHaveBeenCalledTimes(1);
      expect(path.dirname(String(copyFileSpy.mock.calls[0]?.[0]))).toBe(dir);
      expect(String(copyFileSpy.mock.calls[0]?.[1])).not.toBe(filePath);
      expect(path.basename(String(copyFileSpy.mock.calls[0]?.[1]))).toMatch(
        /^\.target\.txt\.copy-\d+-\d+-[a-z0-9]+$/,
      );

      expect(renameSpy).toHaveBeenCalledTimes(2);
      expect(String(renameSpy.mock.calls[1]?.[1])).toBe(filePath);
      expect(path.dirname(String(renameSpy.mock.calls[1]?.[0]))).toBe(dir);
      expect(
        openSpy.mock.calls.some(
          ([openedPath]) => String(openedPath) === String(copyFileSpy.mock.calls[0]?.[1]),
        ),
      ).toBe(true);

      // Target file contains the correct content
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);

      // Tmp file is cleaned up
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates non-EXDEV rename error and cleans up tmp file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-non-exdev-'));
    const filePath = path.join(dir, 'target.txt');
    const content = 'will fail';

    renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('permission denied');
    });

    try {
      expect(() => atomicWrite(filePath, content)).toThrow('permission denied');

      // Tmp file is cleaned up in finally
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('atomicMoveFile', () => {
  let renameSpy: ReturnType<typeof vi.spyOn>;
  let copyFileSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    renameSpy?.mockRestore();
    copyFileSpy?.mockRestore();
  });

  it('moves an already-written download into place via rename', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-move-'));
    const src = path.join(dir, 'download.tmp');
    const dest = path.join(dir, 'image.png');
    fs.writeFileSync(src, 'PNG bytes');
    try {
      atomicMoveFile(src, dest);
      expect(fs.readFileSync(dest, 'utf-8')).toBe('PNG bytes');
      expect(fs.existsSync(src)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to sibling copy, fsync, and rename when rename throws EXDEV', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-move-exdev-'));
    const src = path.join(dir, 'download.tmp');
    const dest = path.join(dir, 'image.png');
    fs.writeFileSync(src, 'PNG bytes');
    const originalRename = fs.renameSync;
    renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      if (String(args[0]).endsWith('download.tmp')) {
        const err = new Error('cross-device link') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }
      return originalRename(...args);
    });
    copyFileSpy = vi.spyOn(fs, 'copyFileSync');
    try {
      atomicMoveFile(src, dest);
      expect(fs.readFileSync(dest, 'utf-8')).toBe('PNG bytes');
      expect(fs.existsSync(src)).toBe(false);
      expect(renameSpy).toHaveBeenCalledTimes(2);
      expect(String(renameSpy.mock.calls[1]?.[1])).toBe(dest);
      expect(String(copyFileSpy.mock.calls[0]?.[1])).not.toBe(dest);
      expect(path.dirname(String(copyFileSpy.mock.calls[0]?.[1]))).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates non-EXDEV rename errors without creating the destination', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-move-err-'));
    const src = path.join(dir, 'download.tmp');
    const dest = path.join(dir, 'image.png');
    fs.writeFileSync(src, 'PNG bytes');
    renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('permission denied');
    });
    try {
      expect(() => atomicMoveFile(src, dest)).toThrow('permission denied');
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
