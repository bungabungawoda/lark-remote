import { describe, expect, it } from 'vitest';
import {
  describePromptError,
  upstreamPromptError,
  isAuthenticationFailure,
  isPromptAuthenticationFailure,
} from './prompt-error.js';

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

/**
 * 身份失效信号：误判会清掉用户的会话与模型目录，所以判定必须保守。
 * 文本均为脱敏合成（不含真 token / 真代理地址）。
 */
describe('isAuthenticationFailure', () => {
  it('认上游 401 认证失败（真机形状的两种外壳）', () => {
    expect(
      isAuthenticationFailure(
        '401 Authentication required. Please use /login command to sign in to your account (auth-type:test,token-type:Bearer)',
      ),
    ).toBe(true);
    expect(isAuthenticationFailure('401 Unauthorized')).toBe(true);
  });

  it('不认 DSH 的裸 401、限流、以及正文里讨论 HTTP 401', () => {
    expect(isAuthenticationFailure('DSH HTTP 401 for session.create')).toBe(false);
    expect(isAuthenticationFailure('429 usage exceeds frequency limit')).toBe(false);
    expect(isAuthenticationFailure('HTTP 401 means the request lacks valid credentials')).toBe(
      false,
    );
    expect(isAuthenticationFailure('Agent 结束但未说明原因（stopReason: refusal）')).toBe(false);
    expect(isAuthenticationFailure(undefined)).toBe(false);
  });

  it('结构化 code/status 401 兜底：上游不给 message 时也能判', () => {
    expect(
      isPromptAuthenticationFailure({
        stopReason: 'refusal',
        _meta: { 'codebuddy.ai/errorMessage': '{"code":401}' },
      }),
    ).toBe(true);
    expect(
      isPromptAuthenticationFailure({
        stopReason: 'error',
        error: { code: 401 },
      }),
    ).toBe(true);
    expect(
      isPromptAuthenticationFailure({
        stopReason: 'refusal',
        _meta: { 'codebuddy.ai/errorMessage': '{"code":429,"message":"rate limited"}' },
      }),
    ).toBe(false);
    expect(isPromptAuthenticationFailure({ stopReason: 'refusal' })).toBe(false);
  });

  /**
   * 真机 2026-11-09 脱敏回放：独立 `codebuddy --acp` 进程未登录时，
   * session/prompt 以 stopReason:'refusal' 结算，_meta 里是 -32000 +
   * data.category:'auth'（既没有 401 文本，也没有 code:401）。
   */
  it('认上游 -32000 + category:auth 的未登录错误', () => {
    const live = {
      stopReason: 'refusal' as const,
      _meta: {
        'codebuddy.ai/errorMessage': JSON.stringify({
          code: -32000,
          message: 'Authentication required',
          data: {
            details:
              'Authentication required. Please use /login command to sign in to your account',
            category: 'auth',
          },
        }),
      },
    };
    expect(upstreamPromptError(live)).toBe('Authentication required');
    expect(describePromptError(live).text).toBe('Authentication required');
    expect(isPromptAuthenticationFailure(live)).toBe(true);
  });

  it('category:auth 但文本与认证无关时仍不误判', () => {
    expect(
      isPromptAuthenticationFailure({
        stopReason: 'refusal',
        _meta: {
          'codebuddy.ai/errorMessage': JSON.stringify({
            code: -32000,
            message: 'quota exhausted',
            data: { details: 'quota exhausted', category: 'auth' },
          }),
        },
      }),
    ).toBe(false);
  });

  it('同类 -32000 但 category 不是 auth 时不认', () => {
    expect(
      isPromptAuthenticationFailure({
        stopReason: 'refusal',
        _meta: {
          'codebuddy.ai/errorMessage': JSON.stringify({
            code: -32000,
            message: 'Authentication required',
            data: { details: 'rate limited', category: 'quota' },
          }),
        },
      }),
    ).toBe(false);
  });
});
