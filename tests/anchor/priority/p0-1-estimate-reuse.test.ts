/**
 * P0-1 残余 anchor：normal 路径块内容截断必须只做一次
 *
 * estimateCardBytes（影子测量）与 buildChronologicalContent（正式渲染）各自对
 * 超限块调用 truncateUtf8 —— 同一个块在一次 renderRunCard 里被截断两次
 * （双倍截断）。fitUtf8 修复后单次截断已 O(budget)，但每次渲染仍重复截断，
 * 高峰流式下是纯浪费。review.md §P0-1 修复建议：「estimateCardBytes 的测量结果
 * 在走 normal 路径时复用，避免『影子测量 + 正式渲染』双倍截断」。
 */
import { describe, it, expect, vi } from 'vitest';
import { createInitialRunState, finishRun, reduceRunState } from '../../../src/card/run-state.js';
import { renderRunCard } from '../../../src/card/run-renderer.js';

const { truncateSpy } = vi.hoisted(() => ({
  truncateSpy: {
    truncateUtf8: vi.fn(),
  },
}));

// Spy the shared truncation primitive (real implementation kept, calls counted)
// so we can assert a single oversized block is truncated exactly once per
// renderRunCard call.
vi.mock('../../../src/card/text-truncate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/card/text-truncate.js')>();
  truncateSpy.truncateUtf8.mockImplementation(actual.truncateUtf8);
  return {
    ...actual,
    truncateUtf8: truncateSpy.truncateUtf8,
  };
});

describe('P0-1 estimate/render truncation reuse', () => {
  it('test_anchor_render_run_card_truncates_oversized_block_once', () => {
    // ① 验证什么行为：一次 renderRunCard（normal 路径）中，单个超限块只被
    //    truncateUtf8 截断一次（测量与渲染共用同一份截断结果）。
    // ② 缺失/错误会导致什么：estimateCardBytes 影子测量截断一次 + 正式渲染
    //    再截断一次 → 每个超限块双倍 O(budget) 开销；流式高峰每次 flush 都
    //    重复支付，12k 字符长文本常态下累计可观。
    // ③ 依据：review.md §P0-1「estimateCardBytes 的测量结果在走 normal 路径时
    //    复用，避免『影子测量 + 正式渲染』双倍截断」。
    let state = createInitialRunState('run-p01-reuse');
    const bigText = 'x'.repeat(50_000);
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: bigText }] },
    });
    state = finishRun(state, 'done', { resultSubtype: 'success' });

    truncateSpy.truncateUtf8.mockClear();
    renderRunCard(state);

    // 只统计超长输入（>10k 字符）的截断调用——summary/header 等小块不受影响
    const bigCalls = truncateSpy.truncateUtf8.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].length > 10_000,
    );
    expect(bigCalls.length).toBe(1);
  });
});
