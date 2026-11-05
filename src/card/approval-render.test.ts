/**
 * renderPermissionsApproval / renderApprovalArea 的当前输出（ub characterization）。
 *
 * renderPermissionsApproval 基线 0% 覆盖，等价拆分前先钉住：标题、reason、
 * 每个权限条目的 div + toggle 按钮、条目数上限提示、决策按钮、终态隐藏、
 * expired、deliveryError。200861 红线：交互组件直挂 body elements，
 * 产物不得出现 tag:"action"。
 */
import { describe, it, expect } from 'vitest';
import { renderApprovalArea, renderApprovalAreaCompact } from './approval-render.js';
import type { ApprovalView } from '../runner/types.js';
import type { RunTerminal } from './run-state.js';
import { expectNoV1ActionContainer } from '../../tests/lib/card-view.js';

type AnyRec = Record<string, any>;

function permissionsView(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    requestId: 7,
    kind: 'permissions',
    availableDecisions: ['accept', 'decline'],
    permissions: {
      items: [
        { id: 'p1', label: 'network', target: { kind: 'network' }, selected: true },
        { id: 'p2', label: 'fs', target: { kind: 'fsRead', path: '/w' }, selected: false },
      ],
    },
    ...overrides,
  };
}

/** 递归收集产物里所有 button 的回调 value（含 column_set 内嵌的按钮）。 */
function buttonValues(elements: object[]): AnyRec[] {
  const out: AnyRec[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as AnyRec;
    if (rec.tag === 'button' && Array.isArray(rec.behaviors)) {
      for (const b of rec.behaviors) if (b?.value) out.push(b.value);
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(elements);
  return out;
}

/** 顶层 div 的 lark_md 文案（按渲染顺序）。 */
function divContents(elements: object[]): string[] {
  const out: string[] = [];
  for (const el of elements) {
    const rec = el as AnyRec;
    if (rec.tag === 'div' && typeof rec.text?.content === 'string') out.push(rec.text.content);
  }
  return out;
}

describe('renderPermissionsApproval（ub characterization）', () => {
  it('标题 + reason + 每个权限条目的 div/按钮 + 决策按钮逐字钉住', () => {
    const view = permissionsView({ reason: 'allow once' });
    const elements = renderApprovalArea(view, { runId: 'run-1' });
    const json = JSON.stringify(elements);
    expectNoV1ActionContainer(json);

    const divs = divContents(elements);
    expect(divs[0]).toBe('**🔒 权限审批**');
    expect(divs[1]).toBe('💡 allow once');
    expect(divs[2]).toBe('✅ network');
    expect(divs[3]).toBe('⬜ fs');

    const values = buttonValues(elements);
    const toggles = values.filter((v) => v.cmd === 'approval.toggle');
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toMatchObject({
      cmd: 'approval.toggle',
      requestId: 7,
      permId: 'p1',
      selected: false,
    });
    expect(toggles[1]).toMatchObject({
      cmd: 'approval.toggle',
      requestId: 7,
      permId: 'p2',
      selected: true,
    });
    // 决策按钮：accept/decline 恒在，顺序固定
    const decisions = values.filter((v) => v.cmd === 'approval.respond');
    expect(decisions.map((d) => d.decision)).toEqual(['accept', 'decline']);
  });

  it('没有 permissions.items 时只有标题 + 决策按钮', () => {
    const elements = renderApprovalArea(permissionsView({ permissions: undefined }));
    expect(divContents(elements)).toEqual(['**🔒 权限审批**']);
    expect(buttonValues(elements).filter((v) => v.cmd === 'approval.toggle')).toHaveLength(0);
  });

  it('超过 20 条 → 省略提示逐字钉住', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({
      id: `p${i}`,
      label: `L${i}`,
      target: { kind: 'network' } as const,
      selected: false,
    }));
    const elements = renderApprovalArea(permissionsView({ permissions: { items } }));
    const json = JSON.stringify(elements);
    expect(json).toContain('_…另有 3 项权限未展示（卡片预算）_');
    expect(buttonValues(elements).filter((v) => v.cmd === 'approval.toggle')).toHaveLength(20);
  });

  it('expired → 「⏰ **审批已过期**」且无决策按钮', () => {
    const elements = renderApprovalArea(permissionsView(), { expired: true });
    expect(divContents(elements)).toContain('⏰ **审批已过期**');
    expect(buttonValues(elements).filter((v) => v.cmd === 'approval.respond')).toHaveLength(0);
  });

  it('终态（terminal=done）→ 整个审批区隐藏', () => {
    const elements = renderApprovalArea(permissionsView(), { terminal: 'done' as RunTerminal });
    expect(elements).toEqual([]);
  });

  it('deliveryError → 「⚠️ **审批提交失败**」回执', () => {
    const elements = renderApprovalArea(permissionsView({ deliveryError: 'boom' }));
    const json = JSON.stringify(elements);
    expect(json).toContain('⚠️ **审批提交失败**：boom');
    expect(json).toContain('可直接再次点击按钮重试。');
  });
});

