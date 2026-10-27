import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshDaemon, DshDaemonError, dshDaemonArgs, isLoopbackHttpUrl } from './daemon.js';
import { resolveDshHome } from '../../dsh/home.js';

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
