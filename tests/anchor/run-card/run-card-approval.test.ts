/**
 * Run 卡审批区契约：位置（内容之后、body 最底部）与窄屏纵向堆叠。
 *
 * 合并自 approval-area-order / approval-buttons-vertical。
 */
import { describe, expect, it } from 'vitest';
import { createInitialRunState, reduceRunState } from '../../../src/card/run-state.js';
import type { RunState } from '../../../src/card/run-state.js';
import { renderRunCard } from '../../../src/card/run-renderer.js';

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

/** 收集 CardKit 元素树中所有回调 cmd（behaviors[].value.cmd）。 */
function collectCmds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectCmds(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.tag === 'button' && Array.isArray(obj.behaviors)) {
      for (const behavior of obj.behaviors as Array<Record<string, unknown>>) {
        const cmd = (behavior.value as Record<string, unknown> | undefined)?.cmd;
        if (typeof cmd === 'string') out.push(cmd);
      }
    }
    for (const child of Object.values(obj)) collectCmds(child, out);
  }
  return out;
}

/** 收集 CardKit 元素树中所有 column_set 容器。 */
function collectColumnSets(
  value: unknown,
  out: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) collectColumnSets(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.tag === 'column_set') out.push(obj);
    for (const child of Object.values(obj)) collectColumnSets(child, out);
  }
  return out;
}

function makeApprovalState(opts: {
  runId: string;
  requestId: number;
  command: string;
  availableDecisions: string[];
  reason?: string;
}): RunState {
  return reduceRunState(createInitialRunState(opts.runId), {
    type: 'approval_requested',
    requestId: opts.requestId,
    kind: 'command',
    threadId: 'th-aaa-222',
    turnId: 'tn-222',
    itemId: 'item-1',
    view: {
      requestId: opts.requestId,
      kind: 'command',
      command: opts.command,
      commandCwd: '/home/user/project',
      reason: opts.reason,
      availableDecisions: opts.availableDecisions,
    },
  } as never);
}

/** 追加足够大的 thinking/tool/text，触发 degraded 降级路径。 */
function pushDegradedBlocks(state: RunState, textMarker: string): void {
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
        id: 'tool-degraded-' + i,
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
    content: textMarker + 'T'.repeat(8000),
    timestamp: '2026-08-04T10:30:00.000Z',
  });
}

describe('run card approval area', () => {
  it('test_anchor_approval_area_renders_after_content_and_at_body_bottom', () => {
    const state = makeApprovalState({
      runId: 'run-aaa-111',
      requestId: 1001,
      command: 'mv /tmp/a.txt /tmp/b.txt',
      availableDecisions: ['accept', 'decline', 'cancel'],
      reason: 'Test approval',
    });
    const card = renderRunCard(state) as { body: { elements: unknown[] } };

    const texts = collectTexts(card.body.elements);
    const placeholderIdx = texts.findIndex((t) => t.includes('暂无输出'));
    const approvalIdx = texts.findIndex((t) => t.includes('⚡ 命令审批'));

    // 内容空态占位必须在审批区之前
    expect(placeholderIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThan(placeholderIdx);

    // 审批区必须是 body 最底部（最后一个可见文本是决策按钮文案）
    expect(texts[texts.length - 1]).toMatch(/允许|拒绝/);
  });

  it('test_anchor_approval_area_order_degraded_tier', () => {
    const state = makeApprovalState({
      runId: 'run-aaa-111',
      requestId: 1001,
      command: 'mv /tmp/a.txt /tmp/b.txt',
      availableDecisions: ['accept', 'decline', 'cancel'],
      reason: 'Test approval',
    });
    const CONTENT_MARKER = 'DEGRADED-CONTENT-MARKER-XYZ';
    pushDegradedBlocks(state, CONTENT_MARKER + '必须完整保留的文本输出。');

    const card = renderRunCard(state) as { body: { elements: unknown[] } };
    const json = JSON.stringify(card);

    expect(json).toMatch(/个早期思考已省略/);

    const texts = collectTexts(card.body.elements);
    const contentIdx = texts.findIndex((t) => t.includes(CONTENT_MARKER));
    const approvalIdx = texts.findIndex((t) => t.includes('⚡ 命令审批'));
    expect(contentIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThan(contentIdx);

    expect(texts[texts.length - 1]).toMatch(/允许|拒绝/);
  });

  function assertApprovalButtonsStacked(card: { body: { elements: unknown[] } }, expected: number) {
    const topLevelApprovalButtons = card.body.elements.filter(
      (el) =>
        (el as { tag?: string }).tag === 'button' && collectCmds(el).includes('approval.respond'),
    );
    expect(topLevelApprovalButtons).toHaveLength(expected);

    for (const columnSet of collectColumnSets(card)) {
      const approvalButtonCount = collectCmds(columnSet).filter(
        (cmd) => cmd === 'approval.respond',
      ).length;
      expect(approvalButtonCount).toBeLessThanOrEqual(1);
    }
  }

  it('test_anchor_approval_decision_buttons_stack_vertically_on_narrow_screens', () => {
    const state = makeApprovalState({
      runId: 'run-approval-vertical',
      requestId: 61,
      command: 'rm -rf /tmp/a',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    });

    const card = renderRunCard(state) as { body: { elements: unknown[] } };
    const serialized = JSON.stringify(card);
    for (const label of ['✅ 允许', '✅ 允许本次会话', '❌ 拒绝']) {
      expect(serialized).toContain(label);
    }

    assertApprovalButtonsStacked(card, 3);
  });

  it('test_probe_four_decision_buttons_also_stack_vertically', () => {
    const state = makeApprovalState({
      runId: 'run-approval-vertical-4',
      requestId: 62,
      command: 'npm publish',
      availableDecisions: [
        'accept',
        'acceptForSession',
        'acceptWithExecpolicyAmendment',
        'decline',
        'cancel',
      ],
    });

    const card = renderRunCard(state) as { body: { elements: unknown[] } };
    const serialized = JSON.stringify(card);
    for (const label of ['✅ 允许', '✅ 允许本次会话', '🔒 允许并记住命令', '❌ 拒绝']) {
      expect(serialized).toContain(label);
    }

    assertApprovalButtonsStacked(card, 4);
  });

  it('test_probe_approval_buttons_stack_vertically_in_degraded_tier', () => {
    const state = makeApprovalState({
      runId: 'run-approval-degraded',
      requestId: 63,
      command: 'deploy --prod',
      availableDecisions: ['accept', 'decline', 'cancel'],
    });
    pushDegradedBlocks(state, 'DEGRADED-CONTENT-MARKER');

    const card = renderRunCard(state) as { body: { elements: unknown[] } };
    expect(JSON.stringify(card)).toMatch(/个早期思考已省略/);
    expect(JSON.stringify(card)).toContain('✅ 允许');
    expect(JSON.stringify(card)).toContain('❌ 拒绝');

    assertApprovalButtonsStacked(card, 2);
  });
});
