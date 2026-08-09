import { describe, it, expect } from 'vitest';
import { countMarkdownTables, truncateMarkdownTables, FEISHU_MAX_TABLES } from './text-truncate.js';

describe('countMarkdownTables', () => {
  it('returns 0 for empty string', () => {
    expect(countMarkdownTables('')).toBe(0);
  });

  it('returns 0 for text with no tables', () => {
    expect(countMarkdownTables('hello world\nno tables here')).toBe(0);
  });

  it('counts a single markdown table', () => {
    const text = '| a | b |\n|---|---|\n| 1 | 2 |';
    expect(countMarkdownTables(text)).toBe(1);
  });

  it('counts multiple markdown tables', () => {
    const text = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Some text between',
      '',
      '| x | y |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n');
    expect(countMarkdownTables(text)).toBe(2);
  });

  it('counts 8 tables like the real review report', () => {
    const parts: string[] = [];
    for (let i = 0; i < 8; i++) {
      parts.push(`| # | col |`);
      parts.push(`|---|-----|`);
      parts.push(`| R${i + 1} | val${i} |`);
      if (i < 7) parts.push('');
    }
    const text = parts.join('\n');
    expect(countMarkdownTables(text)).toBe(8);
  });

  it('handles alignment colons in separator', () => {
    const text = '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |';
    expect(countMarkdownTables(text)).toBe(1);
  });
});

describe('truncateMarkdownTables', () => {
  it('returns text unchanged when table count ≤ maxTables', () => {
    const text = '| a | b |\n|---|---|\n| 1 | 2 |';
    expect(truncateMarkdownTables(text, 5)).toBe(text);
  });

  it('returns text unchanged when exactly at maxTables', () => {
    const parts: string[] = [];
    for (let i = 0; i < 5; i++) {
      parts.push(`| # | col |`);
      parts.push(`|---|-----|`);
      parts.push(`| R${i + 1} | val${i} |`);
      if (i < 4) parts.push('');
    }
    const text = parts.join('\n');
    expect(truncateMarkdownTables(text, 5)).toBe(text);
  });

  it('removes oldest tables keeping newest 5 by default', () => {
    const parts: string[] = [];
    for (let i = 0; i < 8; i++) {
      parts.push(`### Section ${i + 1}`);
      parts.push(`| # | col |`);
      parts.push(`|---|-----|`);
      parts.push(`| R${i + 1} | val${i} |`);
      if (i < 7) parts.push('');
    }
    const text = parts.join('\n');
    const result = truncateMarkdownTables(text);

    // Should still have 5 tables
    expect(countMarkdownTables(result)).toBe(5);

    // Should keep tables 4-8 (newest 5), remove tables 1-3 (oldest 3)
    expect(result).toContain('Section 4');
    expect(result).toContain('Section 8');
    expect(result).not.toContain('Section 1');
    expect(result).not.toContain('Section 3');

    // Should have a hint about omitted tables
    expect(result).toContain('前 3 个表格已省略');
  });

  it('preserves non-table text between tables', () => {
    const text = [
      '# Header',
      '',
      'Intro text',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Between tables',
      '',
      '| x | y |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n');

    // With maxTables=1, should keep only the last table
    const result = truncateMarkdownTables(text, 1);
    expect(countMarkdownTables(result)).toBe(1);
    expect(result).toContain('Between tables');
    expect(result).toContain('| x | y |');
    expect(result).not.toContain('| a | b |');
  });

  it('handles custom maxTables parameter', () => {
    const parts: string[] = [];
    for (let i = 0; i < 4; i++) {
      parts.push(`| # | col |`);
      parts.push(`|---|-----|`);
      parts.push(`| R${i + 1} | val${i} |`);
      if (i < 3) parts.push('');
    }
    const text = parts.join('\n');

    // 4 tables with maxTables=2: should remove 2 oldest
    const result = truncateMarkdownTables(text, 2);
    expect(countMarkdownTables(result)).toBe(2);
  });

  it('handles table with no data rows', () => {
    const text = '| a | b |\n|---|---|';
    expect(countMarkdownTables(text)).toBe(1);
    expect(truncateMarkdownTables(text, 5)).toBe(text);
  });

  it('default maxTables equals FEISHU_MAX_TABLES constant', () => {
    const parts: string[] = [];
    for (let i = 0; i < FEISHU_MAX_TABLES + 1; i++) {
      parts.push(`| # | col |`);
      parts.push(`|---|-----|`);
      parts.push(`| R${i + 1} | val${i} |`);
      if (i < FEISHU_MAX_TABLES) parts.push('');
    }
    const text = parts.join('\n');
    // Using default (no maxTables arg) should truncate to FEISHU_MAX_TABLES
    const result = truncateMarkdownTables(text);
    expect(countMarkdownTables(result)).toBe(FEISHU_MAX_TABLES);
  });
});
