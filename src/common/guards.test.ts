import { describe, it, expect } from 'vitest';
import { isRecord, stringValue } from './guards.js';

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
