/**
 * Merged anchor tests for OpencodeExecRunner
 *
 * Source files (merged 2026-08-04, Phase 4):
 *   - opencode-runner-non-zero-exit-result.test.ts
 *   - opencode-runner-signal-kill-result.test.ts
 *   - opencode-runner-stopped-by-user-result.test.ts
 *   - opencode-runner-spawning-base.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Shared mock setup (used by the 3 result-event describe blocks)
// ---------------------------------------------------------------------------

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../../src/runner/common/process-stopper.js', () => ({
  ProcessStopper: class {
    constructor() {}
    async stop() {}
  },
}));

vi.mock('../../../src/runner/common/spawn-heartbeat.js', () => ({
  SpawnHeartbeat: class {
    constructor() {}
    start() {}
    notifyStdout() {}
    clear() {}
  },
}));

// Import after mocks
const { OpencodeExecRunner } = await import('../../../src/runner/opencode/index.js');
const { spawn } = await import('node:child_process');

// ---------------------------------------------------------------------------
// D6: non-zero exit code → result subtype='error'
// ---------------------------------------------------------------------------

describe('OpencodeExecRunner non-zero exit result event (D6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_opencode_non_zero_exit_emits_error_result', async () => {
    // Emit a terminal step_finish so the translator is terminal, then close
    // with non-zero code. buildResultEvent must still classify as error
    // because code !== 0 takes precedence over the terminal step's success.
    const stdout = new Readable({ read() {} });
    stdout.push(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_nz',
        part: {
          type: 'step-finish',
          reason: 'stop',
          tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }) + '\n',
    );
    stdout.push(null);

    const closeHolder: {
      cb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null;
    } = { cb: null };

    const mockProc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: { on: vi.fn(), destroy: vi.fn() } as any,
      stdin: { end: vi.fn() } as any,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHolder.cb = cb as (code: number | null, signal: NodeJS.Signals | null) => void;
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new OpencodeExecRunner({
      workspace: 'test',
      binary: 'opencode',
      sessionReader: {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => null,
        readSessionContent: () => ({ events: [] }),
        isSessionActive: () => false,
      },
    });

    const events: unknown[] = [];
    const runPromise = (async () => {
      for await (const event of runner.run('test prompt', { cwd: '/tmp' })) {
        events.push(event);
      }
    })();

    await new Promise((r) => setTimeout(r, 30));

    // Process exits with non-zero code (no user stop)
    closeHolder.cb?.(1, null);

    await runPromise;

    const resultEvents = events.filter((e) => (e as { type?: string }).type === 'result') as Array<{
      subtype?: string;
      errorMessage?: string;
    }>;

    expect(resultEvents.length).toBe(1);
    const resultEvent = resultEvents[0];
    expect(resultEvent.subtype).toBe('error');
    expect(resultEvent.errorMessage).toMatch(/exited code=1/i);
  });
});

// ---------------------------------------------------------------------------
// D7: signal kill → result subtype='error'
// ---------------------------------------------------------------------------

describe('OpencodeExecRunner signal kill result event (D7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_opencode_signal_kill_emits_error_result', async () => {
    // No events on stdout — stream ends early without a terminal step.
    // Then process closes with signal=SIGTERM (no user stop).
    // buildResultEvent must classify as error with signal info, NOT the
    // stream-ended-early symptom message.
    const stdout = new Readable({ read() {} });
    stdout.push(null);

    const closeHolder: {
      cb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null;
    } = { cb: null };

    const mockProc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: { on: vi.fn(), destroy: vi.fn() } as any,
      stdin: { end: vi.fn() } as any,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHolder.cb = cb as (code: number | null, signal: NodeJS.Signals | null) => void;
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new OpencodeExecRunner({
      workspace: 'test',
      binary: 'opencode',
      sessionReader: {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => null,
        readSessionContent: () => ({ events: [] }),
        isSessionActive: () => false,
      },
    });

    const events: unknown[] = [];
    const runPromise = (async () => {
      for await (const event of runner.run('test prompt', { cwd: '/tmp' })) {
        events.push(event);
      }
    })();

    await new Promise((r) => setTimeout(r, 30));

    // Process is killed by signal (no user stop, no exit code)
    closeHolder.cb?.(null, 'SIGTERM');

    await runPromise;

    const resultEvents = events.filter((e) => (e as { type?: string }).type === 'result') as Array<{
      subtype?: string;
      errorMessage?: string;
    }>;

    expect(resultEvents.length).toBe(1);
    const resultEvent = resultEvents[0];
    expect(resultEvent.subtype).toBe('error');
    // errorMessage should mention the signal, NOT the stream-ended-early symptom
    expect(resultEvent.errorMessage).toMatch(/SIGTERM|signal/i);
    expect(resultEvent.errorMessage).not.toMatch(/stream ended before a terminal/i);
  });
});

// ---------------------------------------------------------------------------
// D5: stoppedByUser → result subtype='error'
// ---------------------------------------------------------------------------

describe('OpencodeExecRunner stoppedByUser result event (D5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * D5: When user calls stop() during an opencode run, the result event MUST
   * be subtype='error'. The stoppedByUser flag drives subtype='error'.
   */
  it('test_anchor_opencode_stopped_by_user_emits_error_result', async () => {
    // Controllable stdout: emit nothing, then end on demand
    const stdout = new Readable({ read() {} });

    // Capture the 'close' callback so we can trigger it after stop().
    const closeHolder: {
      cb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null;
    } = { cb: null };

    const mockProc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdout,
      stderr: {
        on: vi.fn(),
        destroy: vi.fn(),
      } as any,
      stdin: {
        end: vi.fn(),
      } as any,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHolder.cb = cb as (code: number | null, signal: NodeJS.Signals | null) => void;
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new OpencodeExecRunner({
      workspace: 'test',
      binary: 'opencode',
      sessionReader: {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => null,
        readSessionContent: () => ({ events: [] }),
        isSessionActive: () => false,
      },
    });

    const events: unknown[] = [];
    const runPromise = (async () => {
      for await (const event of runner.run('test prompt', { cwd: '/tmp' })) {
        events.push(event);
      }
    })();

    // Wait for run() to set currentProcess
    await new Promise((r) => setTimeout(r, 30));

    // User initiates stop — base class stop() sets stoppedByUser=true because
    // currentProcess is a live proc (exitCode/signalCode both null).
    await runner.stop();

    // End stdout stream → readline for-await exits
    stdout.push(null);

    // Trigger proc 'close' with signal kill (as if SIGTERM from stop() killed it)
    closeHolder.cb?.(null, 'SIGTERM');

    await runPromise;

    const resultEvents = events.filter((e) => (e as { type?: string }).type === 'result') as Array<{
      subtype?: string;
      errorMessage?: string;
    }>;

    expect(resultEvents.length).toBe(1);
    const resultEvent = resultEvents[0];
    // RED today: translator.finish('interrupted') returns subtype='success'
    // GREEN after D5: buildResultEvent checks stoppedByUser → subtype='error'
    expect(resultEvent.subtype).toBe('error');
    // errorMessage should mention user interruption (not signal kill, because
    // stoppedByUser takes precedence in buildResultEvent's branch order)
    expect(resultEvent.errorMessage).toMatch(/interrupted by user/i);
  });
});

