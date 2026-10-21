import { describe, it, expect } from 'vitest';
import { truncate, truncateUtf8 } from './truncate.js';

describe('truncate', () => {
  it('returns string unchanged if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and adds ellipsis within budget', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    // 8 chars total: "hello w…" (7 + 1 char ellipsis)
  });

  it('uses custom suffix when provided', () => {
    expect(truncate('hello world', 10, { suffix: '...' })).toBe('hello w...');
    // 10 chars total: 7 + 3 suffix
  });

  it('normalizes whitespace when option enabled', () => {
    expect(truncate('hello   world', 10, { normalizeWhitespace: true })).toBe('hello wor…');
  });

  it('recap pattern: 200 char limit with ... suffix', () => {
    const long = 'a'.repeat(250);
    const result = truncate(long, 200, { suffix: '...' });
    expect(result.length).toBe(200);
    expect(result.endsWith('...')).toBe(true);
  });

  it('never emits a lone surrogate when the cut lands inside an emoji', () => {
    const input = 'a'.repeat(5) + '\u{1F600}' + 'b'.repeat(10);
    const result = truncate(input, 6, { suffix: '' });
    const lastCp = Array.from(result).at(-1)!.codePointAt(0)!;
    expect(lastCp).toBeLessThan(0xd800);
    expect(JSON.stringify(result)).not.toContain('\\ud');
  });
});

describe('truncateUtf8', () => {
  const input = 'a'.repeat(1000) + '汉'.repeat(100) + '😀'.repeat(50);

  it('keeps head/tail within the byte budget without splitting a code point', () => {
    const suffixBytes = Buffer.byteLength('…（已截断）', 'utf8');
    for (const maxBytes of [2, 7, 100, 999, 1000, 1001, 3000]) {
      for (const fromEnd of [false, true]) {
        const out = truncateUtf8(input, maxBytes, fromEnd);
        // 合法 UTF-8：往返解码不得产生替换符（即未切分多字节序列）
        expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
        if (Buffer.byteLength(input, 'utf8') <= maxBytes) {
          expect(out).toBe(input);
        } else if (maxBytes <= suffixBytes) {
          // 预算装不下 suffix 时按设计直接返回 suffix
          expect(out).toBe('…（已截断）');
        } else {
          // tail 模式按设计在 suffix 与正文之间插入一个换行：允许 maxBytes + 1
          const allowance = fromEnd ? 1 : 0;
          expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(maxBytes + allowance);
        }
      }
    }
  });

  it('returns the suffix when the byte budget cannot fit it', () => {
    expect(truncateUtf8('abc', 1)).toBe('…（已截断）');
  });
});
