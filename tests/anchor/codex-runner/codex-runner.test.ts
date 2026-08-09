/**
 * Merged anchor tests for CodexExecRunner
 *
 * Source files (merged 2026-08-04, Phase 4):
 *   - codex-runner-non-zero-exit-result.test.ts
 *   - codex-runner-signal-kill-result.test.ts
 *   - codex-runner-stopped-by-user-result.test.ts
 *   - codex-runner-spawning-base.test.ts
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
const { CodexExecRunner } = await import('../../../src/runner/codex/index.js');
const { spawn } = await import('node:child_process');

// ---------------------------------------------------------------------------
// D2: non-zero exit code → result subtype='error'
// ---------------------------------------------------------------------------

describe('CodexExecRunner non-zero exit result event (D2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * D2: When the codex process exits with code=1 (non-zero), the result event
   * MUST be subtype='error'. After D1's refactor, buildResultEvent checks
   * `code !== 0 && code !== null` → error.
   */
  it('test_anchor_codex_non_zero_exit_emits_error_result', async () => {
    // Controllable stdout: emit a turn.completed line, then end
    const stdout = new Readable({ read() {} });

    // Capture the 'close' callback so we can trigger it with code=1
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

    const runner = new CodexExecRunner({
      workspace: 'test',
      binary: 'codex',
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

    // Wait for run() to set currentProcess and start reading stdout
    await new Promise((r) => setTimeout(r, 30));

    // Push a turn.completed line (translator marks terminal, stashes usage, returns [])
    stdout.push(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }) +
        '\n',
    );

    // End stdout stream → readline for-await exits
    stdout.push(null);

    // Wait a tick for readline to flush
    await new Promise((r) => setTimeout(r, 10));

    // Trigger proc 'close' with non-zero exit code
    closeHolder.cb?.(1, null);

    await runPromise;

    const resultEvents = events.filter((e) => (e as { type?: string }).type === 'result') as Array<{
      subtype?: string;
      errorMessage?: string;
    }>;

    expect(resultEvents.length).toBe(1);
    const resultEvent = resultEvents[0];
    // After D1 GREEN: buildResultEvent checks code !== 0 → subtype='error'
    expect(resultEvent.subtype).toBe('error');
    // errorMessage should mention the exit code
    expect(resultEvent.errorMessage).toMatch(/exited code=1/i);
  });
});

// ---------------------------------------------------------------------------
// D3: signal kill → result subtype='error'
// ---------------------------------------------------------------------------

describe('CodexExecRunner signal kill result event (D3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * D3: When the codex process is killed by signal (code=null, signal=SIGTERM)
   * without user-initiated stop(), the result event MUST be subtype='error'.
   * After D1's refactor, buildResultEvent checks `signal !== null` → error.
   */
  it('test_anchor_codex_signal_kill_emits_error_result', async () => {
    // Controllable stdout: emit nothing, then end on demand
    const stdout = new Readable({ read() {} });

    // Capture the 'close' callback so we can trigger it with signal kill
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

    const runner = new CodexExecRunner({
      workspace: 'test',
      binary: 'codex',
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

    // End stdout stream → readline for-await exits (no events emitted)
    stdout.push(null);

    // Wait a tick for readline to flush
    await new Promise((r) => setTimeout(r, 10));

    // Trigger proc 'close' with signal kill (code=null, signal=SIGTERM)
    // Do NOT call runner.stop() — this is an external signal kill, not user-initiated.
    closeHolder.cb?.(null, 'SIGTERM');

    await runPromise;

    const resultEvents = events.filter((e) => (e as { type?: string }).type === 'result') as Array<{
      subtype?: string;
      errorMessage?: string;
    }>;

    expect(resultEvents.length).toBe(1);
    const resultEvent = resultEvents[0];
    // After D1 GREEN: buildResultEvent checks signal !== null → subtype='error'
    expect(resultEvent.subtype).toBe('error');
    // errorMessage should mention the signal name
    expect(resultEvent.errorMessage).toMatch(/SIGTERM|signal/i);
  });
});

// ---------------------------------------------------------------------------
// stoppedByUser → result subtype='error'
// ---------------------------------------------------------------------------

describe('CodexExecRunner stoppedByUser result event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * When user calls stop() during a codex run, the result event MUST be
   * subtype='error'. The stoppedByUser flag drives subtype='error' via
   * buildResultEvent.
   */
  it('test_anchor_codex_stopped_by_user_emits_error_result', async () => {
    // Controllable stdout: emit nothing, then end on demand
    const stdout = new Readable({ read() {} });

    // Capture the 'close' callback so we can trigger it after stop().
    // Use a holder object so TS doesn't narrow to `never` via control-flow
    // (assignment happens inside a vi.fn callback TS doesn't track).
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

    const runner = new CodexExecRunner({
      workspace: 'test',
      binary: 'codex',
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

    // Wait for run() to set currentProcess (spawn + stdin.write + readline
    // setup all synchronous before for-await suspends on first line).
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
    // buildResultEvent checks stoppedByUser → subtype='error'
    expect(resultEvent.subtype).toBe('error');
    // errorMessage should mention user interruption (not signal kill, because
    // stoppedByUser takes precedence in buildResultEvent's branch order)
    expect(resultEvent.errorMessage).toMatch(/interrupted by user/i);
  });
});

// ---------------------------------------------------------------------------
// R19: CodexExecRunner extends SpawningRunner
// ---------------------------------------------------------------------------

const { SpawningRunner } = await import('../../../src/runner/common/spawning-runner.js');

const PID_DIR = '/tmp/r19-codex-base-test';

describe('CodexExecRunner SpawningRunner base anchor', () => {
  afterEach(() => {
    // Defensive: CodexExecRunner constructor does not write the pid file,
    // but if a future change does, we don't want to leak state across runs.
    try {
      fs.rmSync(PID_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('test_anchor_codex_runner_extends_spawning_runner', () => {
    const runner = new CodexExecRunner({
      workspace: 'test',
      sessionReader: {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => null,
        readSessionContent: () => ({ events: [] }),
        isSessionActive: () => false,
      },
    });

    // Core contract: CodexExecRunner IS-A SpawningRunner. Today this is RED
    // because CodexExecRunner `implements AgentRunner` and does not extend
    // SpawningRunner — spawn orchestration is duplicated, not inherited.
    expect(runner).toBeInstanceOf(SpawningRunner);

    // Inherited public methods must exist on the instance. These would
    // resolve via the prototype chain once CodexExecRunner extends the base.
    expect(typeof runner.run).toBe('function');
    expect(typeof runner.stop).toBe('function');
    expect(typeof runner.killOrphan).toBe('function');

    // Inherited getter: a fresh instance with no spawned process must
    // report not-running. Verifies the base-class getter is wired through.
    expect(runner.isRunning).toBe(false);
  });
});
