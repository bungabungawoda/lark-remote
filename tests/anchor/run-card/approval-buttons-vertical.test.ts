/**
 * Anchor: 审批决策按钮必须纵向堆叠（上下排列），不得用 column_set 横排。
 *
 * ① 验证什么：命令审批的决策按钮（✅ 允许 / ✅ 允许本次会话 / ❌ 拒绝）每个
 *    都是 body.elements 的直接子元素（CardKit body 纵向堆叠 = 上下排列）；
 *    body 中任何 column_set 都不得同时容纳 ≥2 个审批决策按钮（横排行会把窄屏
 *    按钮文字挤成省略号）。
 * ② 缺失/错误会导致什么：column_set width:auto 横排下，手机窄屏把三个审批
 *    按钮挤成"点点点"，用户无法辨认动作，审批不可操作。
 * ③ 依据：用户原话「在手机这样的窄屏上面，按钮会被挤成点点点」「三个审批
 *    相关的按钮应该上下排列，而不是横着排成一行」。
 */
import { describe, expect, it } from 'vitest';
import { createInitialRunState, reduceRunState } from '../../../src/card/run-state.js';
import { renderRunCard } from '../../../src/card/run-renderer.js';

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

/** 收集 CardKit 元素树中所有 column_set 容器（断言横排不得容纳多个审批按钮）。 */
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

describe('anchor: approval decision buttons stack vertically on narrow screens', () => {
  it('test_anchor_approval_decision_buttons_stack_vertically_on_narrow_screens', () => {
    let state = createInitialRunState('run-approval-vertical');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 61,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-1',
      view: {
        requestId: 61,
        kind: 'command',
        threadShort: 'th-aaa-1',
        turnShort: 'tn-111',
        workspace: '/home/user/project',
        command: 'rm -rf /tmp/a',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        pendingTotal: 1,
      },
    } as never);

    const card = renderRunCard(state) as { body: { elements: unknown[] } };
    const elements = card.body.elements;

    // 前提：三个决策按钮都渲染了
    const serialized = JSON.stringify(card);
    for (const label of ['✅ 允许', '✅ 允许本次会话', '❌ 拒绝']) {
      expect(serialized).toContain(label);
    }

    // 契约 1：决策按钮纵向堆叠 = body.elements 的直接子元素，共 3 个
    const topLevelApprovalButtons = elements.filter(
      (el) =>
        (el as { tag?: string }).tag === 'button' && collectCmds(el).includes('approval.respond'),
    );
    expect(topLevelApprovalButtons).toHaveLength(3);

    // 契约 2：不得存在容纳 ≥2 个审批决策按钮的 column_set 横排行
    for (const columnSet of collectColumnSets(card)) {
      const approvalButtonCount = collectCmds(columnSet).filter(
        (cmd) => cmd === 'approval.respond',
      ).length;
      expect(approvalButtonCount).toBeLessThanOrEqual(1);
    }
  });

  it('test_probe_four_decision_buttons_also_stack_vertically', () => {
    // T2 分支探测：协议同时给出 acceptWithExecpolicyAmendment（允许并记住命令）
    // 时共 4 个决策按钮，同样必须纵向堆叠、不得进 column_set 横排行。
    // 红假设：持久化决策分支（offered 含 acceptWithExecpolicyAmendment）与
    // 3 按钮分支共享同一渲染路径，布局契约应一致；spec（用户原话）未明说
    // 4 按钮场景，但窄屏挤压风险同样存在，故锁定该分支防回归。
    let state = createInitialRunState('run-approval-vertical-4');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 62,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-1',
      view: {
        requestId: 62,
        kind: 'command',
        threadShort: 'th-aaa-1',
        turnShort: 'tn-111',
        workspace: '/home/user/project',
        command: 'npm publish',
        commandCwd: '/home/user/project',
        availableDecisions: [
          'accept',
          'acceptForSession',
          'acceptWithExecpolicyAmendment',
          'decline',
          'cancel',
        ],
        pendingTotal: 1,
      },
    } as never);

    const card = renderRunCard(state) as { body: { elements: unknown[] } };
    const elements = card.body.elements;

    // 前提：四个决策按钮都渲染了
    const serialized = JSON.stringify(card);
    for (const label of ['✅ 允许', '✅ 允许本次会话', '🔒 允许并记住命令', '❌ 拒绝']) {
      expect(serialized).toContain(label);
    }

    // 契约：4 个决策按钮全部是 body 直接子元素（纵向堆叠）
    const topLevelApprovalButtons = elements.filter(
      (el) =>
        (el as { tag?: string }).tag === 'button' && collectCmds(el).includes('approval.respond'),
    );
    expect(topLevelApprovalButtons).toHaveLength(4);

    // 契约：任何 column_set 不得容纳 ≥2 个审批决策按钮
    for (const columnSet of collectColumnSets(card)) {
      const approvalButtonCount = collectCmds(columnSet).filter(
        (cmd) => cmd === 'approval.respond',
      ).length;
      expect(approvalButtonCount).toBeLessThanOrEqual(1);
    }
  });

  it('test_probe_approval_buttons_stack_vertically_in_degraded_tier', () => {
    // T2 分支探测：run 卡走 degraded 降级路径（大输出触发）时，审批决策按钮
    // 同样必须纵向堆叠。红假设：buildDegradedElements 与 normal 路径共用
    // renderApprovalArea，布局契约应一致；spec（用户原话）未明说降级场景，
    // 但 anchor 既有契约「normal/degraded/extreme 全层级一致」同样适用于布局。
    // 构造方式参照 tests/anchor/run-card/approval-area-order.test.ts 的
    // degraded tier 用例（7×2500 thinking + 5 大 tool + 大文本触发降级）。
    let state = createInitialRunState('run-approval-degraded');
    state = reduceRunState(state, {
      type: 'approval_requested',
      requestId: 63,
      kind: 'command',
      threadId: 'th-aaa-111',
      turnId: 'tn-111',
      itemId: 'item-1',
      view: {
        requestId: 63,
        kind: 'command',
        threadShort: 'th-aaa-1',
        turnShort: 'tn-111',
        workspace: '/home/user/project',
        command: 'deploy --prod',
        commandCwd: '/home/user/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
        pendingTotal: 1,
      },
    } as never);

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
      content: 'DEGRADED-CONTENT-MARKER' + 'T'.repeat(8000),
      timestamp: '2026-08-04T10:30:00.000Z',
    });

    const card = renderRunCard(state) as { body: { elements: unknown[] } };
    const elements = card.body.elements;

    // 前提：确实走了 degraded 路径，且审批决策按钮渲染了
    expect(JSON.stringify(card)).toMatch(/个早期思考已省略/);
    for (const label of ['✅ 允许', '❌ 拒绝']) {
      expect(JSON.stringify(card)).toContain(label);
    }

    // 契约：2 个决策按钮全部是 body 直接子元素（纵向堆叠）
    const topLevelApprovalButtons = elements.filter(
      (el) =>
        (el as { tag?: string }).tag === 'button' && collectCmds(el).includes('approval.respond'),
    );
    expect(topLevelApprovalButtons).toHaveLength(2);

    // 契约：任何 column_set 不得容纳 ≥2 个审批决策按钮
    for (const columnSet of collectColumnSets(card)) {
      const approvalButtonCount = collectCmds(columnSet).filter(
        (cmd) => cmd === 'approval.respond',
      ).length;
      expect(approvalButtonCount).toBeLessThanOrEqual(1);
    }
  });
});
