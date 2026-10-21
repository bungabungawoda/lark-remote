import { describe, it, expect } from 'vitest';
import { pickMiddleValue, resetModelPatch } from './model-patch.js';

/**
 * 档位中位口径的单一来源。P0 收敛前三处 builder 各写一套公式，偶数长度在
 * `(len-1)/2` 与 `len/2` 之间漂移；这里直接钉住共享实现的两种 bias 语义，
 * 调用方（codex/kimi 用 lower，dsh 用 upper）只需选择口径。
 */
describe('pickMiddleValue', () => {
  it('returns undefined for an empty list', () => {
    expect(pickMiddleValue([])).toBeUndefined();
    expect(pickMiddleValue([], 'upper')).toBeUndefined();
  });

  it('returns the exact middle for odd-length lists regardless of bias', () => {
    expect(pickMiddleValue(['low', 'medium', 'high'])).toBe('medium');
    expect(pickMiddleValue(['low', 'medium', 'high'], 'upper')).toBe('medium');
    expect(pickMiddleValue(['off', 'low', 'medium', 'high', 'max'])).toBe('medium');
  });

  it('defaults to the lower middle for even-length lists', () => {
    // (len-1)/2 = 0 → off（codex / kimi 既有口径：偶数长度取偏低位）
    expect(pickMiddleValue(['off', 'low'])).toBe('off');
    expect(pickMiddleValue(['low', 'medium', 'high', 'xhigh'])).toBe('medium');
  });

  it('uses the upper middle when bias is "upper"', () => {
    // len/2 = 1 → low（dsh 口径：off/low 取 low）
    expect(pickMiddleValue(['off', 'low'], 'upper')).toBe('low');
    expect(pickMiddleValue(['low', 'medium', 'high', 'xhigh'], 'upper')).toBe('high');
  });

  it('returns the only element for single-element lists', () => {
    expect(pickMiddleValue(['high'])).toBe('high');
    expect(pickMiddleValue(['high'], 'upper')).toBe('high');
  });

  it('preserves non-string element values', () => {
    expect(pickMiddleValue([{ level: 1 }, { level: 2 }, { level: 3 }])).toEqual({ level: 2 });
  });
});

describe('resetModelPatch', () => {
  const key = 'agents.codex.model';

  it('returns null when the current model is offered by the new provider', () => {
    expect(resetModelPatch(key, 'gpt-5', ['gpt-5', 'gpt-5-mini'])).toBeNull();
  });

  it('resets to the first offered model when the current model is unsupported', () => {
    expect(resetModelPatch(key, 'old-model', ['gpt-5', 'gpt-5-mini'])).toEqual({
      key,
      value: 'gpt-5',
    });
  });

  it('returns null when the new provider has no models', () => {
    expect(resetModelPatch(key, 'old-model', [])).toBeNull();
  });

  it('treats an unset current model like an unsupported one', () => {
    expect(resetModelPatch(key, undefined, ['gpt-5'])).toEqual({ key, value: 'gpt-5' });
  });
});
