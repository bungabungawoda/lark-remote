/**
 * Anchor Test: kimi-runner signal kill emits error result event
 *
 * P1#1 bug: When kimi process is killed by signal (code=null,
 * signal=SIGTERM), the result event MUST be subtype='error', not
 * 'success'. The current code has `const isError = code !== 0 &&
 * code !== null;` which returns false when code=null, misreporting
 * signal kills as success.
 *
 * After R23 green (refactor to use buildResultEvent from base class),
 * signal !== null will correctly classify as error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {} from 'node:url';

// Mock dependencies
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
const { KimiRunner } = await import('../../../src/runner/kimi/index.js');
const { spawn } = await import('node:child_process');

describe('KimiRunner signal kill result event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * P1#1 bug fix: When kimi process is killed by signal (code=null,
   * signal=SIGTERM), the result event MUST be subtype='error', not
   * 'success'. The current code has `const isError = code !== 0 &&
   * code !== null;` which returns false when code=null, misreporting
   * signal kills as success. This anchor pins the fix: signal kill →
   * error result event.
   */
  it('test_anchor_kimi_signal_kill_emits_error_not_success', async () => {
    const mockProc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdout: {
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') {
            setTimeout(() => cb(), 10);
          }
        }),
        once: vi.fn(),
        destroy: vi.fn(),
      } as any,
      stderr: {
        on: vi.fn(),
        destroy: vi.fn(),
      } as any,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          // Signal kill: code=null, signal=SIGTERM
          setTimeout(() => cb(null, 'SIGTERM'), 50);
        }
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new KimiRunner({ workspace: 'test', pidDir: '/tmp' });
    const events: any[] = [];
    for await (const event of runner.run('test prompt', { cwd: '/tmp' })) {
      events.push(event);
    }

    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBe(1);

    const resultEvent = resultEvents[0];
    // RED today: Kimi reports 'success' when code=null (signal kill)
    // because `isError = code !== 0 && code !== null` = `true && false` = false.
    // After R23 green (refactor to use buildResultEvent), signal !== null
    // will correctly classify as error.
    expect(resultEvent.subtype).toBe('error');
    // errorMessage should mention the signal
    expect(resultEvent.errorMessage).toBeDefined();
    expect(resultEvent.errorMessage).toMatch(/SIGTERM|signal/i);
  });
});
