import { describe, it, expect } from 'vitest';
import { isRecord, recordValue, stringValue, numberValue, extractErrorMessage } from './guards.js';

describe('isRecord', () => {
  it('returns true for plain object', () => {
    expect(isRecord({})).toBe(true);
  });

  it('returns true for array (arrays are objects)', () => {
    expect(isRecord([])).toBe(true);
  });

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRecord(undefined)).toBe(false);
  });

  it('returns false for string', () => {
    expect(isRecord('str')).toBe(false);
  });

  it('returns false for number', () => {
    expect(isRecord(42)).toBe(false);
  });
});

describe('recordValue', () => {
  it('returns the object itself when isRecord is true', () => {
    expect(recordValue({ a: 1 })).toEqual({ a: 1 });
  });

  it('returns undefined for string', () => {
    expect(recordValue('x')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(recordValue(null)).toBeUndefined();
  });
});

describe('stringValue', () => {
  it('returns the string when value is a string', () => {
    expect(stringValue('hi')).toBe('hi');
  });

  it('returns empty string for empty string input', () => {
    expect(stringValue('')).toBe('');
  });

  it('returns undefined for number', () => {
    expect(stringValue(1)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(stringValue(null)).toBeUndefined();
  });
});

describe('numberValue', () => {
  it('returns the number when value is a number', () => {
    expect(numberValue(3.5)).toBe(3.5);
  });

  it('returns 0 when value is 0', () => {
    expect(numberValue(0)).toBe(0);
  });

  it('returns undefined for string', () => {
    expect(numberValue('3')).toBeUndefined();
  });
});

describe('extractErrorMessage', () => {
  it('extracts from raw.message first', () => {
    expect(extractErrorMessage({ message: 'm1' }, 'fb')).toBe('m1');
  });

  it('falls back to raw.error.message', () => {
    expect(extractErrorMessage({ error: { message: 'm2' } }, 'fb')).toBe('m2');
  });

  it('falls back to raw.error as string', () => {
    expect(extractErrorMessage({ error: 'm3' }, 'fb')).toBe('m3');
  });

  it('returns fallback when nothing matches', () => {
    expect(extractErrorMessage({}, 'fb')).toBe('fb');
  });

  it('prefers raw.message over raw.error.message', () => {
    expect(extractErrorMessage({ message: 'a', error: { message: 'b' } }, 'fb')).toBe('a');
  });

  it('falls back to raw.error.data.message (AI SDK provider error)', () => {
    expect(extractErrorMessage({ error: { data: { message: 'provider-error' } } }, 'fb')).toBe(
      'provider-error',
    );
  });

  it('prefers raw.error.message over raw.error.data.message', () => {
    expect(
      extractErrorMessage({ error: { message: 'direct', data: { message: 'nested' } } }, 'fb'),
    ).toBe('direct');
  });

  it('skips raw.error.data.message when data has no string message', () => {
    expect(extractErrorMessage({ error: { data: { code: 123 } } }, 'fb')).toBe('fb');
  });
});
