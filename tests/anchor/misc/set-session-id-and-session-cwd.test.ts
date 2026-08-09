import { describe, it, expect } from 'vitest';
import { SessionStore } from '../../../src/session/session-store.js';

describe('setSessionIdAndSessionCwd', () => {
  it('should set sessionCwds without modifying cwd', () => {
    const store = new SessionStore();
    const userId = 'test_user';
    const agent = 'claude';
    const sessionId = 'sess-1';
    const sessionCwd = '/Users/test/worktree';
    const initialCwd = '/Users/test/main';

    // Set initial cwd via setCwd
    store.setCwd(userId, initialCwd);
    // setSessionIdAndCwd to set cwd + sessionId
    store.setSessionIdAndCwd(userId, agent, 'old-sess', initialCwd);
    expect(store.getCwd(userId)).toBe(initialCwd);

    // Now set sessionCwd via new method
    store.setSessionIdAndSessionCwd(userId, agent, sessionId, sessionCwd);

    // cwd must remain unchanged
    expect(store.getCwd(userId)).toBe(initialCwd);
    // sessionCwd must be set
    expect(store.getSessionCwd(userId, agent)).toBe(sessionCwd);
    // sessionId must be updated
    expect(store.getSessionId(userId, agent)).toBe(sessionId);
  });
});