/**
 * 兜底档紧凑审批区：公开入口 renderApprovalAreaCompact。断言用户实际看到的
 * 折叠标题 / 决策按钮 / 终态隐藏 / 体积上界，而不是内部渲染器调用次数。
 */
describe('renderApprovalAreaCompact（兜底档紧凑审批区）', () => {
  it('非提问审批：折叠标题 + reason + accept/decline 决策按钮', () => {
    const elements = renderApprovalAreaCompact(permissionsView({ reason: 'allow once' }), {
      runId: 'run-1',
    });

    const divs = divContents(elements);
    expect(divs[0]).toBe('✋ **等待审批**（内容过长已折叠，完整内容请查终端 / Web UI）');
    expect(divs).toContain('💡 allow once');
    const values = buttonValues(elements);
    expect(values.filter((v) => v.cmd === 'approval.respond').map((v) => v.decision)).toEqual([
      'accept',
      'decline',
    ]);
    expect(values[0]).toMatchObject({ requestId: 7, runId: 'run-1' });
    expectNoV1ActionContainer(JSON.stringify(elements));
  });

  it('提问审批：只保留整批「跳过回答」按钮，不渲染 accept/decline', () => {
    const view = {
      requestId: 9,
      kind: 'question',
      availableDecisions: ['accept', 'decline'],
      questions: [{ question: 'Q1', options: [{ label: 'A' }] }],
    } as unknown as ApprovalView;

    const elements = renderApprovalAreaCompact(view, { runId: 'run-1' });

    expect(divContents(elements)[0]).toContain('等待审批');
    const values = buttonValues(elements);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      cmd: 'approval.respond',
      decision: 'decline',
      requestId: 9,
      runId: 'run-1',
    });
  });

  it('提问审批 expired → 「⏰ **提问已超时**」且无任何按钮', () => {
    const view = {
      requestId: 9,
      kind: 'question',
      availableDecisions: [],
      questions: [{ question: 'Q1', options: [] }],
    } as unknown as ApprovalView;

    const elements = renderApprovalAreaCompact(view, { expired: true });

    expect(divContents(elements)).toContain('⏰ **提问已超时**');
    expect(buttonValues(elements)).toHaveLength(0);
  });

  it('终态 → 整个紧凑审批区隐藏', () => {
    expect(
      renderApprovalAreaCompact(permissionsView(), { terminal: 'done' as RunTerminal }),
    ).toEqual([]);
  });

  it('超长 reason 的紧凑产物仍保持极小体积（≤5 元素且远小于原文）', () => {
    const elements = renderApprovalAreaCompact(permissionsView({ reason: 'x'.repeat(5000) }));
    expect(elements.length).toBeLessThanOrEqual(5);
    // 5000 字符的 reason 被 capApprovalText 截断，产物不随输入线性膨胀。
    expect(JSON.stringify(elements).length).toBeLessThan(2000);
  });
});

