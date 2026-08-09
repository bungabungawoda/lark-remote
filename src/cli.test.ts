import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrap, decideRuntime } from './cli.js';

interface BunProbe {
  error: boolean;
  status: number | null;
}

interface ChildLike {
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

interface BootstrapDeps {
  entry: string;
  args: string[];
  isBun: boolean;
  probe: BunProbe;
  platform?: string;
  importEntry: () => Promise<unknown>;
  spawnBun: (entry: string, args: string[]) => ChildLike;
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  offSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  killSelf: (signal: NodeJS.Signals) => void;
  exit: (code: number) => void;
}

describe('decideRuntime', () => {
  it('prefers bun when it is usable', () => {
    expect(decideRuntime(false, { error: false, status: 0 })).toBe('bun');
  });

  it('falls back to node when already running under bun', () => {
    expect(decideRuntime(true, { error: false, status: 0 })).toBe('node');
  });

  it('falls back to node when bun is not found', () => {
    expect(decideRuntime(false, { error: true, status: null })).toBe('node');
  });

  it('falls back to node when bun --version exits non-zero', () => {
    expect(decideRuntime(false, { error: false, status: 2 })).toBe('node');
  });
});

interface Captured {
  onError?: (err: Error) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

function makeDeps(overrides: Partial<BootstrapDeps> = {}) {
  const captured: Captured = {};
  const child: ChildLike = {
    on(event, listener) {
      if (event === 'error') captured.onError = listener as (err: Error) => void;
      if (event === 'exit') {
        captured.onExit = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
      }
      return child;
    },
    kill: vi.fn(() => true),
  };
  const deps: BootstrapDeps = {
    entry: '/app/dist/index.js',
    args: ['--config-dir', '/tmp/x'],
    isBun: false,
    probe: { error: false, status: 0 },
    importEntry: vi.fn(async () => undefined),
    spawnBun: vi.fn(() => child),
    onSignal: vi.fn(),
    offSignal: vi.fn(),
    killSelf: vi.fn(),
    exit: vi.fn(),
    ...overrides,
  };
  return { deps, captured };
}

describe('bootstrap', () => {
  it('prefers bun: spawns bun with entry and forwarded args, registers terminal signals', async () => {
    const { deps } = makeDeps();
    await bootstrap(deps);

    expect(deps.spawnBun).toHaveBeenCalledWith('/app/dist/index.js', ['--config-dir', '/tmp/x']);
    expect(deps.onSignal).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(deps.onSignal).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(deps.onSignal).toHaveBeenCalledWith('SIGHUP', expect.any(Function));
    expect(deps.importEntry).not.toHaveBeenCalled();
  });

  it('mirrors a clean child exit code', async () => {
    const { deps, captured } = makeDeps();
    await bootstrap(deps);

    captured.onExit?.(0, null);

    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('mirrors a non-zero child exit code', async () => {
    const { deps, captured } = makeDeps();
    await bootstrap(deps);

    captured.onExit?.(42, null);

    expect(deps.exit).toHaveBeenCalledWith(42);
  });

  it('re-raises a terminating signal to self, dropping forward handlers first', async () => {
    const { deps, captured } = makeDeps();
    await bootstrap(deps);

    captured.onExit?.(null, 'SIGTERM');

    expect(deps.offSignal).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(deps.killSelf).toHaveBeenCalledWith('SIGTERM');
  });

  it('exits 1 when re-raising the signal to self fails', async () => {
    const { deps, captured } = makeDeps({
      killSelf: vi.fn(() => {
        throw new Error('unsupported signal');
      }),
    });
    await bootstrap(deps);

    captured.onExit?.(null, 'SIGTERM');

    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when child exit reports neither code nor signal', async () => {
    const { deps, captured } = makeDeps();
    await bootstrap(deps);

    captured.onExit?.(null, null);

    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('falls back to in-process import when spawning bun fails', async () => {
    const { deps, captured } = makeDeps();
    await bootstrap(deps);

    captured.onError?.(new Error('ENOENT'));

    expect(deps.importEntry).toHaveBeenCalled();
    expect(deps.offSignal).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(deps.offSignal).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(deps.offSignal).toHaveBeenCalledWith('SIGHUP', expect.any(Function));
  });

  it('falls back to in-process import when bun is unavailable', async () => {
    const { deps } = makeDeps({ probe: { error: true, status: null } });
    await bootstrap(deps);

    expect(deps.importEntry).toHaveBeenCalled();
    expect(deps.spawnBun).not.toHaveBeenCalled();
  });

  it('runs in-process when already under bun', async () => {
    const { deps } = makeDeps({ isBun: true });
    await bootstrap(deps);

    expect(deps.importEntry).toHaveBeenCalled();
    expect(deps.spawnBun).not.toHaveBeenCalled();
  });

  it('registers SIGBREAK instead of SIGHUP on win32', async () => {
    const { deps } = makeDeps({ platform: 'win32' });
    await bootstrap(deps);

    expect(deps.onSignal).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(deps.onSignal).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(deps.onSignal).toHaveBeenCalledWith('SIGBREAK', expect.any(Function));
    expect(deps.onSignal).not.toHaveBeenCalledWith('SIGHUP', expect.any(Function));
  });
});

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distCli = join(repoRoot, 'dist', 'cli.js');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};

describe.skipIf(process.platform === 'win32')('bootstrap subprocess smoke', () => {
  beforeAll(() => {
    rmSync(join(repoRoot, 'dist'), { recursive: true, force: true });
    const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const build = spawnSync(nodeBin(), [tsc, '-p', repoRoot], { stdio: 'inherit' });
    expect(build.status).toBe(0);
    chmodSync(join(repoRoot, 'dist', 'index.js'), 0o755);
    chmodSync(distCli, 0o755);
  }, 120_000);

  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lark-cli-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function nodeBin(): string {
    const which = spawnSync('which', ['node']);
    return which.status === 0 ? which.stdout.toString().trim() : 'node';
  }

  it('falls back to node when bun is absent and serves --version', () => {
    const emptyDir = join(tmp, 'empty');
    mkdirSync(emptyDir);
    const r = spawnSync(nodeBin(), [distCli, '--version'], {
      env: { ...process.env, PATH: emptyDir },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`lark-remote ${pkg.version}\n`);
  }, 60_000);

  it('prefers bun: forwards args to bun and mirrors its exit code', () => {
    const fakeBun = join(tmp, 'bun');
    const log = join(tmp, 'bun.log');
    writeFileSync(
      fakeBun,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "if (process.argv[2] === '--version') process.exit(0);",
        'fs.writeFileSync(process.env.FAKE_BUN_LOG, process.argv.slice(2).join(" "));',
        'process.exit(Number(process.env.FAKE_BUN_CODE ?? 0));',
        '',
      ].join('\n'),
    );
    chmodSync(fakeBun, 0o755);

    const r = spawnSync(nodeBin(), [distCli, '--config-dir', '/tmp/xyz'], {
      env: {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH}`,
        FAKE_BUN_LOG: log,
        FAKE_BUN_CODE: '42',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(r.status).toBe(42);
    const logged = readFileSync(log, 'utf8');
    expect(logged).toContain('dist/index.js');
    expect(logged).toContain('--config-dir /tmp/xyz');
  }, 60_000);
});
