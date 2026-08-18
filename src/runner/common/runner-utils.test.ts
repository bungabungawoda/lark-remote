import { describe, it, expect } from 'vitest';
import { pipeAllStdio, authErrorEvent } from './runner-utils.js';

describe('pipeAllStdio', () => {
  it('returns ["pipe", "pipe", "pipe"]', () => {
    expect(pipeAllStdio()).toEqual(['pipe', 'pipe', 'pipe']);
  });
});

describe('authErrorEvent', () => {
  it('returns correct event structure with message only', () => {
    const event = authErrorEvent('not logged in');
    expect(event).toEqual({
      type: 'result',
      subtype: 'error',
      session_id: '',
      errorMessage: 'not logged in',
      timestamp: expect.any(String),
    });
    // Verify timestamp is a valid ISO string
    expect(new Date(event.timestamp!).toISOString()).toBe(event.timestamp);
  });

  it('includes sessionId when provided', () => {
    const event = authErrorEvent('auth failed', 'sess-123');
    expect(event).toEqual({
      type: 'result',
      subtype: 'error',
      session_id: 'sess-123',
      errorMessage: 'auth failed',
      timestamp: expect.any(String),
    });
  });
});
