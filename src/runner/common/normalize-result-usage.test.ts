import { describe, it, expect } from 'vitest';
import { normalizeResultUsage } from './usage.js';

/** Mirror of ResultEvent['usage'] for red-phase independence. */
type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_tokens?: number;
};

/** Expected return shape (local mirror; type is internal to usage.ts). */
interface NormalizedResultUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  contextLength: number;
}

describe('normalizeResultUsage', () => {
  it('1. canonical field names', () => {
    const result: NormalizedResultUsage = normalizeResultUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_creation_tokens: 3,
    } as TokenUsage);
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
    expect(result.cacheReadTokens).toBe(5);
    expect(result.cacheCreationTokens).toBe(3);
    // no total_tokens → contextLength = 10 + 5 + 3 + 20 = 38
    expect(result.contextLength).toBe(38);
  });

  it('2. Anthropic native naming', () => {
    const result: NormalizedResultUsage = normalizeResultUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
    } as TokenUsage);
    expect(result.cacheReadTokens).toBe(5);
    expect(result.cacheCreationTokens).toBe(3);
    expect(result.contextLength).toBe(38);
  });

  it('3. canonical name takes priority when both are present', () => {
    const result: NormalizedResultUsage = normalizeResultUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 7,
      cache_read_input_tokens: 5,
      cache_creation_tokens: 4,
      cache_creation_input_tokens: 2,
    } as TokenUsage);
    expect(result.cacheReadTokens).toBe(7);
    expect(result.cacheCreationTokens).toBe(4);
  });

  it('4. no cache fields → undefined cache tokens, contextLength = input + output', () => {
    const result: NormalizedResultUsage = normalizeResultUsage({
      input_tokens: 10,
      output_tokens: 20,
    } as TokenUsage);
    expect(result.cacheReadTokens).toBeUndefined();
    expect(result.cacheCreationTokens).toBeUndefined();
    // contextLength = 10 + 0 + 0 + 20 = 30
    expect(result.contextLength).toBe(30);
  });

  it('5. total_tokens takes priority for contextLength', () => {
    const result: NormalizedResultUsage = normalizeResultUsage({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 999,
    } as TokenUsage);
    expect(result.contextLength).toBe(999);
  });
});
