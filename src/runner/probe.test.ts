import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentKind } from './types.js';
import {
  probeAgentAvailability,
  probeAllAgents,
  getCachedAvailability,
  _clearCacheForTest,
} from './probe.js';

// Mock child_process.spawn to avoid spawning real processes
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';

const mockSpawn = vi.mocked(spawn);

/** Helper: create a mock ChildProcess that emits 'exit' with the given code. */
function makeMockProc(exitCode: number | null, signal: string | null = null) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(handler);
      // Auto-fire exit on next tick
      if (event === 'exit') {
        process.nextTick(() => handler(exitCode, signal));
      }
      return this;
    },
    kill: vi.fn(),
    unref: vi.fn(),
    _listeners: listeners,
  };
}

/** Helper: create a mock ChildProcess that emits 'error' (e.g. ENOENT). */
function makeErrorProc(error: Error) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(handler);
      if (event === 'error') {
        process.nextTick(() => handler(error));
      }
      return this;
    },
    kill: vi.fn(),
    unref: vi.fn(),
    _listeners: listeners,
  };
}

/** Helper: create a mock ChildProcess that never fires exit/error (simulates hang). */
function makeHangingProc() {
  return {
    on(_event: string, _handler: (...args: unknown[]) => void) {
      // Never fires any event — simulates a process that hangs
      return this;
    },
    kill: vi.fn(),
    unref: vi.fn(),
  };
}

describe('probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearCacheForTest();
  });

  describe('probeAgentAvailability', () => {
    it('returns true when binary --help exits with code 0', async () => {
      mockSpawn.mockReturnValue(makeMockProc(0) as never);
      const result = await probeAgentAvailability('claude');
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith('claude', ['--help'], { stdio: 'ignore' });
    });

    it('returns false when binary --help exits with non-zero code', async () => {
      mockSpawn.mockReturnValue(makeMockProc(1) as never);
      const result = await probeAgentAvailability('codex');
      expect(result).toBe(false);
    });

    it('returns false when spawn emits error (e.g. ENOENT)', async () => {
      mockSpawn.mockReturnValue(makeErrorProc(new Error('ENOENT')) as never);
      const result = await probeAgentAvailability('pi');
      expect(result).toBe(false);
    });

    it('returns false and sends SIGTERM then SIGKILL on timeout', async () => {
      vi.useFakeTimers();
      const mockProc = makeHangingProc();
      mockSpawn.mockReturnValue(mockProc as never);

      const promise = probeAgentAvailability('kimi');

      // Advance past the probe timeout (10 s) — should fire SIGTERM and resolve false
      await vi.advanceTimersByTimeAsync(11_000);

      const result = await promise;
      expect(result).toBe(false);
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past the SIGKILL fallback delay
      await vi.advanceTimersByTimeAsync(600);
      expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });

    it('calls unref on process and timer to avoid blocking exit', async () => {
      mockSpawn.mockReturnValue(makeMockProc(0) as never);
      const promise = probeAgentAvailability('claude');
      const result = await promise;
      expect(result).toBe(true);
      // unref should be called on the process
      const mockProc = mockSpawn.mock.results[0]?.value as { unref?: () => void };
      expect(mockProc.unref).toHaveBeenCalled();
    });

    it('caches result and does not re-probe within TTL', async () => {
      mockSpawn.mockReturnValue(makeMockProc(0) as never);
      await probeAgentAvailability('opencode');
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const result = await probeAgentAvailability('opencode');
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('probeAllAgents', () => {
    it('probes all 5 agents sequentially', async () => {
      mockSpawn.mockReturnValue(makeMockProc(0) as never);
      const result = await probeAllAgents();
      expect(result.size).toBe(5);
      expect(result.get('claude')).toBe(true);
      expect(result.get('codex')).toBe(true);
      expect(result.get('opencode')).toBe(true);
      expect(result.get('pi')).toBe(true);
      expect(result.get('kimi')).toBe(true);
    });

    it('reports mixed availability correctly', async () => {
      // claude/opencode available, codex/pi/kimi unavailable
      mockSpawn.mockImplementation((binary: string) => {
        if (binary === 'claude' || binary === 'opencode') {
          return makeMockProc(0) as never;
        }
        return makeMockProc(1) as never;
      });
      const result = await probeAllAgents();
      expect(result.get('claude')).toBe(true);
      expect(result.get('codex')).toBe(false);
      expect(result.get('opencode')).toBe(true);
      expect(result.get('pi')).toBe(false);
      expect(result.get('kimi')).toBe(false);
    });
  });

  describe('getCachedAvailability + _clearCacheForTest', () => {
    it('returns undefined when cache is empty', () => {
      expect(getCachedAvailability('claude')).toBeUndefined();
    });

    it('returns cached boolean after probe', async () => {
      mockSpawn.mockReturnValue(makeMockProc(0) as never);
      await probeAgentAvailability('claude');
      expect(getCachedAvailability('claude')).toBe(true);
    });

    it('returns undefined after cache is cleared', async () => {
      mockSpawn.mockReturnValue(makeMockProc(0) as never);
      await probeAgentAvailability('claude');
      expect(getCachedAvailability('claude')).toBe(true);
      _clearCacheForTest();
      expect(getCachedAvailability('claude')).toBeUndefined();
    });

    it('clears all cache entries', async () => {
      mockSpawn.mockReturnValue(makeMockProc(0) as never);
      await probeAllAgents();
      for (const kind of ['claude', 'codex', 'opencode', 'pi', 'kimi']) {
        expect(getCachedAvailability(kind as AgentKind)).toBe(true);
      }
      _clearCacheForTest();
      for (const kind of ['claude', 'codex', 'opencode', 'pi', 'kimi']) {
        expect(getCachedAvailability(kind as AgentKind)).toBeUndefined();
      }
    });
  });
});
