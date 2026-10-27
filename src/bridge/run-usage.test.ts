import { describe, expect, it } from 'vitest';
import { RunUsageCollector } from './run-usage.js';

describe('RunUsageCollector.finalize', () => {
  it('carries every jsonl usage field through to meta()', () => {
    const usage = new RunUsageCollector();

    usage.finalize(
      {
        inputTokens: 10,
        outputTokens: 20,
        contextLength: 30,
        contextLimit: 100,
        compactCount: 2,
        compactPreContextLength: 90,
        cacheReadTokens: 4,
        cacheCreationTokens: 5,
        totalTokens: 39,
        cumulativeInputTokens: 100,
        cumulativeOutputTokens: 200,
        cumulativeCacheReadTokens: 40,
        cumulativeCacheCreationTokens: 50,
        cumulativeTotalTokens: 390,
      },
      'jsonl',
    );

    expect(usage.meta()).toMatchObject({
      compactPreContextLength: 90,
      cumulativeTotalTokens: 390,
    });
  });

  it('keeps live flow scope while carrying non-flow jsonl fields', () => {
    const usage = new RunUsageCollector();
    usage.observeResult({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_read_tokens: 33,
        cache_creation_tokens: 44,
        total_tokens: 110,
      },
    });

    usage.finalize(
      {
        inputTokens: 1_000,
        outputTokens: 2_000,
        contextLength: 3_000,
        compactPreContextLength: 2_900,
      },
      'live',
    );

    expect(usage.meta()).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreationTokens: 44,
      totalTokens: 110,
      compactPreContextLength: 2_900,
    });
  });
});
