import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DshDaemon,
  DshDaemonError,
  dshDaemonArgs,
  isLoopbackHttpUrl,
  type DshDaemonOptions,
} from './daemon.js';
import { resolveDshHome } from '../../dsh/home.js';
import { mockLogger } from '../../../tests/lib/logger-mock.js';

vi.mock('../../logger/index.js', async () =>
  (await import('../../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

// 阻断真实 `dsh web` 进程：只观察 spawnDaemon 交给平台的参数与落盘副作用。
const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }));

vi.mock('../../platform/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/spawn.js')>();
  return { ...actual, spawnProcess: spawnProcessMock };
});

const homes: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-dsh-daemon-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

class FakeDaemon extends DshDaemon {
  ready = false;
  managed = true;
  timeoutMs = 200;
  spawns = 0;
  spawnFailure: Error | undefined;
  exitEarly = false;
  onSpawn?: () => void;

  constructor(home: string) {
    super({
      host: () => 'http://127.0.0.1:3099',
      dshHome: () => home,
    });
  }

  protected override async probe(): Promise<boolean> {
    return this.ready;
  }

  protected override spawnDaemon(): { failure(): Error | undefined; exited(): boolean } {
    this.spawns += 1;
    this.onSpawn?.();
    return { failure: () => this.spawnFailure, exited: () => this.exitEarly };
  }

  protected override async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected override startTimeoutMs(): number {
    return this.timeoutMs;
  }

