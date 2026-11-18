import { describe, expect, it } from 'vitest';

describe('resume time formatting', () => {
  it('marks future session mtimes as clock anomalies', async () => {
    const { formatRelativeTime } = await import('./resume.js');
    const text = formatRelativeTime(Date.now() + 120_000, Date.now());
    expect(text).toContain('时间异常');
  });
});
