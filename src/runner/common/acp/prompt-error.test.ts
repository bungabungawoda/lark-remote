import { describe, expect, it } from 'vitest';
import { describePromptError, upstreamPromptError } from './prompt-error.js';

describe('prompt-error', () => {
  it('extracts the CodeBuddy _meta error JSON verbatim', () => {
    const detail = describePromptError({
      stopReason: 'refusal',
      _meta: {
        'codebuddy.ai/errorMessage': JSON.stringify({
          code: 6004,
          message: '429 usage exceeds frequency limit',
          data: { statusCode: 429 },
        }),
      },
    });
    expect(detail.upstream).toBe('429 usage exceeds frequency limit');
    expect(detail.text).toBe('429 usage exceeds frequency limit');
  });

  it('extracts a top-level ACP error variant', () => {
    const detail = describePromptError({
      stopReason: 'error',
      error: { code: 500, message: 'provider unavailable' },
    });
    expect(detail.text).toBe('provider unavailable');
  });

  it('accepts a plain-string errorMessage', () => {
    expect(upstreamPromptError({ stopReason: 'error', errorMessage: 'boom' })).toBe('boom');
  });

  it('falls back to data.details when the message is absent', () => {
    expect(
      upstreamPromptError({
        stopReason: 'refusal',
        _meta: { 'codebuddy.ai/errorMessage': '{"data":{"details":"quota exhausted"}}' },
      }),
    ).toBe('quota exhausted');
  });

  it('reports a bare code when the upstream only sends one', () => {
    expect(
      upstreamPromptError({
        stopReason: 'refusal',
        _meta: { 'codebuddy.ai/errorMessage': '{"code":6004}' },
      }),
    ).toBe('错误码 6004');
  });

  it('states only the stopReason when no upstream detail exists', () => {
    const detail = describePromptError({ stopReason: 'refusal' });
    expect(detail.upstream).toBeUndefined();
    expect(detail.text).toBe('Agent 结束但未说明原因（stopReason: refusal）');
    expect(detail.text).not.toContain('/compact');
  });

  it('keeps protocol-defined stopReasons self-explanatory', () => {
    expect(describePromptError({ stopReason: 'max_tokens' }).text).toBe(
      '输出达到模型 token 上限（stopReason: max_tokens）',
    );
    expect(describePromptError({ stopReason: 'max_turn_requests' }).text).toBe(
      '达到单轮请求次数上限（stopReason: max_turn_requests）',
    );
  });

  it('keeps the raw string when the meta value is malformed JSON', () => {
    expect(
      upstreamPromptError({
        stopReason: 'refusal',
        _meta: { 'codebuddy.ai/errorMessage': '{not json' },
      }),
    ).toBe('{not json');
  });
});
