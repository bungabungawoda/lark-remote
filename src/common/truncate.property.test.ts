import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { truncateUtf8, truncateUtf8WithOmissionMarker, frontOmissionMarker } from './truncate.js';
import {
  countMarkdownTables,
  dropOldestMarkdownTables,
  truncateMarkdownTables,
} from '../card/text-truncate.js';

/**
 * 截断原语的属性测试。
 *
 * 这些函数在每条流式事件、每张卡片、每个 session 回放里运行；边界错误会让
 * 用户看到乱码（切坏多字节字符）、内容静默消失（二次截断）或卡片超限。
 * 手写用例覆盖了已知形态，随机输入负责覆盖「CJK / emoji / 换行 / 反斜杠」
 * 与任意字节预算的组合。
 */

const wellFormedText = fc
  .array(fc.constantFrom('a', ' ', '\n', '"', '\\', '汉', '😀', '👨‍👩‍👧', 'é'), {
    maxLength: 600,
  })
  .map((units) => units.join(''));

const SUFFIX = '…（已截断）';
const SUFFIX_BYTES = Buffer.byteLength(SUFFIX, 'utf8');

/** UTF-8 round-trip equality: a lone surrogate comes back as U+FFFD. */
function isWellFormed(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

/** Free text that can never accidentally form a markdown table. */
const plainTextArb = fc
  .array(fc.constantFrom('a', ' ', '\n', '"', '\\', '汉', '😀', 'é'), { maxLength: 80 })
  .map((units) => units.join(''));

describe('truncateUtf8 invariants (property)', () => {
  it('never exceeds the byte budget and never splits a code point', () => {
    fc.assert(
      fc.property(
        wellFormedText,
        fc.integer({ min: SUFFIX_BYTES, max: 4000 }),
        (text, maxBytes) => {
          for (const fromEnd of [false, true]) {
            const out = truncateUtf8(text, maxBytes, fromEnd);
            expect(isWellFormed(out)).toBe(true);
            const allowance = fromEnd ? 1 : 0;
            expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(maxBytes + allowance);
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it('is idempotent and preserves the input when it already fits', () => {
    fc.assert(
      fc.property(wellFormedText, fc.integer({ min: 0, max: 4000 }), (text, maxBytes) => {
        const once = truncateUtf8(text, maxBytes);
        expect(truncateUtf8(once, maxBytes)).toBe(once);
        if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
          expect(once).toBe(text);
        }
      }),
      { numRuns: 80 },
    );
  });
});

describe('truncateUtf8WithOmissionMarker invariants (property)', () => {
  it('keeps the marked body as a tail and stays inside the budget', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        wellFormedText,
        fc.integer({ min: 200, max: 4500 }),
        (alreadyDropped, body, maxBytes) => {
          const marked = frontOmissionMarker(alreadyDropped) + body;
          const out = truncateUtf8WithOmissionMarker(marked, maxBytes);

          expect(isWellFormed(out)).toBe(true);
          if (Buffer.byteLength(marked, 'utf8') <= maxBytes) {
            expect(out).toBe(marked);
            return;
          }
          expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(maxBytes);
          expect(out).toMatch(/^…（前 \d+ 字符已省略）\n/);
          const marker = /^…（前 (\d+) 字符已省略）\n/.exec(out)![0];
          expect(body.endsWith(out.slice(marker.length))).toBe(true);
          // 二次截断不得改变结果（bridge 与 renderer 可能各调用一次）。
          expect(truncateUtf8WithOmissionMarker(out, maxBytes)).toBe(out);
        },
      ),
      { numRuns: 60 },
    );
  });
});

const tableBlock = (id: number, rows: number): string =>
  `### table ${id}\n| a | b |\n|---|---|\n` +
  Array.from({ length: rows }, (_, i) => `| ${id}-${i} | v |`).join('\n') +
  '\n';

const markdownDoc = fc
  .array(
    fc.record({
      tables: fc.integer({ min: 0, max: 3 }),
      rows: fc.integer({ min: 0, max: 3 }),
      tail: plainTextArb,
    }),
    { maxLength: 5 },
  )
  .map((parts) =>
    parts
      .map(
        ({ tables, rows, tail }, index) =>
          tableBlock(index, rows).repeat(tables) + '\ntext ' + index + ' ' + tail + '\n',
      )
      .join(''),
  );

describe('markdown table budgets (property)', () => {
  it('truncateMarkdownTables never leaves more tables than the limit', () => {
    fc.assert(
      fc.property(markdownDoc, fc.integer({ min: 1, max: 5 }), (text, maxTables) => {
        const before = countMarkdownTables(text);
        const out = truncateMarkdownTables(text, maxTables);
        if (before <= maxTables) {
          expect(out).toBe(text);
          return;
        }
        expect(countMarkdownTables(out)).toBeLessThanOrEqual(maxTables);
        expect(out).toContain('表格已省略');
        // 非表格正文必须原样保留（只删最旧的表格块）；空白分隔行随块一起删除。
        for (const line of text.split('\n')) {
          if (line.startsWith('|') || line.startsWith('###') || line.trim() === '') continue;
          expect(out).toContain(line);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('drops blank separators together with the oldest table block', () => {
    const text =
      '\ntext 0 \n  \n### table 1\n| a | b |\n|---|---|\n\n' +
      '### table 1\n| a | b |\n|---|---|\n\n\ntext 1 \n';
    const out = truncateMarkdownTables(text, 1);

    expect(countMarkdownTables(out)).toBe(1);
    expect(out).toContain('表格已省略');
    // 空白分隔行属于被删表格块；非空正文仍须保留。
    expect(out).toContain('text 0 ');
    expect(out).toContain('text 1 ');
  });

  it('dropOldestMarkdownTables removes at least the requested tables when enough exist', () => {
    fc.assert(
      fc.property(markdownDoc, fc.integer({ min: 1, max: 6 }), (text, maxDrop) => {
        const before = countMarkdownTables(text);
        const out = dropOldestMarkdownTables(text, maxDrop);
        if (before === 0) {
          expect(out).toBe(text);
          return;
        }
        const expectedDrop = Math.min(before, maxDrop);
        expect(countMarkdownTables(out)).toBe(before - expectedDrop);
        expect(out).toContain(`前 ${expectedDrop} 个表格已省略`);
      }),
      { numRuns: 60 },
    );
  });
});
