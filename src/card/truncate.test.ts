import { describe, it, expect } from 'vitest';
import { truncate } from './card-shared.js';

describe('truncate', () => {
  it('returns string unchanged if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and adds ellipsis within budget', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    // 8 chars total: "hello w…" (7 + 1 char ellipsis)
  });

  it('uses custom suffix when provided', () => {
    expect(truncate('hello world', 10, { suffix: '...' })).toBe('hello w...');
    // 10 chars total: 7 + 3 suffix
  });

  it('normalizes whitespace when option enabled', () => {
    expect(truncate('hello   world', 10, { normalizeWhitespace: true })).toBe('hello wor…');
  });

  it('recap pattern: 200 char limit with ... suffix', () => {
    const long = 'a'.repeat(250);
    const result = truncate(long, 200, { suffix: '...' });
    expect(result.length).toBe(200);
    expect(result.endsWith('...')).toBe(true);
  });
});
