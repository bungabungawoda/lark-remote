import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, samePath, displayName, encodeProjectDirName } from './path.js';

describe('canonicalPath', () => {
  it('expands leading ~ to homedir and realpaths existing dirs', () => {
    const home = os.homedir();
    // 真实存在的家目录一定可以 realpath；不假设其大小写形态，只断言指向同一文件
    expect(fs.realpathSync(canonicalPath('~'))).toBe(fs.realpathSync(home));
    expect(fs.realpathSync(canonicalPath('~/'))).toBe(fs.realpathSync(home));
  });

  it('expands ~/sub to homedir + sub (injected home)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-path-'));
    const sub = path.join(tmpRoot, 'sub dir');
    fs.mkdirSync(sub);
    try {
      // home 注入到临时目录，才能真正断言 `~/sub` 的展开结果。
      // 两侧都经 realpath，因此分隔符口径一致（win32 原生 `\`），可直接相等比较。
      expect(canonicalPath('~/sub dir', { home: tmpRoot })).toBe(fs.realpathSync(sub));
      // realpath:false 时返回 normalizeSeparators 的结果（win32 归一为 `/`），
      // 所以按同一口径比较；posix 宿主下 replaceAll 是 no-op。
      expect(
        canonicalPath('~\\sub dir', { platform: 'win32', home: tmpRoot, realpath: false }),
      ).toBe(path.join(tmpRoot, 'sub dir').replaceAll('\\', '/'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('realpaths symlinked dirs to the physical target (darwin /tmp → /private/tmp)', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-path-real-'));
    try {
      expect(canonicalPath(real)).toBe(fs.realpathSync(real));
      // os.tmpdir() 在 macOS 返回 /var/... 或 /tmp，canonicalPath 必须落回物理路径
      expect(canonicalPath(os.tmpdir())).not.toContain('/tmp/platform-path-real-');
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('does not throw for non-existent paths — returns expanded+normalized path', () => {
    const missing = path.join(os.tmpdir(), 'platform-path-missing-xyz', 'a b');
    // win32 下 canonicalPath 归一化分隔符为 `/`（PathKit §5.1），按同口径比较
    expect(canonicalPath(missing)).toBe(missing.replaceAll('\\', '/'));
  });

  it('win32: converts backslashes to forward slashes and expands %VAR%', () => {
    const out = canonicalPath('C:\\Users\\alice\\pro ject', {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\alice', USER: 'alice' },
      home: 'C:\\Users\\alice',
      realpath: false,
    });
    expect(out).toBe('C:/Users/alice/pro ject');
  });

  it('win32: expands %USERPROFILE% and leading ~ with injected home', () => {
    expect(
      canonicalPath('%USERPROFILE%\\repo', {
        platform: 'win32',
        env: { USERPROFILE: 'C:\\Users\\alice' },
        home: 'C:\\Users\\alice',
        realpath: false,
      }),
    ).toBe('C:/Users/alice/repo');
    expect(
      canonicalPath('~\\repo', {
        platform: 'win32',
        env: {},
        home: 'C:\\Users\\alice',
        realpath: false,
      }),
    ).toBe('C:/Users/alice/repo');
  });

  it('posix: expands $HOME/${HOME} and leaves unknown vars literal', () => {
    const env = { HOME: '/home/user' };
    expect(
      canonicalPath('$HOME/repo', { platform: 'linux', env, home: '/home/user', realpath: false }),
    ).toBe('/home/user/repo');
    expect(
      canonicalPath('${HOME}/repo', {
        platform: 'linux',
        env,
        home: '/home/user',
        realpath: false,
      }),
    ).toBe('/home/user/repo');
    expect(
      canonicalPath('$UNSET_VAR/repo', {
        platform: 'linux',
        env: {},
        home: '/home/user',
        realpath: false,
      }),
    ).toBe('$UNSET_VAR/repo');
  });
});

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
