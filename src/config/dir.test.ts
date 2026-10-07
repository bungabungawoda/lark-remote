import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { parseCliArgs, printVersion, resolveConfigDir } from './dir.js';

describe('resolveConfigDir tilde expansion', () => {
  it('expands ~ and ~/ for posix-style input', () => {
    expect(resolveConfigDir('~')).toBe(os.homedir());
    expect(resolveConfigDir('~/lark-remote')).toBe(path.join(os.homedir(), 'lark-remote'));
  });

  it('expands ~\\ for Windows-style input（cmd/PowerShell 不展开 ~）', () => {
    // join 用宿主分隔符：在 posix 宿主上 `~\x` 也展开为 <home>/x（语义等价）
    expect(resolveConfigDir('~\\lark-remote')).toBe(path.join(os.homedir(), 'lark-remote'));
  });

  it('passes through non-tilde paths unchanged（交给 path.resolve）', () => {
    // 断言与 path.resolve 全等而非 endsWith 字面量：win32 上 resolve 产出
    // 反斜杠分隔符，endsWith('relative/dir') 恒 false（Windows CI 实测）。
    expect(resolveConfigDir('relative/dir')).toBe(path.resolve('relative/dir'));
  });
});

describe('parseCliArgs version flag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should set version for -v', () => {
    expect(parseCliArgs(['-v']).version).toBe(true);
  });

  it('should set version for --version', () => {
    expect(parseCliArgs(['--version']).version).toBe(true);
  });

  it('should not set version when absent', () => {
    expect(parseCliArgs([]).version).toBeUndefined();
  });

  it('should parse version together with other flags', () => {
    const result = parseCliArgs(['--config-dir', '/tmp/foo', '--version']);
    expect(result.version).toBe(true);
    expect(result.configDir).toBe('/tmp/foo');
  });
});

describe('parseCliArgs update flag', () => {
  it('should set update for --update', () => {
    expect(parseCliArgs(['--update']).update).toBe(true);
  });

  it('should not set update when absent', () => {
    expect(parseCliArgs([]).update).toBeUndefined();
  });

  it('should parse --update together with --config-dir', () => {
    const result = parseCliArgs(['--config-dir', '/tmp/foo', '--update']);
    expect(result.update).toBe(true);
    expect(result.configDir).toBe('/tmp/foo');
  });
});

/**
 * 裸子命令等价形式：`lark-remote update`。
 * 不识别时 `update` 会被当成普通参数忽略 → 走守护进程路径抢单例锁 →
 * 被已运行的实例挡下（"already running"），而 update 根本不是守护类命令。
 */
describe('parseCliArgs 裸子命令', () => {
  it('update 等价 --update', () => {
    expect(parseCliArgs(['update']).update).toBe(true);
  });

  it('update 与 --config-dir 共存', () => {
    expect(parseCliArgs(['update', '--config-dir', '/tmp/foo'])).toEqual({
      update: true,
      configDir: '/tmp/foo',
    });
  });

  it('version / help 裸子命令', () => {
    expect(parseCliArgs(['version']).version).toBe(true);
    expect(parseCliArgs(['help']).help).toBe(true);
  });

  it('--config-dir 的值不会被误判成子命令', () => {
    expect(parseCliArgs(['--config-dir', 'update'])).toEqual({ configDir: 'update' });
  });
});

describe('printVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should print lark-remote <version> to stdout', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    printVersion();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/^lark-remote \d+\.\d+\.\d+\n$/));
  });
});