// ---------------------------------------------------------------------------
// R20: OpencodeExecRunner extends SpawningRunner
// ---------------------------------------------------------------------------

const { SpawningRunner } = await import('../../../src/runner/common/spawning-runner.js');

const PID_DIR = '/tmp/r20-opencode-base-test';

describe('OpencodeExecRunner SpawningRunner base anchor', () => {
  afterEach(() => {
    // Defensive: OpencodeExecRunner constructor does not write the pid
    // file, but if a future change does, we don't want to leak state across
    // runs.
    try {
      fs.rmSync(PID_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('test_anchor_opencode_runner_extends_spawning_runner', () => {
    const runner = new OpencodeExecRunner({
      workspace: 'test',
      sessionReader: {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => null,
        readSessionContent: () => ({ events: [] }),
        isSessionActive: () => false,
      },
    });

    // Core contract: OpencodeExecRunner IS-A SpawningRunner. Today this is
    // RED because OpencodeExecRunner `implements AgentRunner` and does not
    // extend SpawningRunner — spawn orchestration is duplicated, not
    // inherited.
    expect(runner).toBeInstanceOf(SpawningRunner);

    // Inherited public methods must exist on the instance.
    expect(typeof runner.run).toBe('function');
    expect(typeof runner.stop).toBe('function');
    expect(typeof runner.killOrphan).toBe('function');

    // Inherited getter: a fresh instance with no spawned process must
    // report not-running. Verifies the base-class getter is wired through.
    expect(runner.isRunning).toBe(false);
  });
});
