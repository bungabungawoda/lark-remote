import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseCliArgs, printVersion } from './dir.js';

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
