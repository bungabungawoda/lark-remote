import { describe, expect, it } from 'vitest';
import { renderBashCard, type BashState } from '../card/bash-renderer.js';

// 飞书卡片大致限制（保守值）
const FEISHU_CARD_LIMIT = 28_000;

function makeState(overrides: Partial<BashState> = {}): BashState {
  return {
    runId: 'test-run-1',
    terminal: 'done',
    output: '',
    stderr: '',
    exitCode: 0,
    command: 'codex debug models',
    ...overrides,
  };
}

describe('bash-card-settle-fallback', () => {
  /**
   * Anchor: test_anchor_bash_card_settle_fallback_uses_emergency_card
   *
   * 验证：当 settle 失败后需要发送静态 fallback 时，
   * 即使 output 仍然超大，也要确保 fallback 卡片能成功发送。
   *
   * 这是第三层保护：即使前两层都失效，用户也一定能看到终态卡片。
   *
   * 期望行为：fallback 使用极简卡片（命令 + 退出码 + 状态），不包含完整 output
   */
  it('test_anchor_bash_card_settle_fallback_uses_emergency_card', () => {
    // 模拟一个超大 output 的终态
    const hugeOutput = 'x'.repeat(300_000);
    const state = makeState({
      terminal: 'done',
      exitCode: 0,
      output: hugeOutput,
      stderr: '',
    });

    const card = renderBashCard(state, {});
    const cardStr = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(cardStr, 'utf8');

    // 第三层要求：即使第一二层都失效，fallback 卡片也必须能在 28KB 内发送
    // 注意：由于我们已经在第一层（renderBashCard）添加了截断，
    // 这里应该能通过。但我们仍然验证这个 contract。
    expect(cardBytes).toBeLessThan(FEISHU_CARD_LIMIT);

    // 验证卡片仍然显示正确的终态信息
    expect(cardStr).toContain('命令执行完成');
    expect(cardStr).toContain('退出码: 0');
    expect(cardStr).toContain('codex debug models');
  });

  /**
   * Anchor: test_anchor_bash_card_error_state_with_large_output
   *
   * 验证：错误状态下的 fallback 也能正常渲染
   * 注：stderr 和 output 各自被截断到 12KB，但仍可能组合超限
   * 这是第三层的极端情况测试 - 如果仍然超限，需要降级到真正的极简卡片
   */
  it('test_anchor_bash_card_error_state_with_large_output', () => {
    const state = makeState({
      terminal: 'error',
      exitCode: 1,
      output: 'x'.repeat(300_000),
      stderr: 'error msg'.repeat(300_000), // 约 2.4MB 的 stderr
    });

    const card = renderBashCard(state, {});
    const cardStr = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(cardStr, 'utf8');

    // 第三层要求：即使 output + stderr 组合超限，fallback 也要能在限制内发送
    // 当前实现：12KB * 2 = 24KB，仍然可能超限
    expect(cardBytes).toBeLessThanOrEqual(FEISHU_CARD_LIMIT);
    expect(cardStr).toContain('命令执行失败');
    expect(cardStr).toContain('退出码: 1');
  });

  /**
   * Anchor: test_anchor_bash_card_interrupted_state
   *
   * 验证：中断状态下的 fallback
   */
  it('test_anchor_bash_card_interrupted_state', () => {
    const state = makeState({
      terminal: 'interrupted',
      exitCode: -1,
      output: 'x'.repeat(300_000),
      stderr: '',
    });

    const card = renderBashCard(state, {}) as { header?: { title?: { content?: string } } };

    // 中断状态的 header title 是 "⏹ 已终止"
    expect(card.header?.title?.content).toContain('已终止');
  });
});
