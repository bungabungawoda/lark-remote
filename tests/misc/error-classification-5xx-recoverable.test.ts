import { describe, expect, it } from 'vitest';
import { classifyRejection } from '../../src/error-classification.js';

describe('classifyRejection: 5xx should be recoverable', () => {
  it('treats HTTP 500 as recoverable', () => {
    expect(classifyRejection({ response: { status: 500 } })).toBe('recoverable');
  });

  it('treats HTTP 502/503/504 as recoverable', () => {
    expect(classifyRejection({ response: { status: 502 } })).toBe('recoverable');
    expect(classifyRejection({ response: { status: 503 } })).toBe('recoverable');
    expect(classifyRejection({ response: { status: 504 } })).toBe('recoverable');
  });

  it('treats HTTP 500 with feishu business code as recoverable', () => {
    const err = {
      response: {
        status: 500,
        data: { code: 500001, msg: 'internal server error' },
      },
    };
    expect(classifyRejection(err)).toBe('recoverable');
  });
});
