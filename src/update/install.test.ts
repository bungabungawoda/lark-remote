import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { detectPackageManager, inferPackageManagerFromPath, runInstallLatest } from './install.js';

type MockExecCallback = (err: Error | null, stdout: unknown, stderr: unknown) => void;

describe('inferPackageManagerFromPath', () => {
  it('detects bun global install layout', () => {
    expect(
      inferPackageManagerFromPath(
        '/home/user/.bun/install/global/node_modules/lark-remote/dist/index.js',
      ),
    ).toBe('bun');
  });

  it('detects pnpm global install layout (realpath inside .pnpm store)', () => {
    expect(
      inferPackageManagerFromPath(
        '/home/user/Library/pnpm/global/5/node_modules/.pnpm/lark-remote@0.1.4/node_modules/lark-remote/dist/index.js',
      ),
    ).toBe('pnpm');
  });

  it('detects npm global install layout (POSIX)', () => {
    expect(
      inferPackageManagerFromPath('/usr/local/lib/node_modules/lark-remote/dist/index.js'),
    ).toBe('npm');
  });

  it('detects npm global install layout (Windows backslash path)', () => {
    expect(
      inferPackageManagerFromPath(
        'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\lark-remote\\dist\\index.js',
      ),
    ).toBe('npm');
  });

  it('bun/pnpm markers win over the generic node_modules marker', () => {
    // bun layout also contains /node_modules/lark-remote/ — must not become npm
    expect(
      inferPackageManagerFromPath(
        '/home/user/.bun/install/global/node_modules/lark-remote/dist/cli.js',
      ),
    ).toBe('bun');
    expect(
      inferPackageManagerFromPath(
        '/home/user/Library/pnpm/global/5/node_modules/.pnpm/lark-remote@0.1.4/node_modules/lark-remote/dist/cli.js',
      ),
    ).toBe('pnpm');
  });

  it('returns null for source checkout (dev mode)', () => {
    expect(inferPackageManagerFromPath('/home/user/code/lark-remote/dist/index.js')).toBe(null);
  });
});

describe('detectPackageManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns env override when LARK_REMOTE_MANAGED_BY is set', () => {
    process.env.LARK_REMOTE_MANAGED_BY = 'pnpm';
    expect(detectPackageManager()).toBe('pnpm');

    process.env.LARK_REMOTE_MANAGED_BY = 'npm';
    expect(detectPackageManager()).toBe('npm');

    process.env.LARK_REMOTE_MANAGED_BY = 'bun';
    expect(detectPackageManager()).toBe('bun');
  });

  it('returns null for invalid LARK_REMOTE_MANAGED_BY value', () => {
    process.env.LARK_REMOTE_MANAGED_BY = 'yarn';
    // Invalid value falls through to which detection
    const result = detectPackageManager();
    // Could be null or a valid PM depending on environment
    expect(result === null || ['npm', 'bun', 'pnpm'].includes(result!)).toBe(true);
  });

  it('falls through to which detection when no env override', () => {
    delete process.env.LARK_REMOTE_MANAGED_BY;
    const result = detectPackageManager();
    // In CI/test environments npm is usually available
    expect(result === null || ['npm', 'bun', 'pnpm'].includes(result!)).toBe(true);
  });
  it('infers PM from running script path before which detection', () => {
    delete process.env.LARK_REMOTE_MANAGED_BY;
    // pnpm install layout: must pick pnpm even though npm exists on this machine
    expect(
      detectPackageManager(
        '/home/user/Library/pnpm/global/5/node_modules/.pnpm/lark-remote@0.1.4/node_modules/lark-remote/dist/index.js',
      ),
    ).toBe('pnpm');
    expect(
      detectPackageManager('/home/user/.bun/install/global/node_modules/lark-remote/dist/index.js'),
    ).toBe('bun');
    expect(detectPackageManager('/usr/local/lib/node_modules/lark-remote/dist/index.js')).toBe(
      'npm',
    );
  });

  it('env override wins over script path inference', () => {
    process.env.LARK_REMOTE_MANAGED_BY = 'bun';
    expect(detectPackageManager('/usr/local/lib/node_modules/lark-remote/dist/index.js')).toBe(
      'bun',
    );
  });

  it('falls through to which detection when script path has no marker', () => {
    delete process.env.LARK_REMOTE_MANAGED_BY;
    const result = detectPackageManager('/home/user/code/lark-remote/dist/index.js');
    // In CI/test environments npm is usually available
    expect(result === null || ['npm', 'bun', 'pnpm'].includes(result!)).toBe(true);
  });
});

describe('runInstallLatest', () => {
  it('returns success=false when no package manager detected', async () => {
    const result = await runInstallLatest({ packageManager: null });
    expect(result.success).toBe(false);
    expect(result.error).toContain('包管理器');
  });

  it('returns success on successful install', async () => {
    const mockExec = (_cmd: string, _args: string[], _opts: object, cb: MockExecCallback) => {
      cb(null, { stdout: 'added 1 package', stderr: '' });
    };
    const result = await runInstallLatest({
      packageManager: 'npm',
      execFn: mockExec,
    });
    expect(result.success).toBe(true);
  });

  it('returns success=false with EACCES hint on permission error', async () => {
    const mockExec = (_cmd: string, _args: string[], _opts: object, cb: MockExecCallback) => {
      const err = new Error('EACCES: permission denied');
      cb(err, { stdout: '', stderr: 'npm ERR!' });
    };
    const result = await runInstallLatest({
      packageManager: 'npm',
      execFn: mockExec,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('sudo');
  });

  it('does not suggest sudo for bun/pnpm EACCES (they install into the user dir)', async () => {
    const mockExec = (_cmd: string, _args: string[], _opts: object, cb: MockExecCallback) => {
      cb(new Error('EACCES: permission denied'), { stdout: '', stderr: '' });
    };
    for (const pm of ['bun', 'pnpm'] as const) {
      const result = await runInstallLatest({ packageManager: pm, execFn: mockExec });
      expect(result.success).toBe(false);
      expect(result.error).not.toContain('sudo');
      expect(result.error).toContain('权限不足');
    }
  });

  it('returns success=false with error message on generic failure', async () => {
    const mockExec = (_cmd: string, _args: string[], _opts: object, cb: MockExecCallback) => {
      const err = new Error('network timeout');
      cb(err, { stdout: '', stderr: '' });
    };
    const result = await runInstallLatest({
      packageManager: 'npm',
      execFn: mockExec,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('network timeout');
  });

  it('uses correct command for each package manager', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const recordingExec = (cmd: string, args: string[], _opts: object, cb: MockExecCallback) => {
      calls.push({ cmd, args });
      cb(null, { stdout: '', stderr: '' });
    };

    await runInstallLatest({ packageManager: 'npm', execFn: recordingExec });
    expect(calls[0].cmd).toBe('npm');
    expect(calls[0].args).toEqual(['install', '-g', 'lark-remote@latest']);

    await runInstallLatest({ packageManager: 'bun', execFn: recordingExec });
    expect(calls[1].cmd).toBe('bun');
    expect(calls[1].args).toEqual(['install', '-g', 'lark-remote@latest']);

    await runInstallLatest({ packageManager: 'pnpm', execFn: recordingExec });
    expect(calls[2].cmd).toBe('pnpm');
    expect(calls[2].args).toEqual(['add', '-g', 'lark-remote@latest']);
  });
});
