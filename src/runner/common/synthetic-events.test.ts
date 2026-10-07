import { describe, it, expect } from 'vitest';
import { setupErrorEvent } from './synthetic-events.js';

describe('setupErrorEvent', () => {
  it('returns correct event structure with message only', () => {
    const event = setupErrorEvent('not logged in');
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
    const event = setupErrorEvent('auth failed', 'sess-123');
    expect(event).toEqual({
      type: 'result',
      subtype: 'error',
      session_id: 'sess-123',
      errorMessage: 'auth failed',
      timestamp: expect.any(String),
    });
  });
});
