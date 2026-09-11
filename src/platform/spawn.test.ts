import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpawnSyncReturns } from 'child_process';

const { mockCrossSpawn, mockCrossSpawnSync } = vi.hoisted(() => ({
  mockCrossSpawn: vi.fn(),
  mockCrossSpawnSync: vi.fn(),
}));

vi.mock('cross-spawn', () => {
  const mod = Object.assign(
    vi.fn((...args: unknown[]) => mockCrossSpawn(...args)),
    {
      sync: (...args: unknown[]) => mockCrossSpawnSync(...args),
    },
  );
  return { default: mod };
});

import {
  spawnProcess,
  spawnProcessSync,
  mergeProcessEnv,
  isWindowsCommandNotFoundLine,
} from './spawn.js';

describe('spawnProcess / spawnProcessSync（cross-spawn 收口）', () => {
  beforeEach(() => {
    mockCrossSpawn.mockReset();
    mockCrossSpawnSync.mockReset();
  });

  it('args 原样透传给 cross-spawn（含选项），并默认注入 windowsHide', () => {
    const proc = { pid: 123 };
    mockCrossSpawn.mockReturnValue(proc);
    expect(spawnProcess('claude', ['-p', 'hi'], { cwd: '/tmp' })).toBe(proc);
    expect(mockCrossSpawn).toHaveBeenCalledWith('claude', ['-p', 'hi'], {
      windowsHide: true,
      cwd: '/tmp',
    });
  });

  it('args 缺省为空数组（仍注入 windowsHide 默认值）', () => {
    spawnProcess('bash');
    expect(mockCrossSpawn).toHaveBeenCalledWith('bash', [], { windowsHide: true });
  });

  it('sync 版透传并返回结果（含 windowsHide 默认值）', () => {
    const res = { status: 0, stdout: 'ok' } as unknown as SpawnSyncReturns<string | Buffer>;
    mockCrossSpawnSync.mockReturnValue(res);
    expect(spawnProcessSync('curl', ['-s', 'x'], { timeout: 1000 })).toBe(res);
    expect(mockCrossSpawnSync).toHaveBeenCalledWith('curl', ['-s', 'x'], {
      windowsHide: true,
      timeout: 1000,
    });
  });

  it('调用方显式传 windowsHide: false 可覆盖默认值', () => {
    spawnProcess('foo', [], { windowsHide: false });
    expect(mockCrossSpawn).toHaveBeenCalledWith('foo', [], { windowsHide: false });
  });
});

describe('mergeProcessEnv（win32 env 键大小写不敏感，§8.3）', () => {
  it('覆盖已有同键：旧键被删、新键就位', () => {
    const merged = mergeProcessEnv({ PATH: '/usr/bin', HOME: '/home/u' }, { PATH: '/opt/bin' });
    expect(merged).toEqual({ HOME: '/home/u', PATH: '/opt/bin' });
  });

  it('win32 双键防护：base 键为 Path 时注入 PATH 不产生双键', () => {
    const merged = mergeProcessEnv({ Path: 'C:\\Windows', TEMP: 'C:\\tmp' }, { PATH: 'C:\\bin' });
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === 'path')).toEqual(['PATH']);
    expect(merged.Path).toBeUndefined();
    expect(merged.PATH).toBe('C:\\bin');
    expect(merged.TEMP).toBe('C:\\tmp');
  });

  it('反向注入：base 键为 PATH 时覆盖为 Path 同样无双键', () => {
    const merged = mergeProcessEnv({ PATH: '/usr/bin' }, { Path: 'C:\\bin' });
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === 'path')).toEqual(['Path']);
  });

  it('undefined 值只删旧键不设新键', () => {
    const merged = mergeProcessEnv({ PATH: '/usr/bin', HOME: '/h' }, { PATH: undefined });
    expect(merged.PATH).toBeUndefined();
    expect('PATH' in merged).toBe(false);
    expect(merged.HOME).toBe('/h');
  });

  it('overrides 为空时等价浅拷贝，不改 base', () => {
    const base = { A: '1' };
    const merged = mergeProcessEnv(base);
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
  });
});

describe('isWindowsCommandNotFoundLine（§4.4 stderr 嗅探）', () => {
  it('win32：命中 cmd 层 not recognized 两种形态', () => {
    expect(
      isWindowsCommandNotFoundLine(
        "'claude' is not recognized as an internal or external command",
        'win32',
      ),
    ).toBe(true);
    expect(
      isWindowsCommandNotFoundLine('xxx is not an operable program or batch file.', 'win32'),
    ).toBe(true);
  });

  it('win32：普通 stderr 不误报', () => {
    expect(isWindowsCommandNotFoundLine('warning: deprecated flag', 'win32')).toBe(false);
    expect(isWindowsCommandNotFoundLine('', 'win32')).toBe(false);
  });

  it('非 win32 平台恒 false（同一 stderr 行在 posix 不触发）', () => {
    const line = "'claude' is not recognized as an internal or external command";
    expect(isWindowsCommandNotFoundLine(line, 'darwin')).toBe(false);
    expect(isWindowsCommandNotFoundLine(line, 'linux')).toBe(false);
  });
});
