import { describe, expect, it } from 'vitest';
import { unattendedMessage } from './unattended.js';

describe('unattendedMessage', () => {
  it('preserves interactive requests and slash commands', () => {
    expect(unattendedMessage('hello')).toBe('hello');
    expect(unattendedMessage('/compact', true)).toBe('/compact');
  });

  it('requests verification and checkpointing without inventing authorization', () => {
    const message = unattendedMessage('Finish the tests', true);
    expect(message).toContain('Finish the tests');
    expect(message).toContain('verification');
    expect(message).toContain('checkpoint');
    expect(message).toContain('missing\nauthorization is not consent');
  });
});
