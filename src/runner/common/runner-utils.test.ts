import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { pipeAllStdio, endStdinWithPrompt, authErrorEvent } from './runner-utils.js';

function makeMockChild(overrides: { endError?: Error } = {}) {
  return {
    stdin: {
      end: vi.fn((_msg: string, _enc: string, _cb?: () => void) => {
        if (overrides.endError) throw overrides.endError;
      }),
    },
  } as unknown as ChildProcess;
}

describe('pipeAllStdio', () => {
  it('returns ["pipe", "pipe", "pipe"]', () => {
    expect(pipeAllStdio()).toEqual(['pipe', 'pipe', 'pipe']);
  });
});

describe('endStdinWithPrompt', () => {
  it('succeeds normally when stdin.end does not throw', () => {
    const proc = makeMockChild();
    expect(() => endStdinWithPrompt(proc, 'hello')).not.toThrow();
    expect(proc.stdin!.end).toHaveBeenCalledWith('hello', 'utf-8');
  });

  it('catches EPIPE error silently', () => {
    const epipeErr = new Error('broken pipe') as NodeJS.ErrnoException;
    epipeErr.code = 'EPIPE';
    const proc = makeMockChild({ endError: epipeErr });

    expect(() => endStdinWithPrompt(proc, 'hello')).not.toThrow();
    expect(proc.stdin!.end).toHaveBeenCalledWith('hello', 'utf-8');
  });

  it('rethrows non-EPIPE error', () => {
    const genericErr = new Error('something else');
    const proc = makeMockChild({ endError: genericErr });

    expect(() => endStdinWithPrompt(proc, 'hello')).toThrow(genericErr);
    expect(proc.stdin!.end).toHaveBeenCalledWith('hello', 'utf-8');
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
