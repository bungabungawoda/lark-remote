import { describe, it, expect } from 'vitest';
import { formatUpdateHint } from './startup-hint.js';

describe('startupUpdateHint', () => {
  it('returns hint text when newer version is available', () => {
    expect(formatUpdateHint('0.1.0', '0.2.0')).toContain('0.2.0');
    expect(formatUpdateHint('0.1.0', '0.2.0')).toContain('/update');
  });

  it('returns null when already up to date', () => {
    expect(formatUpdateHint('0.2.0', '0.2.0')).toBeNull();
    expect(formatUpdateHint('0.3.0', '0.2.0')).toBeNull();
  });
});
