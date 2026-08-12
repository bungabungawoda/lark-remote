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
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import type { AgentEvent, SpawnOptions } from '../../../src/runner/types.js';

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

/**
 * Minimal TestRunner for stoppedByUser and buildResultEvent tests.
 * Only overrides the 3 abstract hooks with no-ops.
 */
class MinimalTestRunner extends SpawningRunner {
  constructor(opts: { binary?: string; pidDir?: string; workspace?: string } = {}) {
    super({ workspace: 'test', pidDir: opts.pidDir });
    this.binary = opts.binary ?? 'testbin';
  }

  protected buildArgv(_opts: SpawnOptions): string[] {
    return ['--fake'];
  }

  protected translate(_rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
    return null;
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
    return (this as any).buildResultEvent(opts);
  }

  // Public setter to control stoppedByUser for testing
  public setStoppedByUser(val: boolean): void {
    (this as any).stoppedByUser = val;
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

    const mockProc = {
      pid: 99999,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => cb(0, null), 20);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test',
    });

    for await (const _event of runner.run('hi', { cwd: '/tmp/fake' })) {
      void _event;
    }

    expect(spawn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0];
    const expectedBinary = (runner as any).binary;
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
    const pidFilePath = (runner0 as any).pidFilePath as string;
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

    const mockProc = {
      pid: 88888,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => cb(0, null), 50);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir,
    });
    const livePidFilePath = (runner as any).pidFilePath as string;

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
    const pidFilePath = (runner0 as any).pidFilePath as string;
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

    const mockProc = {
      pid: 77777,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => cb(0, null), 50);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new ThrowingTestRunner({
      binary: 'fake-binary',
      pidDir,
    });
    const livePidFilePath = (runner as any).pidFilePath as string;

    for await (const _event of runner.run('hi', { cwd: '/tmp/fake' })) {
      void _event;
    }

    expect(fs.existsSync(livePidFilePath)).toBe(false);
  });

  it('test_anchor_spawning_runner_starts_heartbeat_after_spawn', async () => {
    const stdout = new Readable({
      read() {
        this.push('{"type":"system","subtype":"init","session_id":"x","cwd":"/tmp","model":"m"}\n');
        this.push(null);
      },
    });

    const mockProc = {
      pid: 66666,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => cb(0, null), 20);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r4',
    });

    const startSpy = vi.spyOn((runner as any).spawnHeartbeat, 'start');

    for await (const _event of runner.run('hi', { cwd: '/tmp/r4' })) {
      void _event;
    }

    expect(startSpy).toHaveBeenCalledOnce();
    expect(startSpy.mock.calls[0][0]).toEqual({
      pid: 66666,
      binary: (runner as any).binary,
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

    const mockProc = {
      pid: 55555,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => cb(0, null), 20);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r5',
    });

    const notifySpy = vi.spyOn((runner as any).spawnHeartbeat, 'notifyStdout');

    for await (const _event of runner.run('hi', { cwd: '/tmp/r5' })) {
      void _event;
    }

    expect(notifySpy).toHaveBeenCalledOnce();
  });

  it('test_anchor_spawning_runner_clears_heartbeat_in_finally', async () => {
    const stdout = new Readable({
      read() {
        this.push(null);
      },
    });

    const mockProc = {
      pid: 44444,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => cb(0, null), 20);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r6',
    });

    const spawnHeartbeat = (runner as any).spawnHeartbeat;
    const realStart = spawnHeartbeat.start.bind(spawnHeartbeat);

    const clearSpy = vi.spyOn(spawnHeartbeat, 'clear');

    const startSpy = vi.spyOn(spawnHeartbeat, 'start');
    startSpy.mockImplementationOnce((ctx: unknown) => {
      realStart(ctx);
      clearSpy.mockClear();
    });

    for await (const _event of runner.run('hi', { cwd: '/tmp/r6' })) {
      void _event;
    }

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

    const mockProc = {
      pid: 33333,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => cb(1, null), 20);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

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

    const mockProc = {
      pid: 22222,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => cb(1, null), 20);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

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
    const mockProc = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      stdout: null,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') {
          setTimeout(() => cb(new Error('spawn ENOENT')), 10);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

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
    expect(events).toHaveLength(1);

    const event = events[0] as any;
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

    (runner as any).currentProcess = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
    };

    expect((runner as any).isRunning).toBe(true);

    const consume = async () => {
      for await (const _event of runner.run('hi', { cwd: '/tmp/r10' })) {
        void _event;
      }
    };

    await expect(consume()).rejects.toThrow(/already running/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('test_anchor_spawning_runner_stop_delegates_to_stopper_with_immediate', async () => {
    const runner = new TestRunner({
      binary: 'fake-binary',
      pidDir: '/tmp/spawning-runner-anchor-test-r11',
    });

    const stopperStopSpy = vi.spyOn((runner as any).stopper, 'stop').mockResolvedValue(undefined);

    const fakeProc = {
      pid: 24680,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: vi.fn(),
    };
    (runner as any).currentProcess = fakeProc;

    expect((runner as any).isRunning).toBe(true);

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

    const pidFilePath = (runner as any).pidFilePath as string;
    try {
      fs.rmSync(pidFilePath, { force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(pidFilePath, '13579', 'utf-8');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    expect(fs.existsSync(pidFilePath)).toBe(true);

    vi.mocked(execFileSync).mockReturnValue('fake-binary --some-flag');

    try {
      (runner as any).killOrphan();

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

    const pidFilePath = (runner as any).pidFilePath as string;

    fs.rmSync(pidFilePath, { force: true });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    expect(fs.existsSync(pidFilePath)).toBe(false);

    try {
      (runner as any).killOrphan();

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

    const pidFilePath = (runner as any).pidFilePath as string;
    try {
      fs.rmSync(pidFilePath, { force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(pidFilePath, 'not-a-number', 'utf-8');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    expect(fs.existsSync(pidFilePath)).toBe(true);

    try {
      (runner as any).killOrphan();

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

    const mockProc: {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    } = { pid: 12345, exitCode: null, signalCode: null };
    (runner as any).currentProcess = mockProc;

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

    class BackpressureTestRunner extends SpawningRunner {
      constructor() {
        super({
          binary: 'echo',
          workspace: 'test',
          pidFilePrefix: 'test-p1-4',
          logTag: 'test-p1-4',
        });
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
    const stream = (
      runner as unknown as { createStreamReader(stdout: Readable): AsyncGenerator<unknown> }
    ).createStreamReader(readable);

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
    expect((runner as any).stoppedByUser).toBe(false);
  });

  it('test_anchor_stop_sets_stopped_by_user_true_when_process_running', async () => {
    const runner = new MinimalTestRunner({
      binary: 'fake',
      pidDir: '/tmp/spawning-runner-r21',
    });

    const stopperStopSpy = vi.spyOn((runner as any).stopper, 'stop').mockResolvedValue(undefined);

    const fakeProc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: vi.fn(),
    };
    (runner as any).currentProcess = fakeProc;

    expect((runner as any).isRunning).toBe(true);
    expect((runner as any).stoppedByUser).toBe(false);

    await runner.stop({ immediate: true });

    expect((runner as any).stoppedByUser).toBe(true);
    expect(stopperStopSpy).toHaveBeenCalledOnce();
  });

  it('test_anchor_stop_does_not_set_stopped_by_user_when_no_process', async () => {
    const runner = new MinimalTestRunner({
      binary: 'fake',
      pidDir: '/tmp/spawning-runner-r21',
    });

    expect((runner as any).currentProcess).toBe(null);
    expect((runner as any).isRunning).toBe(false);
    expect((runner as any).stoppedByUser).toBe(false);

    await runner.stop();

    expect((runner as any).stoppedByUser).toBe(false);
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

    const event = runner.callBuildResultEvent({ code: 0, signal: null }) as any;

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
    }) as any;

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
    }) as any;

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
    }) as any;

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
    }) as any;

    expect(event.type).toBe('result');
    expect(event.subtype).toBe('success');
    expect(event.session_id).toBe('sess-456');
    expect(event.usage).toBeUndefined();
    expect(event.errorMessage).toBeUndefined();
  });
});