/** kind=tool / kind=question 通过 renderApprovalArea 的查表触发。 */
describe('renderToolApproval / renderQuestionApproval（kind 渲染查表）', () => {
  function toolView(overrides: Record<string, unknown> = {}): ApprovalView {
    return {
      requestId: 11,
      kind: 'tool',
      availableDecisions: ['accept', 'decline'],
      toolName: 'bash',
      toolInput: '{"command":"ls"}',
      ...overrides,
    } as unknown as ApprovalView;
  }

  it('普通工具：标题 + 工具名 + reason + 原始 input + 决策按钮', () => {
    const elements = renderApprovalArea(toolView({ reason: 'run a command' }), {
      runId: 'run-1',
    });

    const divs = divContents(elements);
    expect(divs[0]).toBe('**🔧 工具请求**');
    expect(divs).toContain('🔧 `bash`');
    expect(divs).toContain('💡 run a command');
    expect(divs.some((d) => d.includes('command'))).toBe(true);
    expect(
      buttonValues(elements)
        .filter((v) => v.cmd === 'approval.respond')
        .map((v) => v.decision),
    ).toEqual(['accept', 'decline']);
    expectNoV1ActionContainer(JSON.stringify(elements));
  });

  it('toolInput 为 "{}" 时不展示 input 行；toolName 缺失回落到 (unknown tool)', () => {
    const noInput = renderApprovalArea(toolView({ toolInput: '{}' }));
    expect(divContents(noInput).some((d) => d.startsWith('`'))).toBe(false);

    const noName = renderApprovalArea(toolView({ toolName: undefined }));
    expect(divContents(noName)).toContain('🔧 `(unknown tool)`');
  });

  it('工具审批 expired → 「⏰ **审批已过期**」且无决策按钮', () => {
    const elements = renderApprovalArea(toolView(), { expired: true });
    expect(divContents(elements)).toContain('⏰ **审批已过期**');
    expect(buttonValues(elements).filter((v) => v.cmd === 'approval.respond')).toHaveLength(0);
  });

  it('ExitPlanMode → 计划审批区（计划全文 + 五个决策按钮）', () => {
    const elements = renderApprovalArea(
      toolView({
        toolName: 'ExitPlanMode',
        plan: '1. step one\n2. step two',
        planFilePath: '/tmp/plan.md',
        availableDecisions: [
          'accept',
          'acceptAll',
          'declineWithFeedback',
          'acceptWithFeedback',
          'decline',
        ],
      }),
      { runId: 'run-1' },
    );

    expect(divContents(elements)[0]).toBe('**📋 计划审批**');
    expect(divContents(elements).some((d) => d.includes('/tmp/plan.md'))).toBe(true);
    expect(JSON.stringify(elements)).toContain('step one');
    expect(buttonValues(elements).filter((v) => v.cmd === 'approval.respond')).toHaveLength(5);
  });

  it('提问审批：标题 + intro + 题面 + 「跳过回答」', () => {
    const view = {
      requestId: 13,
      kind: 'question',
      availableDecisions: ['accept', 'decline'],
      intro: '请选择',
      questions: [
        {
          question: '工程名？',
          header: '工程名？',
          options: [{ label: 'alpha' }, { label: 'beta' }],
        },
      ],
    } as unknown as ApprovalView;

    const elements = renderApprovalArea(view, { runId: 'run-1' });

    const json = JSON.stringify(elements);
    expect(divContents(elements)[0]).toBe('**❓ 需要你回答**');
    expect(json).toContain('📝 请选择');
    expect(json).toContain('工程名？');
    expect(json).toContain('⏭️ 跳过回答');
    expect(
      buttonValues(elements).some((v) => v.cmd === 'approval.respond' && v.decision === 'decline'),
    ).toBe(true);
    expectNoV1ActionContainer(json);
  });

  it('提问审批 expired → 「⏰ **提问已超时**」+ expiredHint，无按钮', () => {
    const view = {
      requestId: 13,
      kind: 'question',
      availableDecisions: [],
      expiredHint: '可在 Web UI 继续回答',
      questions: [{ question: 'Q', options: [] }],
    } as unknown as ApprovalView;

    const elements = renderApprovalArea(view, { expired: true });

    const divs = divContents(elements);
    expect(divs).toContain('⏰ **提问已超时**');
    expect(divs).toContain('可在 Web UI 继续回答');
    expect(buttonValues(elements)).toHaveLength(0);
  });

  it('题数超过 5 → 折叠剩余题并保留整批跳过入口', () => {
    const questions = Array.from({ length: 30 }, (_, i) => ({
      question: `Q${i}`,
      header: `Q${i}`,
      options: [{ label: 'x' }],
    }));
    const view = {
      requestId: 13,
      kind: 'question',
      availableDecisions: [],
      questions,
    } as unknown as ApprovalView;

    const json = JSON.stringify(renderApprovalArea(view));

    expect(json).toContain('题未展示');
    expect(json).toContain('⏭️ 跳过回答');
  });
});
