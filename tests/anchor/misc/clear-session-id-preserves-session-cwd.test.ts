import { describe, it, expect } from 'vitest';
import { SessionStore } from '../../../src/session/session-store.js';

describe('clearSessionId parking semantics', () => {
  it('should preserve sessionCwds when clearSessionId is called without clearSessionCwd flag', () => {
    const store = new SessionStore();
    const userId = 'test_user';
    const agent = 'claude';
    const sessionCwd = '/Users/test/worktree';

    // Set up: cwd + sessionId + sessionCwd
    store.setCwd(userId, '/Users/test/main');
    store.setSessionIdAndSessionCwd(userId, agent, 'sess-1', sessionCwd);
    expect(store.getSessionCwd(userId, agent)).toBe(sessionCwd);

    // clearSessionId without flag (parking semantics) — must preserve sessionCwds
    store.clearSessionId(userId, agent);

    // sessionId should be cleared
    expect(store.getSessionId(userId, agent)).toBeUndefined();
    // sessionCwd should be preserved (parking)
    expect(store.getSessionCwd(userId, agent)).toBe(sessionCwd);
    // cwd unchanged
    expect(store.getCwd(userId)).toBe('/Users/test/main');
  });
});