  protected override manageProcess(): boolean {
    return this.managed;
  }
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('dshDaemonArgs', () => {
  it('always names a concrete host, an explicit port, and no browser', () => {
    expect(dshDaemonArgs('http://127.0.0.1:3080')).toEqual([
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '3080',
      '--no-open',
    ]);
    expect(dshDaemonArgs('http://localhost:3099')).toEqual([
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '3099',
      '--no-open',
    ]);
    expect(dshDaemonArgs('http://[::1]:3080')).toEqual([
      'web',
      '--host',
      '::1',
      '--port',
      '3080',
      '--no-open',
    ]);
  });
});

describe('DSH daemon URL helpers', () => {
  it('accepts only loopback HTTP addresses for managed processes', () => {
    expect(isLoopbackHttpUrl('http://127.0.0.1:3080')).toBe(true);
    expect(isLoopbackHttpUrl('http://localhost:3080')).toBe(true);
    expect(isLoopbackHttpUrl('http://[::1]:3080')).toBe(true);
    expect(isLoopbackHttpUrl('https://127.0.0.1:3080')).toBe(false);
    expect(isLoopbackHttpUrl('http://192.0.2.8:3080')).toBe(false);
    expect(isLoopbackHttpUrl('not a url')).toBe(false);
  });

  it('resolves the Harness home from config, env, then ~/.dsh', () => {
    expect(resolveDshHome('/tmp/configured', { DSH_HOME: '/tmp/environment' })).toBe(
      path.resolve('/tmp/configured'),
    );
    expect(resolveDshHome(undefined, { DSH_HOME: '/tmp/environment' })).toBe(
      path.resolve('/tmp/environment'),
    );
    expect(resolveDshHome(undefined, {})).toBe(path.join(os.homedir(), '.dsh'));
  });
});

describe('DshDaemon.ensure', () => {
  it('reuses a listening DSH without spawning', async () => {
    const daemon = new FakeDaemon(temporaryHome());
    daemon.ready = true;

    await expect(daemon.ensure()).resolves.toBe('http://127.0.0.1:3099');
    expect(daemon.spawns).toBe(0);
  });

  it('starts one detached DSH and releases the start lock', async () => {
    const home = temporaryHome();
    const daemon = new FakeDaemon(home);
    daemon.onSpawn = () => {
      setTimeout(() => {
        daemon.ready = true;
      }, 10);
    };

    await expect(daemon.ensure()).resolves.toBe('http://127.0.0.1:3099');
    expect(daemon.spawns).toBe(1);
    expect(fs.existsSync(path.join(home, 'lark-remote', 'start.lock'))).toBe(false);
  });

  it('shares one in-flight start between concurrent callers', async () => {
    const daemon = new FakeDaemon(temporaryHome());
    daemon.onSpawn = () => {
      setTimeout(() => {
        daemon.ready = true;
      }, 20);
    };

    await Promise.all([daemon.ensure(), daemon.ensure()]);
    expect(daemon.spawns).toBe(1);
  });

  it('does not start when manageProcess is false', async () => {
    const daemon = new FakeDaemon(temporaryHome());
    daemon.managed = false;

    const error = await caught(daemon.ensure());
    expect(error).toBeInstanceOf(DshDaemonError);
    expect((error as DshDaemonError).code).toBe('stopped');
    expect(daemon.spawns).toBe(0);
  });

  it('surfaces a spawn failure with its code', async () => {
    const daemon = new FakeDaemon(temporaryHome());
    daemon.spawnFailure = new Error('dsh not found');

    const error = await caught(daemon.ensure());
    expect(error).toBeInstanceOf(DshDaemonError);
    expect((error as DshDaemonError).code).toBe('spawn');
    expect((error as Error).message).toContain('dsh not found');
  });

  it('times out when the listener never becomes reachable', async () => {
    const daemon = new FakeDaemon(temporaryHome());
    daemon.timeoutMs = 20;

    const error = await caught(daemon.ensure());
    expect(error).toBeInstanceOf(DshDaemonError);
    expect((error as DshDaemonError).code).toBe('start-timeout');
  });

  it('reports a child that exited before the listener became reachable', async () => {
    const daemon = new FakeDaemon(temporaryHome());
    daemon.exitEarly = true;

    const error = await caught(daemon.ensure());
    expect(error).toBeInstanceOf(DshDaemonError);
    expect((error as DshDaemonError).code).toBe('spawn');
    expect((error as Error).message).toContain('提前退出');
  });

  it('removes a stale start lock left by a dead lark-remote', async () => {
    const home = temporaryHome();
    const lock = path.join(home, 'lark-remote', 'start.lock');
    fs.mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const daemon = new FakeDaemon(home);
    daemon.timeoutMs = 50;
    daemon.onSpawn = () => {
      setTimeout(() => {
        daemon.ready = true;
      }, 10);
    };

    await expect(daemon.ensure()).resolves.toBe('http://127.0.0.1:3099');
    expect(daemon.spawns).toBe(1);
  });
});

interface FakeChild {
  once: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  handlers: Record<string, (arg?: unknown) => void>;
}

/** fake 子进程：可让 spawnDaemon 注册的 error/exit 钩子立即落地。 */
function makeFakeChild(opts: { error?: Error; exit?: boolean } = {}): FakeChild {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  return {
    once: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb;
      if (event === 'error' && opts.error) cb(opts.error);
      if (event === 'exit' && opts.exit) cb();
    }),
    unref: vi.fn(),
    handlers,
  };
}

/**
 * 不覆盖 startTimeoutMs / manageProcess / spawnDaemon 的子类：让真实实现
 * 在公开入口 ensure() 下跑，spawnProcess 已被 mock 阻断真实进程。
 */
class RealHooksDaemon extends DshDaemon {
  private readonly probes: boolean[];

  constructor(home: string, opts: { probes: boolean[] } & Partial<DshDaemonOptions>) {
    const { probes, ...daemonOpts } = opts;
    super({
      host: () => 'http://127.0.0.1:3099',
      dshHome: () => home,
      ...daemonOpts,
    });
    this.probes = probes;
  }

  protected override async probe(): Promise<boolean> {
    return this.probes.shift() ?? false;
  }

  protected override async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2)));
  }
}

beforeEach(() => {
  spawnProcessMock.mockReset();
  spawnProcessMock.mockImplementation(() => makeFakeChild());
  mockLogger.warn.mockReset();
});

