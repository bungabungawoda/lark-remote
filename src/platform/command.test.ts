import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable, clearResolveCache } from './command.js';
import { describePosix } from '../../tests/lib/platform.js';

const tmpDirs: string[] = [];
function mkdtemp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-cmd-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  clearResolveCache();
});

// posix 的 PATH 分隔符就是 `:`；Windows 临时目录路径自带盘符冒号
// （`C:\Users\...`），按 `:` 拆分必然把路径截成两段——posix PATH 语义
// 无法用 Windows 宿主路径模拟，只能门控（tests/lib/platform.ts 规则）。
describePosix('resolveExecutable (posix)', () => {
  it('finds executable in PATH dir → direct spec', () => {
    const dir = mkdtemp();
    const bin = path.posix.join(dir, 'agent');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(resolveExecutable('agent', { platform: 'linux', pathEnv: dir })).toEqual({
      kind: 'direct',
      file: bin,
    });
  });

  it('respects PATH order: first dir with executable wins', () => {
    const first = mkdtemp();
    const second = mkdtemp();
    fs.writeFileSync(path.join(first, 'agent'), 'x', { mode: 0o755 });
    fs.writeFileSync(path.join(second, 'agent'), 'x', { mode: 0o755 });
    expect(
      resolveExecutable('agent', { platform: 'linux', pathEnv: `${first}:${second}` }),
    ).toEqual({
      kind: 'direct',
      // posix 分支按 posix 规则 join（不读宿主 path），两侧口径一致
      file: path.posix.join(first, 'agent'),
    });
  });

  it('skips non-executable files (X_OK) and finds later candidate', () => {
    const first = mkdtemp();
    const second = mkdtemp();
    fs.writeFileSync(path.join(first, 'agent'), 'x', { mode: 0o644 });
    const bin = path.posix.join(second, 'agent');
    fs.writeFileSync(bin, 'x', { mode: 0o755 });
    expect(
      resolveExecutable('agent', { platform: 'linux', pathEnv: `${first}:${second}` }),
    ).toEqual({
      kind: 'direct',
      file: bin,
    });
  });

  it('returns null when not found', () => {
    const dir = mkdtemp();
    expect(resolveExecutable('nope', { platform: 'linux', pathEnv: dir })).toBeNull();
  });
});

describe('resolveExecutable (win32)', () => {
  it('resolves .exe → direct spec', () => {
    const dir = mkdtemp();
    const exe = path.join(dir, 'agent.exe');
    fs.writeFileSync(exe, 'MZ');
    expect(resolveExecutable('agent', { platform: 'win32', pathEnv: dir })).toEqual({
      kind: 'direct',
      file: exe,
    });
  });

  it('name with explicit extension resolves directly', () => {
    const dir = mkdtemp();
    const exe = path.join(dir, 'agent.exe');
    fs.writeFileSync(exe, 'MZ');
    expect(resolveExecutable('agent.exe', { platform: 'win32', pathEnv: dir })).toEqual({
      kind: 'direct',
      file: exe,
    });
  });

  it('.exe wins over .cmd in the same dir (PATHEXT priority)', () => {
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, 'agent.cmd'), '@echo off');
    const exe = path.join(dir, 'agent.exe');
    fs.writeFileSync(exe, 'MZ');
    expect(resolveExecutable('agent', { platform: 'win32', pathEnv: dir })).toEqual({
      kind: 'direct',
      file: exe,
    });
  });

  it('.cmd shim hit reports the shim path itself (no content parsing; execution via cross-spawn)', () => {
    const dir = mkdtemp();
    const shim = path.join(dir, 'agent.cmd');
    fs.writeFileSync(shim, 'npm 形态垫片内容不再被解析');
    expect(resolveExecutable('agent', { platform: 'win32', pathEnv: dir })).toEqual({
      kind: 'direct',
      file: shim,
    });
  });

  it('returns null when no PATHEXT candidate exists', () => {
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, 'agent'), 'no ext on win32');
    expect(resolveExecutable('agent', { platform: 'win32', pathEnv: dir })).toBeNull();
  });

  it('multi-dir PATH uses win32 `;` delimiter (injected platform, not host)', () => {
    const first = mkdtemp();
    const second = mkdtemp();
    const shim = path.join(second, 'agent.cmd');
    fs.writeFileSync(shim, '@echo off');
    expect(
      resolveExecutable('agent', { platform: 'win32', pathEnv: `${first};${second}` }),
    ).toEqual({ kind: 'direct', file: shim });
  });
});

describe('resolveExecutable cache', () => {
  it('caches resolution results per (platform, pathEnv, name); clearResolveCache resets', () => {
    const dir = mkdtemp();
    const bin = path.join(dir, 'cached.cmd');
    fs.writeFileSync(bin, '@echo off');
    const opts = { platform: 'win32' as const, pathEnv: dir };
    expect(resolveExecutable('cached', opts)).toEqual({ kind: 'direct', file: bin });
    // 删除真实文件后再次解析 → TTL 内缓存命中，仍返回旧结果
    fs.unlinkSync(bin);
    expect(resolveExecutable('cached', opts)).toEqual({ kind: 'direct', file: bin });
    clearResolveCache();
    expect(resolveExecutable('cached', opts)).toBeNull();
  });

  it('TTL 过期后重新解析：卸载可见', () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtemp();
      const bin = path.join(dir, 'cached.cmd');
      fs.writeFileSync(bin, '@echo off');
      const opts = { platform: 'win32' as const, pathEnv: dir };
      expect(resolveExecutable('cached', opts)).toEqual({ kind: 'direct', file: bin });
      fs.unlinkSync(bin);
      vi.advanceTimersByTime(60_000);
      expect(resolveExecutable('cached', opts)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('回归：运行期间新装 agent，TTL 过期后探测可见（无需重启）', () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtemp();
      const opts = { platform: 'win32' as const, pathEnv: dir };
      // 未安装 → null（null 结果同样缓存）
      expect(resolveExecutable('claude', opts)).toBeNull();
      // 用户按 /config 提示安装成功
      fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off');
      // TTL 内仍命中旧 null
      expect(resolveExecutable('claude', opts)).toBeNull();
      // TTL 过期 → 重新解析可见
      vi.advanceTimersByTime(60_000);
      expect(resolveExecutable('claude', opts)).toEqual({
        kind: 'direct',
        file: path.join(dir, 'claude.cmd'),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveExecutable 空名守卫', () => {
  it('空名 / 纯空白 → null（posix 目录有 X_OK，不守卫会误报 PATH 目录为可执行）', () => {
    expect(resolveExecutable('', { platform: 'linux', pathEnv: '/usr/bin:/bin' })).toBeNull();
    expect(resolveExecutable('   ', { platform: 'linux', pathEnv: '/usr/bin' })).toBeNull();
    expect(resolveExecutable('', { platform: 'win32', pathEnv: 'C:\\Windows' })).toBeNull();
  });
});
