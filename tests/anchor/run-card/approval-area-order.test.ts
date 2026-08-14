/**
 * Anchor: 审批区必须渲染在内容流之后、且位于卡片 body 最底部（底部操作行之后）。
 *
 * ① 验证什么：run 卡处于「待审批 + 无任何输出块」时，renderRunCard 的 body 元素
 *    顺序必须是 —— 内容流（含「_暂无输出_」空态占位）→ 底部操作行 → 审批区
 *    （⚡ 命令审批 + ✅/🔒/❌ 决策按钮）。即「暂无输出」文本位于「⚡ 命令审批」
 *    之前，且审批决策按钮文案是 body 的最后一个可见文本。
 * ② 缺失/错误会导致什么：当前实现把 renderApprovalArea 拼在内容流之前，用户看到
 *    审批标题和决策按钮悬浮在「暂无输出」上方，与「审批按钮应位于卡片最下面」的
 *    预期相反；若只把审批区挪到内容之后但仍在底部操作行之前，按钮仍不是卡片
 *    最底部，同样不符合本契约。
 * ③ 依据：round-log session spec ——「审批区必须渲染在内容流之后，且作为卡片
 *    body 最底部（位于底部操作行 stop/新会话 之后），normal/degraded/extreme
 *    全层级一致」；用户原话「这里的审判按钮，不是在最下面，在暂无输出上面」。
 */
import { describe, expect, it } from 'vitest';
import { createInitialRunState, reduceRunState } from '../../../src/card/run-state.js';
import { renderRunCard } from '../../../src/card/run-renderer.js';
import type { ApprovalRequestedEvent } from '../../../src/runner/types.js';

/** 递归收集 CardKit 2.0 卡片中按文档顺序排列的可见文本（content 字段）。 */
function collectTexts(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTexts(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'content' && typeof child === 'string') out.push(child);
      else collectTexts(child, out);
    }
  }
  return out;
}

describe('anchor: approval area card position', () => {
  function makePendingApprovalState() {
    const event: ApprovalRequestedEvent = {
      type: 'approval_requested',
      requestId: 1001,
      kind: 'command',
      threadId: 'th-aaa-222',
      turnId: 'tn-222',
      itemId: 'item-2',
      view: {
        requestId: 1001,
        kind: 'command',
        threadShort: 'th-aaa-2',
        turnShort: 'tn-222',
        workspace: '/home/user/project',
        command: 'mv /tmp/a.txt /tmp/b.txt',
        commandCwd: '/home/user/project',
        reason: 'Test approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
        pendingTotal: 1,
      },
    };
    return reduceRunState(createInitialRunState('run-aaa-111'), event);
  }

  it('test_anchor_approval_area_renders_after_content_and_at_body_bottom', () => {
    const state = makePendingApprovalState();
    const card = renderRunCard(state) as { body: { elements: unknown[] } };

    // CardKit 2.0 结构前提：body.elements 存在且包含空态占位与审批标题
    const texts = collectTexts(card.body.elements);
    const placeholderIdx = texts.findIndex((t) => t.includes('暂无输出'));
    const approvalIdx = texts.findIndex((t) => t.includes('⚡ 命令审批'));

    // 内容空态占位必须在审批区之前
    expect(placeholderIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThan(placeholderIdx);

    // 审批区必须是 body 最底部（位于底部操作行 stop/新会话 之后）：
    // 最后一个可见文本必须是审批决策按钮文案
    expect(texts[texts.length - 1]).toMatch(/允许|拒绝/);
  });

  /**
   * Anchor: degraded tier 与 normal 相同的相对顺序——内容在审批区之前、
   * 审批决策按钮在 body 最底部。
   *
   * ① 验证什么：state 大到触发降级路径（估算 ≥ DEGRADED_THRESHOLD）且待审批时，
   *    降级卡的内容标记（大文本块）仍位于「⚡ 命令审批」之前，审批决策按钮仍是
   *    body 最后一个可见文本（即审批区在底部操作行之后）。
   * ② 缺失/错误会导致什么：若绿只在 normal 路径修了顺序、漏掉 degraded 路径
   *    （buildDegradedElements 仍把 renderApprovalArea 拼在 statusRow 之后），
   *    大输出 run 的降级卡会再次出现按钮悬浮在内容上方的问题。
   * ③ 依据：round-log session spec「normal/degraded/extreme 全层级一致」；
   *    构造方式参照 tests/anchor/misc/degraded-showtoolresult-ignored.test.ts
   *    （7×2500 thinking + 5 大 tool + 大文本触发降级）。
   */
  it('test_anchor_approval_area_order_degraded_tier', () => {
    const state = makePendingApprovalState();
    const CONTENT_MARKER = 'DEGRADED-CONTENT-MARKER-XYZ';

    // 触发降级路径：7 个 ~2.5KB thinking + 5 个大 tool + 大文本
    for (let i = 0; i < 7; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'x'.repeat(2500),
        active: false,
        timestamp: `2026-08-04T10:0${i}:00.000Z`,
      });
    }
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-order-degraded-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: 'o'.repeat(3500),
          status: 'ok',
          startedAt: '2026-08-04T10:10:00.000Z',
          completedAt: '2026-08-04T10:11:00.000Z',
        },
      });
    }
    state.blocks.push({
      kind: 'text',
      content: CONTENT_MARKER + '必须完整保留的文本输出。' + 'T'.repeat(8000),
      timestamp: '2026-08-04T10:30:00.000Z',
    });

    const card = renderRunCard(state) as { body: { elements: unknown[] } };
    const json = JSON.stringify(card);

    // 前提：确实走了 degraded 路径（有 thinking omission hint）
    expect(json).toMatch(/个早期思考已省略/);

    const texts = collectTexts(card.body.elements);
    const contentIdx = texts.findIndex((t) => t.includes(CONTENT_MARKER));
    const approvalIdx = texts.findIndex((t) => t.includes('⚡ 命令审批'));
    expect(contentIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThan(contentIdx);

    // 降级 tier 同样要求审批区位于 body 最底部（底部操作行之后）
    expect(texts[texts.length - 1]).toMatch(/允许|拒绝/);
  });
});