describe('DshDaemon 真实启动钩子（spawnProcess 已 mock）', () => {
  it('spawns a detached dsh web, writes a 0600 log, and unrefs the child', async () => {
    const home = temporaryHome();
    const daemon = new RealHooksDaemon(home, { probes: [false, false, false, true] });

    await expect(daemon.ensure()).resolves.toBe('http://127.0.0.1:3099');

    expect(spawnProcessMock).toHaveBeenCalledWith(
      'dsh',
      dshDaemonArgs('http://127.0.0.1:3099'),
      expect.objectContaining({
        detached: true,
        cwd: home,
        env: expect.objectContaining({ DSH_HOME: home }),
        stdio: ['ignore', 'ignore', expect.any(Number)],
      }),
    );
    const log = path.join(home, 'lark-remote', 'dsh-web.log');
    expect(fs.existsSync(log)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    }
    const child = spawnProcessMock.mock.results[0].value as unknown as FakeChild;
    expect(child.unref).toHaveBeenCalled();
    // 启动锁在成功启动后释放，不残留。
    expect(fs.existsSync(path.join(home, 'lark-remote', 'start.lock'))).toBe(false);
  });

  it('surfaces a child spawn error in the user-facing message', async () => {
    const home = temporaryHome();
    const failure = new Error('dsh binary missing');
    spawnProcessMock.mockImplementation(() => makeFakeChild({ error: failure }));
    const daemon = new RealHooksDaemon(home, { probes: [false, false, false] });

    const error = await caught(daemon.ensure());

    expect((error as DshDaemonError).code).toBe('spawn');
    expect((error as Error).message).toContain('dsh binary missing');
    expect((error as Error).message).toContain('日志：');
  });

  it('reports a child that exited before the listener became reachable', async () => {
    const home = temporaryHome();
    spawnProcessMock.mockImplementation(() => makeFakeChild({ exit: true }));
    const daemon = new RealHooksDaemon(home, { probes: [false, false, false] });

    const error = await caught(daemon.ensure());

    expect((error as DshDaemonError).code).toBe('spawn');
    expect((error as Error).message).toContain('提前退出');
  });

  it('uses a configured start timeout in the timeout message', async () => {
    const home = temporaryHome();
    const daemon = new RealHooksDaemon(home, {
      probes: [false, false, false],
      startTimeoutMs: () => 15,
    });

    const error = await caught(daemon.ensure());

    expect((error as DshDaemonError).code).toBe('start-timeout');
    expect((error as Error).message).toContain('15ms');
  });

  it('falls back to the 30s default when the configured timeout is not positive', async () => {
    const home = temporaryHome();
    let now = Date.now();
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    class ClockedDaemon extends RealHooksDaemon {
      protected override async sleep(ms: number): Promise<void> {
        now += ms;
      }
    }
    const daemon = new ClockedDaemon(home, {
      probes: [false, false, false],
      startTimeoutMs: () => 0,
    });
    try {
      const error = await caught(daemon.ensure());
      expect((error as DshDaemonError).code).toBe('start-timeout');
      expect((error as Error).message).toContain('30000ms');
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('does not spawn when manageProcess() is configured false', async () => {
    const home = temporaryHome();
    const daemon = new RealHooksDaemon(home, {
      probes: [false],
      manageProcess: () => false,
    });

    const error = await caught(daemon.ensure());

    expect((error as DshDaemonError).code).toBe('stopped');
    expect((error as Error).message).toContain('请先启动');
    expect(spawnProcessMock).not.toHaveBeenCalled();
  });

  it('warns and waits when the start lock cannot be stat-ed', async () => {
    const home = temporaryHome();
    const lock = path.join(home, 'lark-remote', 'start.lock');
    fs.mkdirSync(lock, { recursive: true });
    const realStat = fsp.stat;
    const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === lock) {
        return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      }
      return (realStat as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fsp.stat);
    const daemon = new RealHooksDaemon(home, {
      probes: [false, false, false],
      startTimeoutMs: () => 1,
    });
    try {
      const error = await caught(daemon.ensure());
      expect((error as DshDaemonError).code).toBe('start-lock');
      expect((error as Error).message).toContain('等待其他 lark-remote 启动 DSH 超时');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('cannot stat start lock'),
      );
    } finally {
      statSpy.mockRestore();
    }
  });
});
