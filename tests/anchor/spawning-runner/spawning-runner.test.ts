/**
 * Merged anchor tests for SpawningRunner
 *
 * Source files (merged 2026-08-04, Phase 4):
 *   - spawning-runner.test.ts
 *   - spawning-runner-default-backpressure.test.ts
 *   - spawning-runner-stopped-by-user.test.ts
 *   - spawning-runner-build-result-event.test.ts
 */
import { describe, it, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import type { AgentEvent, Runner, SpawnOptions } from '../../../src/runner/types.js';
import type { SpawnHeartbeat } from '../../../src/runner/common/spawn-heartbeat.js';
import type { ProcessStopper } from '../../../src/runner/common/process-stopper.js';
import { createMockProc } from '../../../tests/lib/mock-process.js';

// ---------------------------------------------------------------------------
// Shared mock setup
// ---------------------------------------------------------------------------

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

import { spawn, execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// TestRunner subclasses
// ---------------------------------------------------------------------------

/**
 * Concrete TestRunner that overrides only buildArgv() and the stateless
 * translate() hook. `buildArgv` returns a recognizable marker
 * argv so the assertion can detect whether run() actually used the hook's
 * return value as the spawn argv. `translate` is a no-op passthrough.
 */
class TestRunner extends SpawningRunner {
  constructor(opts: { binary?: string; pidDir?: string; workspace?: string } = {}) {
    super({ workspace: 'test', pidDir: opts.pidDir });
    // SpawningRunner no longer takes a binary option; subclasses set the
    // hard-coded CLI name (like the real runners do) after super().
    this.binary = opts.binary ?? 'testbin';
  }

  protected buildArgv(_opts: SpawnOptions): string[] {
    return ['--fake-flag', 'marker'];
  }

  protected translate(rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
    // Pass-through so tests can observe events yielded by run()'s for-await
    // loop. Round 1's test uses empty stdout, so this is never called there.
    return rawEvent as AgentEvent;
  }

  protected validateConfig(): void {
    /* no-op */
  }

  // Public wrapper to expose protected buildResultEvent for testing.
  public callBuildResultEvent(opts: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr?: string;
    sessionId?: string;
    usage?: Record<string, unknown>;
  }): AgentEvent {
    return this.buildResultEvent(opts);
  }

  // Public setter to control stoppedByUser for testing
  public setStoppedByUser(val: boolean): void {
    this.stoppedByUser = val;
  }

  // ── 类型化测试访问器 ────────────────────────────────────────────
  // protected 成员对子类可见，这里用 typed getter/setter 暴露给测试。
  get testBinary(): string {
    return this.binary;
  }

  get testPidFilePath(): string {
    return this.pidFilePath;
  }

  get testSpawnHeartbeat(): SpawnHeartbeat {
    return this.spawnHeartbeat;
  }

  get testStopper(): ProcessStopper {
    return this.stopper;
  }

  get testCurrentProcess(): ChildProcess | null {
    return this.currentProcess;
  }

  set testCurrentProcess(proc: ChildProcess | null) {
    this.currentProcess = proc;
  }

  get testStoppedByUser(): boolean {
    return this.stoppedByUser;
  }

  createTestStreamReader(stdout: Readable): AsyncGenerator<unknown> {
    return this.createStreamReader(stdout);
  }
}

/**
 * Subclass of TestRunner whose `translate` always throws — used by Round 3
 * anchor to force a throw INSIDE run()'s try block (the for-await loop).
 */
class ThrowingTestRunner extends TestRunner {
  protected translate(_rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
    throw new Error('translate boom');
  }
}

/** isRunning getter 只读 pid/exitCode/signalCode，这里定义测试注入的最小形状。 */
/**
 * 构造可被 vi.mocked(spawn).mockReturnValue 接受的 ChildProcess mock。
 *
 * 统一收敛到 tests/lib 的 createMockProc（无 cast）。
 */
function makeMockProc(
  opts: {
    pid?: number;
    stdout?: Readable | null;
    stderr?: unknown;
    close?: (event: string, cb: (...args: unknown[]) => void) => void;
  } = {},
): ReturnType<typeof spawn> {
  const stdout =
    opts.stdout === undefined
      ? new Readable({
          read() {
            this.push(null);
          },
        })
      : opts.stdout;
  const defaultClose = (event: string, cb: (...args: unknown[]) => void): void => {
    if (event === 'close') {
      setTimeout(() => cb(0, null), 20);
    }
  };
  return createMockProc({
    // 显式传 pid: undefined 表示「spawn 后拿不到 pid」（ENOENT 路径），
    // 不能 fallback 到默认 pid，否则 runner 走正常路径读 stdout 崩溃。
    pid: 'pid' in opts ? opts.pid : 99999,
    exitCode: null,
    signalCode: null,
    stdout,
    stderr: opts.stderr ?? { on: vi.fn(), destroy: vi.fn() },
    kill: vi.fn(),
    once: vi.fn(opts.close ?? defaultClose),
  });
}

/** 纯消费 runner.run 的 drain 循环（8 处相同循环的收敛点）。 */
async function drainRun(runner: Runner, input: string, cwd = '/tmp/fake'): Promise<void> {
  for await (const _event of runner.run(input, { cwd })) {
    void _event;
  }
}

/**
 * Minimal TestRunner for stoppedByUser and buildResultEvent tests.
 * Only overrides the 3 abstract hooks with no-ops.
 */
class MinimalTestRunner extends TestRunner {
  protected buildArgv(_opts: SpawnOptions): string[] {
    return ['--fake'];
  }

  protected translate(_rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
    return null;
  }

  protected validateConfig(): void {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// SpawningRunner.run() spawn orchestration
// ---------------------------------------------------------------------------

describe('SpawningRunner.run() spawn orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    const tempDirs = [
      '/tmp/spawning-runner-anchor-test-r2',
      '/tmp/spawning-runner-anchor-test-r3',
      '/tmp/spawning-runner-anchor-test-r12',
      '/tmp/spawning-runner-anchor-test-r13',
      '/tmp/spawning-runner-anchor-test-r14',
    ];
    for (const dir of tempDirs) {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          fs.rmSync(`${dir}/${entry}`, { force: true });
        }
      } catch {
        /* dir may not exist */
      }
    }
  });

  it('test_anchor_spawning_runner_run_spawns_with_build_argv_result', async () => {
    const stdout = new Readable({
      read() {
        this.push(null);
      },
    });

    const mockProc = makeMockProc({ stdout });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test',
    });

    await drainRun(runner, 'hi');

    expect(spawn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0];
    const expectedBinary = runner.testBinary;
    expect(call[0]).toBe(expectedBinary);
    expect(call[1]).toEqual(['--fake-flag', 'marker']);
    expect(call[2]).toMatchObject({
      cwd: '/tmp/fake',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  });

  it('test_anchor_spawning_runner_writes_pid_file_after_spawn', async () => {
    const pidDir = '/tmp/spawning-runner-anchor-test-r2';
    fs.mkdirSync(pidDir, { recursive: true });
    const runner0 = new TestRunner({ binary: 'fake-binary', pidDir });
    const pidFilePath = runner0.testPidFilePath;
    try {
      fs.rmSync(pidFilePath, { force: true });
    } catch {
      /* ignore */
    }

    const stdout = new Readable({
      read() {
        this.push('{"type":"system","subtype":"init","session_id":"x","cwd":"/tmp","model":"m"}\n');
        this.push(null);
      },
    });

    const mockProc = makeMockProc({
      pid: 88888,
      stdout,
      close: (event, cb) => {
        if (event === 'close') setTimeout(() => cb(0, null), 50);
      },
    });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir,
    });
    const livePidFilePath = runner.testPidFilePath;

    let observedMidRun = false;
    for await (const _event of runner.run('hi', { cwd: '/tmp/fake' })) {
      void _event;
      expect(fs.existsSync(livePidFilePath)).toBe(true);
      expect(fs.readFileSync(livePidFilePath, 'utf-8')).toBe('88888');
      observedMidRun = true;
    }

    expect(observedMidRun).toBe(true);
  });

  it('test_anchor_spawning_runner_cleans_pid_file_in_finally_on_throw', async () => {
    const pidDir = '/tmp/spawning-runner-anchor-test-r3';
    fs.mkdirSync(pidDir, { recursive: true });
    const runner0 = new ThrowingTestRunner({ binary: 'fake-binary', pidDir });
    const pidFilePath = runner0.testPidFilePath;
    try {
      fs.rmSync(pidFilePath, { force: true });
    } catch {
      /* ignore */
    }

    const stdout = new Readable({
      read() {
        this.push('{"type":"system","subtype":"init","session_id":"x","cwd":"/tmp","model":"m"}\n');
        this.push(null);
      },
    });

    const mockProc = makeMockProc({
      pid: 77777,
      stdout,
      close: (event, cb) => {
        if (event === 'close') setTimeout(() => cb(0, null), 50);
      },
    });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new ThrowingTestRunner({
      binary: 'fake-binary',
      pidDir,
    });
    const livePidFilePath = runner.testPidFilePath;

    await drainRun(runner, 'hi');

    expect(fs.existsSync(livePidFilePath)).toBe(false);
  });

  it('test_anchor_spawning_runner_starts_heartbeat_after_spawn', async () => {
    const stdout = new Readable({
      read() {
        this.push('{"type":"system","subtype":"init","session_id":"x","cwd":"/tmp","model":"m"}\n');
        this.push(null);
      },
    });

    const mockProc = makeMockProc({ pid: 66666, stdout });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r4',
    });

    const startSpy = vi.spyOn(runner.testSpawnHeartbeat, 'start');

    await drainRun(runner, 'hi', '/tmp/r4');

    expect(startSpy).toHaveBeenCalledOnce();
    expect(startSpy.mock.calls[0][0]).toEqual({
      pid: 66666,
      binary: runner.testBinary,
      cwd: '/tmp/r4',
    });
  });

  it('test_anchor_spawning_runner_notifies_heartbeat_on_first_stdout', async () => {
    const stdout = new Readable({
      read() {
        this.push('{"type":"system","subtype":"init","session_id":"x","cwd":"/tmp","model":"m"}\n');
        this.push(null);
      },
    });

    const mockProc = makeMockProc({ pid: 55555, stdout });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r5',
    });

    const notifySpy = vi.spyOn(runner.testSpawnHeartbeat, 'notifyStdout');

    await drainRun(runner, 'hi', '/tmp/r5');

    expect(notifySpy).toHaveBeenCalledOnce();
  });

  it('test_anchor_spawning_runner_clears_heartbeat_in_finally', async () => {
    const stdout = new Readable({
      read() {
        this.push(null);
      },
    });

    const mockProc = makeMockProc({ pid: 44444, stdout });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r6',
    });

    const spawnHeartbeat = runner.testSpawnHeartbeat;
    const realStart = spawnHeartbeat.start.bind(spawnHeartbeat);

    const clearSpy = vi.spyOn(spawnHeartbeat, 'clear');

    const startSpy = vi.spyOn(spawnHeartbeat, 'start');
    startSpy.mockImplementationOnce((ctx: unknown) => {
      realStart(ctx);
      clearSpy.mockClear();
    });

    await drainRun(runner, 'hi', '/tmp/r6');

    expect(clearSpy).toHaveBeenCalledTimes(2);
  });

  it('test_anchor_spawning_runner_throws_on_nonzero_exit_with_stderr', async () => {
    const stdout = new Readable({
      read() {
        this.push(null);
      },
    });

    const stderr = {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('BOOM-STDERR-MARKER'));
      }),
      destroy: vi.fn(),
    };

    const mockProc = makeMockProc({
      pid: 33333,
      stdout,
      stderr,
      close: (event, cb) => {
        if (event === 'close') setTimeout(() => cb(1, null), 20);
      },
    });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r7',
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hi', { cwd: '/tmp/r7' })) {
      events.push(event);
    }

    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBe(1);
    const result = resultEvents[0] as { subtype?: string; errorMessage?: string };
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toMatch(/code=1/);
    expect(result.errorMessage).toContain('BOOM-STDERR-MARKER');
  });

  it('test_anchor_spawning_runner_stderr_capped_at_4000_keeps_tail', async () => {
    const stdout = new Readable({
      read() {
        this.push(null);
      },
    });

    const stderr = {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') {
          cb(Buffer.from('H'.repeat(4500)));
          cb(Buffer.from('T'.repeat(500)));
        }
      }),
      destroy: vi.fn(),
    };

    const mockProc = makeMockProc({
      pid: 22222,
      stdout,
      stderr,
      close: (event, cb) => {
        if (event === 'close') setTimeout(() => cb(1, null), 20);
      },
    });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r8',
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hi', { cwd: '/tmp/r8' })) {
      events.push(event);
    }

    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBe(1);
    const result = resultEvents[0] as { subtype?: string; errorMessage?: string };
    expect(result.subtype).toBe('error');
    const message = result.errorMessage ?? '';

    expect(message).toContain('T'.repeat(500));
    expect(message).not.toContain('H'.repeat(4500));
    expect(message).not.toContain('H'.repeat(4000));
  });

  it('test_anchor_spawning_runner_yields_auth_error_event_on_spawn_failure', async () => {
    const mockProc = makeMockProc({
      pid: undefined,
      stdout: null,
      close: (event, cb) => {
        if (event === 'error') setTimeout(() => cb(new Error('spawn ENOENT')), 10);
      },
    });

    vi.mocked(spawn).mockReturnValue(mockProc);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r9',
    });

    const events: AgentEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of runner.run('hi', { cwd: '/tmp/r9' })) {
        events.push(event);
      }
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeUndefined();
    // §9.22: spawning-runner now yields syntheticInitEvent before authErrorEvent
    // so the bridge's pre-init result guard doesn't silently drop the error.
    expect(events).toHaveLength(2);

    const initEvent = events[0] as { type: string; subtype?: string };
    expect(initEvent.type).toBe('system');
    expect(initEvent.subtype).toBe('init');

    const event = events[1] as { type: string; subtype?: string; errorMessage?: string };
    expect(event.type).toBe('result');
    expect(event.subtype).toBe('error');
    expect(typeof event.errorMessage).toBe('string');
    expect(event.errorMessage.length).toBeGreaterThan(0);
    expect(
      event.errorMessage.includes('fake-binary') ||
        /不可用|not found|unavailable|ENOENT/i.test(event.errorMessage),
    ).toBe(true);
  });

  it('test_anchor_spawning_runner_rejects_reentry_when_already_running', async () => {
    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r10',
    });

    runner.testCurrentProcess = createMockProc({ pid: 12345, exitCode: null, signalCode: null });

    expect(runner.isRunning).toBe(true);

    const consume = async () => {
      await drainRun(runner, 'hi', '/tmp/r10');
    };

    await expect(consume()).rejects.toThrow(/already running/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('test_anchor_spawning_runner_stop_delegates_to_stopper_with_immediate', async () => {
    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r11',
    });

    const stopperStopSpy = vi.spyOn(runner.testStopper, 'stop').mockResolvedValue(undefined);

    const fakeProc = createMockProc({
      pid: 24680,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: vi.fn(),
    });
    runner.testCurrentProcess = fakeProc;

    expect(runner.isRunning).toBe(true);

    await runner.stop({ immediate: true });

    expect(stopperStopSpy).toHaveBeenCalledOnce();
    expect(stopperStopSpy.mock.calls[0][0]).toBe(fakeProc);
    expect(stopperStopSpy.mock.calls[0][1]).toEqual({ immediate: true });
  });

  it('test_anchor_spawning_runner_kill_orphan_reads_pid_sends_sigterm_cleans_file', () => {
    const pidDir = '/tmp/spawning-runner-anchor-test-r12';
    fs.mkdirSync(pidDir, { recursive: true });

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir,
    });

    const pidFilePath = runner.testPidFilePath;
    try {
      fs.rmSync(pidFilePath, { force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(pidFilePath, '13579', 'utf-8');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(fs.existsSync(pidFilePath)).toBe(true);

    vi.mocked(execFileSync).mockReturnValue('fake-binary --some-flag');

    try {
      runner.killOrphan();

      expect(killSpy).toHaveBeenCalledWith(-13579, 'SIGTERM');
      expect(fs.existsSync(pidFilePath)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('test_anchor_spawning_runner_kill_orphan_silent_when_no_pid_file', () => {
    const pidDir = '/tmp/spawning-runner-anchor-test-r13';
    fs.mkdirSync(pidDir, { recursive: true });

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir,
    });

    const pidFilePath = runner.testPidFilePath;

    fs.rmSync(pidFilePath, { force: true });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(fs.existsSync(pidFilePath)).toBe(false);

    try {
      runner.killOrphan();

      expect(fs.existsSync(pidFilePath)).toBe(false);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('test_anchor_spawning_runner_kill_orphan_cleans_file_and_returns_on_non_numeric_pid', () => {
    const pidDir = '/tmp/spawning-runner-anchor-test-r14';
    fs.mkdirSync(pidDir, { recursive: true });

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir,
    });

    const pidFilePath = runner.testPidFilePath;
    try {
      fs.rmSync(pidFilePath, { force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(pidFilePath, 'not-a-number', 'utf-8');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(fs.existsSync(pidFilePath)).toBe(true);

    try {
      runner.killOrphan();

      expect(fs.existsSync(pidFilePath)).toBe(false);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('test_anchor_spawning_runner_is_running_reflects_process_state', () => {
    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r15',
    });

    expect(runner.isRunning).toBe(false);

    const mockProc = createMockProc({ pid: 12345, exitCode: null, signalCode: null });
    runner.testCurrentProcess = mockProc;

    expect(runner.isRunning).toBe(true);

    mockProc.exitCode = 0;
    expect(runner.isRunning).toBe(false);

    mockProc.exitCode = null;
    mockProc.signalCode = 'SIGTERM';
    expect(runner.isRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1-4 A2: createStreamReader enables backpressure by default
// ---------------------------------------------------------------------------

describe('P1-4 A2: createStreamReader enables backpressure by default', () => {
  test('test_anchor_create_stream_reader_default_backpressure_enabled', async () => {
    const readable = new Readable({ read() {} });
    const pauseCalls: number[] = [];
    const origPause = readable.pause.bind(readable);
    readable.pause = function () {
      pauseCalls.push(1);
      return origPause();
    };

    class BackpressureTestRunner extends TestRunner {
      constructor() {
        super({ binary: 'echo', workspace: 'test' });
      }
      protected buildArgv(_opts: SpawnOptions): string[] {
        return [];
      }
      protected translate(_rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
        return null;
      }
      protected validateConfig(): void {
        /* no-op */
      }
    }
    const runner = new BackpressureTestRunner();
    const stream = runner.createTestStreamReader(readable);

    for (let i = 0; i < 1000; i++) {
      readable.push(`{"type":"text","data":"line-${i}"}\n`);
    }
    readable.push(null);

    for await (const _ of stream) {
      // drain all
    }

    expect(pauseCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SpawningRunner stoppedByUser state
// ---------------------------------------------------------------------------

describe('SpawningRunner stoppedByUser state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('test_anchor_stopped_by_user_initially_false', () => {
    const runner = new MinimalTestRunner({
      binary: 'fake',
      pidDir: '/tmp/spawning-runner-r21',
    });
    expect(runner.testStoppedByUser).toBe(false);
  });

  it('test_anchor_stop_sets_stopped_by_user_true_when_process_running', async () => {
    const runner = new MinimalTestRunner({
      binary: 'fake',
      pidDir: '/tmp/spawning-runner-r21',
    });

    const stopperStopSpy = vi.spyOn(runner.testStopper, 'stop').mockResolvedValue(undefined);

    const fakeProc = createMockProc({
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: vi.fn(),
    });
    runner.testCurrentProcess = fakeProc;

    expect(runner.isRunning).toBe(true);
    expect(runner.testStoppedByUser).toBe(false);

    await runner.stop({ immediate: true });

    expect(runner.testStoppedByUser).toBe(true);
    expect(stopperStopSpy).toHaveBeenCalledOnce();
  });

  it('test_anchor_stop_does_not_set_stopped_by_user_when_no_process', async () => {
    const runner = new MinimalTestRunner({
      binary: 'fake',
      pidDir: '/tmp/spawning-runner-r21',
    });

    expect(runner.testCurrentProcess).toBe(null);
    expect(runner.isRunning).toBe(false);
    expect(runner.testStoppedByUser).toBe(false);

    await runner.stop();

    expect(runner.testStoppedByUser).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpawningRunner.buildResultEvent()
// ---------------------------------------------------------------------------

describe('SpawningRunner.buildResultEvent()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('test_anchor_build_result_event_stopped_by_user_returns_error', () => {
    const runner = new MinimalTestRunner({
      binary: 'fake-agent',
      pidDir: '/tmp/spawning-runner-r22',
    });
    runner.setStoppedByUser(true);

    const event = runner.callBuildResultEvent({ code: 0, signal: null }) as {
      type: string;
      subtype?: string;
      errorMessage?: string;
    };

    expect(event.type).toBe('result');
    expect(event.subtype).toBe('error');
    expect(event.errorMessage).toContain('interrupted by user');
  });

  it('test_anchor_build_result_event_nonzero_code_returns_error_with_stderr', () => {
    const runner = new MinimalTestRunner({
      binary: 'fake-agent',
      pidDir: '/tmp/spawning-runner-r22',
    });
    runner.setStoppedByUser(false);

    const event = runner.callBuildResultEvent({
      code: 1,
      signal: null,
      stderr: 'API key invalid',
    }) as { type: string; subtype?: string; errorMessage?: string };

    expect(event.type).toBe('result');
    expect(event.subtype).toBe('error');
    expect(event.errorMessage).toMatch(/code=1/);
    expect(event.errorMessage).toContain('API key invalid');
  });

  it('test_anchor_build_result_event_signal_returns_error', () => {
    const runner = new MinimalTestRunner({
      binary: 'fake-agent',
      pidDir: '/tmp/spawning-runner-r22',
    });
    runner.setStoppedByUser(false);

    const event = runner.callBuildResultEvent({
      code: null,
      signal: 'SIGTERM',
    }) as { type: string; subtype?: string; errorMessage?: string };

    expect(event.type).toBe('result');
    expect(event.subtype).toBe('error');
    expect(event.errorMessage).toMatch(/SIGTERM|signal/i);
  });

  it('test_anchor_build_result_event_success_includes_usage', () => {
    const runner = new MinimalTestRunner({
      binary: 'fake-agent',
      pidDir: '/tmp/spawning-runner-r22',
    });
    runner.setStoppedByUser(false);

    const usage = { input_tokens: 100, output_tokens: 50 };
    const event = runner.callBuildResultEvent({
      code: 0,
      signal: null,
      sessionId: 'sess-123',
      usage,
    }) as {
      type: string;
      subtype?: string;
      errorMessage?: string;
      session_id?: string;
      usage?: unknown;
    };

    expect(event.type).toBe('result');
    expect(event.subtype).toBe('success');
    expect(event.session_id).toBe('sess-123');
    expect(event.usage).toEqual(usage);
    expect(event.errorMessage).toBeUndefined();
  });

  it('test_anchor_build_result_event_success_without_usage', () => {
    const runner = new MinimalTestRunner({
      binary: 'fake-agent',
      pidDir: '/tmp/spawning-runner-r22',
    });
    runner.setStoppedByUser(false);

    const event = runner.callBuildResultEvent({
      code: 0,
      signal: null,
      sessionId: 'sess-456',
    }) as {
      type: string;
      subtype?: string;
      errorMessage?: string;
      session_id?: string;
    };

    expect(event.type).toBe('result');
    expect(event.subtype).toBe('success');
    expect(event.session_id).toBe('sess-456');
    expect(event.usage).toBeUndefined();
    expect(event.errorMessage).toBeUndefined();
  });
});
