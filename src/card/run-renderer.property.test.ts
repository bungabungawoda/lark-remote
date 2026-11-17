import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { estimateCardBytes, renderRunCard } from './run-renderer.js';
import type { RunBlock, RunState } from './run-state.js';
import {
  countCardComponents,
  countCardElements,
  MAX_CARD_COMPONENTS,
  MAX_CARD_ELEMENTS,
} from './card-budget.js';
import { CARD_BUDGET_BYTES } from './text-truncate.js';

/**
 * 流式卡片渲染的属性测试。
 *
 * 1) 估算必须等于实际渲染字节（差异 ≤ 200B）：估算是「先估后建」的性能开关，
 *    估低会先建一张超限卡再丢弃（白付 CPU），估高会把本可完整展示的 CJK 会话
 *    误降级、丢掉早期思考与工具。手写用例只能覆盖作者想到的转义形态。
 * 2) 任意状态渲染出的卡都不得越过飞书 11310 的字节 / elements / tagged 上限，
 *    否则用户看到的是一张整卡报错——这比少显示几行严重得多。
 */

const CJK = '汉';
const EMOJI = '😀';

const contentArb = fc
  .array(fc.constantFrom('a', ' ', '\n', '"', '\\', '#', '-', '|', CJK, EMOJI), {
    maxLength: 700,
  })
  .map((units) => units.join(''));

const timestampArb = fc.constantFrom(
  undefined,
  '2026-01-01T08:00:00.000Z',
  '2026-01-01T08:01:00.000Z',
);

const toolArb: fc.Arbitrary<RunBlock> = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 8 }),
    name: fc.constantFrom('Bash', 'Read', 'Edit', 'Grep'),
    command: contentArb,
    output: contentArb,
    status: fc.constantFrom('running' as const, 'ok' as const, 'error' as const),
    startedAt: timestampArb,
    completedAt: timestampArb,
  })
  .map(({ id, name, command, output, status, startedAt, completedAt }) => ({
    kind: 'tool',
    tool: {
      id,
      name,
      input: { command },
      output,
      status,
      startedAt,
      completedAt,
    },
  }));

const blockArb: fc.Arbitrary<RunBlock> = fc.oneof(
  fc.record({ content: contentArb, timestamp: timestampArb }).map(({ content, timestamp }) => ({
    kind: 'text' as const,
    content,
    timestamp,
  })),
  fc
    .record({
      content: contentArb,
      timestamp: timestampArb,
      active: fc.boolean(),
    })
    .map(({ content, timestamp, active }) => ({
      kind: 'thinking' as const,
      content,
      active,
      timestamp,
    })),
  toolArb,
);

const stateArb: fc.Arbitrary<RunState> = fc
  .record({
    runId: fc.string({ minLength: 1, maxLength: 10 }),
    terminal: fc.constantFrom('running' as const, 'finalizing' as const, 'done' as const),
    blocks: fc.array(blockArb, { maxLength: 6 }),
    startedAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: undefined }),
    finishedAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: undefined }),
  })
  .map(({ runId, terminal, blocks, startedAt, finishedAt }) => ({
    runId,
    terminal,
    footer: null,
    blocks,
    startedAt,
    finishedAt,
    sessionId: 's-property',
    resultSubtype: terminal === 'done' ? ('success' as const) : undefined,
  }));

describe('renderRunCard invariants (property)', () => {
  it('fits every Feishu limit for arbitrary block content', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const card = renderRunCard(state);
        expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(
          CARD_BUDGET_BYTES,
        );
        expect(countCardElements(card)).toBeLessThanOrEqual(MAX_CARD_ELEMENTS);
        expect(countCardComponents(card)).toBeLessThanOrEqual(MAX_CARD_COMPONENTS);
      }),
      { numRuns: 60 },
    );
  });

  it('keeps the byte estimate within 200B of the rendered card on the normal path', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const estimate = estimateCardBytes(state);
        // 估算 ≥ 24KB 时渲染器会主动降级，此时两者本就不应相等；只对比正常路径。
        fc.pre(estimate < 24_000);
        const actual = Buffer.byteLength(JSON.stringify(renderRunCard(state)), 'utf8');
        expect(Math.abs(actual - estimate)).toBeLessThanOrEqual(200);
      }),
      { numRuns: 60 },
    );
  });
});
