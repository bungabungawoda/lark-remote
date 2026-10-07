import { describe, it, expect, vi, afterEach } from 'vitest';
import { atomicWrite, atomicWriteJson } from './atomic-write.js';
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

      atomicWrite(filePath, '{"a":1}');

      // 目标文件正常写入
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"a":1}');

      // 必须至少调用一次 fsyncSync（对 tmp fd 刷盘）
      expect(fsyncSpy).toHaveBeenCalled();
      expect(fsyncSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

      fsyncSpy.mockRestore();
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

  it('falls back to copyFileSync when renameSync throws EXDEV', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-exdev-'));
    const filePath = path.join(dir, 'target.txt');
    const content = 'hello exdev';

    renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('cross-device link') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    });
    copyFileSpy = vi.spyOn(fs, 'copyFileSync');

    try {
      atomicWrite(filePath, content);

      // copyFileSync was called as the EXDEV fallback
      expect(copyFileSpy).toHaveBeenCalled();

      // Target file contains the correct content
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);

      // Tmp file is cleaned up
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
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
