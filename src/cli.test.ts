import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootstrap, decideRuntime, handlePreflight } from './cli.js';

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

/**
 * handlePreflight 的两件事：
 * ① -v/-h 在 import 应用模块图之前处理掉（node<14 上 dist/index.js 的 ES2022
 *    语法会直接 SyntaxError，看不出是版本问题）；
 * ② 运行时过旧时给一句人话，而不是抛 V8 的解析错误。
 */
describe('handlePreflight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('-v / --version / version → 打印版本号并 exit 0（不加载应用模块图）', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const arg of ['-v', '--version', 'version']) {
      writeSpy.mockClear();
      expect(handlePreflight([arg], '12.22.9')).toBe(0);
      expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/^lark-remote \d+\.\d+\.\d+\n$/));
    }
  });

  it('-h / --help / help → 打印帮助并 exit 0', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const arg of ['-h', '--help', 'help']) {
      writeSpy.mockClear();
      expect(handlePreflight([arg], '12.22.9')).toBe(0);
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    }
  });

  it('超出 engines 的低版本 node → 明确报错，退出码 1', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(handlePreflight(['--update'], '12.22.9')).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Node >= 18'));
  });

  it('版本够新 / 非信息类参数 → 返回 null（继续正常启动）', () => {
    expect(handlePreflight([], '22.22.2')).toBeNull();
    expect(handlePreflight(['--config-dir', '/tmp/x'], '20.0.0')).toBeNull();
  });

  it('版本字符串异常时不硬拦（解析不出主版本 → 放过）', () => {
    expect(handlePreflight([], '')).toBeNull();
    expect(handlePreflight([], 'unknown')).toBeNull();
  });
});

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
    // 信号注册随 platform 分支（posix: SIGHUP / win32: SIGBREAK）。显式注入
    // posix 宿主，让 SIGHUP 断言在 win32 开发机上同样成立；win32 信号集由
    // 下方「registers SIGBREAK instead of SIGHUP on win32」用例覆盖。
    platform: 'linux',
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
