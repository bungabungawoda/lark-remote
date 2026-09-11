import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentKind } from './types.js';
import {
  probeAgentAvailability,
  probeAllAgents,
  getCachedAvailability,
  _clearCacheForTest,
} from './probe.js';

// 探测已收进 platform seam（纯 Node PATH 查找，无子进程）：
// 这里 mock resolveExecutable 断言 probe 层的映射、缓存与 dsh 短路语义
vi.mock('../platform/command.js', () => ({
  resolveExecutable: vi.fn(),
}));

import { resolveExecutable } from '../platform/command.js';

const mockProbe = vi.mocked(resolveExecutable);

describe('probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProbe.mockReset();
    _clearCacheForTest();
  });

  describe('probeAgentAvailability', () => {
    it.each([
      ['claude', '/usr/bin/mock-bin', true],
      ['codex', null, false],
    ] as const)(
      '%s availability follows seam resolution (%s)',
      async (kind, resolved, expected) => {
        mockProbe.mockReturnValue(resolved);
        const result = await probeAgentAvailability(kind);
        expect(result).toBe(expected);
        expect(mockProbe).toHaveBeenCalledWith(kind);
      },
    );

    it('reports dsh unavailable without touching the seam (no CLI binary)', async () => {
      const result = await probeAgentAvailability('dsh');
      expect(result).toBe(false);
      expect(mockProbe).not.toHaveBeenCalled();
    });

    it('caches result and does not re-probe within TTL', async () => {
      mockProbe.mockReturnValue('/usr/bin/mock-bin');
      await probeAgentAvailability('opencode');
      expect(mockProbe).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const result = await probeAgentAvailability('opencode');
      expect(result).toBe(true);
      expect(mockProbe).toHaveBeenCalledTimes(1);
    });
  });

  describe('probeAllAgents', () => {
    it('probes all 5 spawn-able agents concurrently', async () => {
      mockProbe.mockReturnValue('/usr/bin/mock-bin');
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
      mockProbe.mockImplementation((name: string) =>
        name === 'claude' || name === 'opencode' ? '/usr/bin/mock-bin' : null,
      );
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

    it('returns cached boolean after probe; undefined after cache is cleared', async () => {
      mockProbe.mockReturnValue('/usr/bin/mock-bin');
      await probeAgentAvailability('claude');
      expect(getCachedAvailability('claude')).toBe(true);
      _clearCacheForTest();
      expect(getCachedAvailability('claude')).toBeUndefined();
    });

    it('clears all cache entries', async () => {
      mockProbe.mockReturnValue('/usr/bin/mock-bin');
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
