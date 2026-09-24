import { describe, it, expect } from 'vitest';
import { samePath, displayName, encodeProjectDirName } from './path.js';

describe('samePath', () => {
  it('win32: case-insensitive and separator-insensitive', () => {
    expect(samePath('C:\\Foo\\Bar', 'c:/foo/bar', { platform: 'win32' })).toBe(true);
    expect(samePath('C:\\foo\\', 'C:/foo', { platform: 'win32' })).toBe(true);
    expect(samePath('C:\\foo', 'C:\\foobar', { platform: 'win32' })).toBe(false);
  });

  it('darwin: case-insensitive by default (default FS)', () => {
    expect(samePath('/Users/alice/proj', '/users/alice/proj', { platform: 'darwin' })).toBe(true);
  });

  it('darwin: 尾部分隔符与 win32 同口径忽略（/cd 带不带尾斜杠必须判为同一目录）', () => {
    expect(samePath('/home/user/', '/home/user', { platform: 'darwin' })).toBe(true);
    expect(samePath('/home/user///', '/home/user', { platform: 'darwin' })).toBe(true);
  });

  it('linux: case-sensitive', () => {
    expect(samePath('/home/user', '/home/User', { platform: 'linux' })).toBe(false);
    expect(samePath('/home/user', '/home/user', { platform: 'linux' })).toBe(true);
  });
});

describe('displayName', () => {
  it('win32: basename recognizes both \\ and /', () => {
    expect(displayName('C:\\Users\\foo\\project', { platform: 'win32' })).toBe('project');
    expect(displayName('C:/Users/foo/project', { platform: 'win32' })).toBe('project');
  });

  it('posix: backslash is a legal filename character, not a separator', () => {
    expect(displayName('/home/user/project', { platform: 'linux' })).toBe('project');
    expect(displayName('C:\\weird', { platform: 'linux' })).toBe('C:\\weird');
  });
});

describe('encodeProjectDirName', () => {
  it('posix: `/` 与 `_` 归一为 `-`（与 Claude Code 一致）', () => {
    expect(encodeProjectDirName('/Users/x/proj', { platform: 'linux' })).toBe('-Users-x-proj');
    expect(encodeProjectDirName('/Users/x/proj_j', { platform: 'linux' })).toBe('-Users-x-proj-j');
  });

  it('posix: `:` 是合法文件名字符，不能动（否则既有目录定位不到）', () => {
    expect(encodeProjectDirName('/tmp/a:b', { platform: 'linux' })).toBe('-tmp-a:b');
  });

  it('win32: `\\` 与 `:` 一并归一，产出合法目录名', () => {
    expect(encodeProjectDirName('C:\\Users\\x\\proj', { platform: 'win32' })).toBe(
      'C--Users-x-proj',
    );
    expect(encodeProjectDirName('C:/Users/x/proj', { platform: 'win32' })).toBe('C--Users-x-proj');
  });

  it('win32: 结果不含任何非法文件名字符（mkdir 不炸）', () => {
    const name = encodeProjectDirName('C:\\Users\\x\\proj', { platform: 'win32' });
    expect(name).not.toMatch(/[<>:"|?*\\/]/);
  });

  it('lossy N-to-N：只可用于定位，不可反解（既有语义不变）', () => {
    expect(encodeProjectDirName('disk_d/foo', { platform: 'linux' })).toBe(
      encodeProjectDirName('disk-d/foo', { platform: 'linux' }),
    );
  });
});
