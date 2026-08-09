import { describe, expect, it } from 'vitest';
import { renderBashCard, type BashState } from './bash-renderer.js';

// 生成一个超大 output（超过飞书限制）
function generateLargeOutput(charCount: number): string {
  return 'x'.repeat(charCount);
}

function makeState(overrides: Partial<BashState> = {}): BashState {
  return {
    runId: 'test-run-1',
    terminal: 'running',
    output: '',
    stderr: '',
    exitCode: null,
    command: 'codex debug models',
    ...overrides,
  };
}

// 飞书卡片大致限制（保守值）
const FEISHU_CARD_LIMIT = 28_000;

describe('bash-card-output-truncation', () => {
  /**
   * Anchor: test_anchor_bash_card_output_truncation
   *
   * 验证：当 output 超过一定大小时，renderBashCard 应该对输出进行截断，
   * 以避免卡片内容超出飞书 API 限制导致 HTTP 400 错误。
   *
   * 当前行为（bug）：直接将完整 output 放入卡片，导致超限
   * 期望行为：截断 output，保留最后 N KB + 截断提示
   */
  it('test_anchor_bash_card_output_truncation', () => {
    // 模拟 codex debug models 的超大输出（约 300KB 原始数据）
    const hugeOutput = generateLargeOutput(300_000);
    const state = makeState({ output: hugeOutput, terminal: 'done', exitCode: 0 });

    const card = renderBashCard(state, {}) as {
      schema: string;
      header: unknown;
      body?: { elements: unknown[] };
    };
    const cardStr = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(cardStr, 'utf8');

    // 验证：渲染后的卡片应该小于飞书限制
    expect(cardBytes).toBeLessThan(FEISHU_CARD_LIMIT);

    // 验证：卡片中应该包含截断提示
    expect(cardStr).toContain('截断');
  });

  /**
   * Anchor: test_anchor_bash_card_oversized_still_renders
   *
   * 验证：即使 output 极大导致需要截断，渲染仍然成功且返回有效卡片
   */
  it('test_anchor_bash_card_oversized_still_renders', () => {
    const state = makeState({
      output: generateLargeOutput(500_000),
      stderr: generateLargeOutput(50_000),
      terminal: 'done',
      exitCode: 0,
    });

    const card = renderBashCard(state, {}) as {
      schema: string;
      header: unknown;
      body?: { elements: unknown[] };
    };

    // 验证：返回的是有效卡片对象（包含必要字段）
    expect(card).toHaveProperty('schema', '2.0');
    expect(card).toHaveProperty('header');
    expect(card).toHaveProperty('body');
    expect(card.body!).toHaveProperty('elements');
    expect(Array.isArray(card.body!.elements)).toBe(true);
  });
});
