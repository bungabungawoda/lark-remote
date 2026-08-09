/**
 * Anchor Test: KimiRunner spawn 失败处理正确性
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KimiRunner } from '../../../src/runner/kimi/index.js';

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
}));

import { spawn } from 'node:child_process';

describe('KimiRunner spawn failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_kimi_run_completes_quickly_on_spawn_failure', async () => {
    // Make spawn return a process that immediately errors
    const mockProc = {
      pid: undefined, // Simulate spawn failure
      exitCode: null,
      signalCode: null,
      stdout: null,
      stderr: { on: vi.fn(), destroy: vi.fn() },
      kill: vi.fn(),
      once: vi.fn((_event: string, cb: (...args: unknown[]) => void) => {
        // Immediately call error handler
        setTimeout(() => cb(new Error('spawn failed')), 0);
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const runner = new KimiRunner({ workspace: 'test' });
    const startTime = Date.now();

    // This should complete quickly (not hang) even on spawn failure
    const events: any[] = [];
    for await (const event of runner.run('test', { cwd: '/tmp' })) {
      events.push(event);
    }

    const elapsed = Date.now() - startTime;

    // Should complete within reasonable time (not hang)
    // This test verifies no memory leak or infinite wait
    expect(elapsed).toBeLessThan(3000);

    // Should have events (error event should be yielded)
    expect(events.length).toBeGreaterThan(0);
  });
});
