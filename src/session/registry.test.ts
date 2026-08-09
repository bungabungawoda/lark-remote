import { describe, it, expect, vi } from 'vitest';
import { SessionReaderRegistry } from './registry.js';
import type { AgentSessionReader } from '../runner/index.js';

// Build a stub reader that returns canned data.
function stubReader(): AgentSessionReader {
  return {
    listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
    getNewestSession: vi.fn(() => null),
    readSessionContent: vi.fn(() => ({ events: [] })),
    isSessionActive: vi.fn(() => false),
  };
}

describe('SessionReaderRegistry', () => {
  it('register + get returns the reader', () => {
    const registry = new SessionReaderRegistry();
    const reader = stubReader();
    registry.register('claude', reader);
    expect(registry.get('claude')).toBe(reader);
  });

  it('get throws "session reader not registered" for unregistered kind', () => {
    const registry = new SessionReaderRegistry();
    expect(() => registry.get('codex')).toThrow(/session reader not registered: codex/);
  });
});
