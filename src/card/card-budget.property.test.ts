import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  countCardComponents,
  countCardElements,
  enforceCardBudget,
  MAX_CARD_COMPONENTS,
  MAX_CARD_ELEMENTS,
} from './card-budget.js';
import { CARD_BUDGET_BYTES, countMarkdownTables, FEISHU_MAX_TABLES } from './text-truncate.js';

/**
 * 卡片预算的属性测试。
 *
 * 单元用例覆盖了每个裁剪阶段，但阶段组合与输入形状的组合空间远大于手写用例。
 * 这里断言的是发送前必须成立的四条不变量：字节、elements、tagged 组件都不超
 * 飞书上限；已裁剪的卡片再裁一次不再丢内容（bridge 与 config-render 都会调用）。
 * 违反任意一条，用户看到的是 11310 整卡不可用或内容被二次吞掉。
 */

const CJK = '汉';
const EMOJI = '😀';
const TABLE_ROW = '| a | b |\n|---|---|\n| 1 | 2 |\n';

const textUnit = fc.constantFrom('a', ' ', '\n', '"', '\\', '|', '-', ':', '#', CJK, EMOJI);

const textArb = fc.array(textUnit, { maxLength: 240 }).map((units) => units.join(''));

const tableTextArb = fc
  .tuple(fc.integer({ min: 0, max: 8 }), textArb)
  .map(([tables, tail]) => TABLE_ROW.repeat(tables) + tail);

function markdownDiv(content: string): object {
  return {
    tag: 'div',
    text: { tag: 'lark_md', content },
  };
}

function button(cmd: string): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: cmd },
    behaviors: [{ type: 'callback', value: { cmd } }],
  };
}

const leafElementArb: fc.Arbitrary<object> = fc.oneof(
  tableTextArb.map(markdownDiv),
  fc
    .array(
      fc.record({
        value: fc.string({ maxLength: 12 }),
        text: textArb,
      }),
      { minLength: 1, maxLength: 12 },
    )
    .map((options) => ({
      tag: 'select_static',
      initial_option: options[0].value,
      options: options.map((o) => ({
        value: o.value,
        text: { tag: 'plain_text', content: o.text },
      })),
    })),
  fc.constantFrom('stop', 'new-session', 'queue.cancel').map(button),
);

const elementArb: fc.Arbitrary<object> = fc.letrec((tie) => ({
  element: fc.oneof(
    { depthIdentifier: 'card-element' },
    leafElementArb,
    fc
      .record({
        title: textArb,
        body: fc.array(tie('element'), { maxLength: 6 }),
      })
      .map(({ title, body }) => ({
        tag: 'collapsible_panel',
        header: { title: { tag: 'plain_text', content: title } },
        elements: body,
      })),
    fc
      .array(fc.array(tie('element'), { maxLength: 4 }), { minLength: 1, maxLength: 4 })
      .map((columns) => ({
        tag: 'column_set',
        columns: columns.map((elements) => ({ tag: 'column', width: 'auto', elements })),
      })),
  ),
})).element as fc.Arbitrary<object>;

const cardArb: fc.Arbitrary<object> = fc
  .record({
    title: textArb,
    elements: fc.array(elementArb, { maxLength: 30 }),
  })
  .map(({ title, elements }) => ({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title } },
    body: { elements },
  }));

/** Count markdown tables in the rendered card's lark_md fields (not in raw JSON). */
function countTablesInCard(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce((sum, item) => sum + countTablesInCard(item), 0);
  }
  if (!node || typeof node !== 'object') return 0;
  const rec = node as Record<string, unknown>;
  const text = rec.text as { tag?: unknown; content?: unknown } | undefined;
  const own =
    text?.tag === 'lark_md' && typeof text.content === 'string'
      ? countMarkdownTables(text.content)
      : 0;
  return own + Object.values(rec).reduce<number>((sum, child) => sum + countTablesInCard(child), 0);
}

describe('enforceCardBudget invariants (property)', () => {
  it('never returns a card over any Feishu limit, and a second pass is a no-op', () => {
    fc.assert(
      fc.property(cardArb, (card) => {
        const result = enforceCardBudget(card);
        const json = JSON.stringify(result.card);

        expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(CARD_BUDGET_BYTES);
        expect(countCardElements(result.card)).toBeLessThanOrEqual(MAX_CARD_ELEMENTS);
        expect(countCardComponents(result.card)).toBeLessThanOrEqual(MAX_CARD_COMPONENTS);

        const second = enforceCardBudget(result.card);
        expect(second.wasTruncated).toBe(false);
        expect(second.bytesAfter).toBe(result.bytesAfter);
      }),
      { numRuns: 80 },
    );
  });

  it('never leaves more markdown tables than Feishu accepts', () => {
    fc.assert(
      fc.property(cardArb, (card) => {
        const result = enforceCardBudget(card);
        const tables = countTablesInCard(result.card);
        expect(tables).toBeLessThanOrEqual(FEISHU_MAX_TABLES);
      }),
      { numRuns: 40 },
    );
  });

  it('returns the original card untouched when it is already inside every limit', () => {
    fc.assert(
      fc.property(fc.array(textArb, { maxLength: 4 }), (lines) => {
        const card = {
          schema: '2.0',
          body: { elements: lines.map(markdownDiv) },
        };
        const result = enforceCardBudget(card);
        expect(result.wasTruncated).toBe(false);
        expect(result.card).toEqual(card);
      }),
      { numRuns: 40 },
    );
  });
});
