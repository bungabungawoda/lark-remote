/**
 * 结构等价拆分 characterization（card 渲染层）。
 *
 * 钉住 card-budget.ts / run-state.ts 目标函数的**当前输出**：
 *   - enforceCardBudget → enforceByteBudget / enforceElementBudget 的各降级阶段
 *     （reason 拼接顺序、wasTruncated、bytes、卡片形状、截断长度、hint 文案）
 *   - reduceRunState → reduceRunStateInner 的事件分发 + reduceTurnDiffEvent 的
 *     五个字段分支（text / reasoning / toolOutput / plan / fileChanges）
 *
 * 快照由 `vitest -u` 从当前实现生成；拆分后不带 -u 重跑，快照必须逐字不变。
 * 动态字段（startedAt / finishedAt）在 stableState 里剔除，保证跨运行稳定。
 */
import { describe, it, expect } from 'vitest';
import { enforceCardBudget, countCardElements, MAX_CARD_ELEMENTS } from './card-budget.js';
import { CARD_BUDGET_BYTES } from './text-truncate.js';
import { createInitialRunState, reduceRunState, type RunState } from './run-state.js';

type AnyRec = Record<string, any>;

function div(content: string): AnyRec {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function panel(content: string): AnyRec {
  return {
    tag: 'collapsible_panel',
    header: { title: { tag: 'markdown', content: 'P' } },
    elements: [div(content)],
  };
}

function card(elements: AnyRec[]): AnyRec {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'T' } },
    body: { elements },
  };
}

/** 把预算结果压成紧凑但信息完整的可快照结构（超长重复正文只记长度+头部）。 */
function budgetSummary(result: ReturnType<typeof enforceCardBudget>): unknown {
  const c = result.card as { body?: { elements?: AnyRec[] } };
  const els = c.body?.elements ?? [];
  const textShape = (t: unknown): unknown =>
    typeof t === 'string' ? { len: t.length, head: t.slice(0, 32) } : null;
  return {
    wasTruncated: result.wasTruncated,
    reason: result.reason ?? null,
    bytesBefore: result.bytesBefore,
    bytesAfter: result.bytesAfter,
    elementCount: countCardElements(result.card),
    topTags: els.map((e) => e.tag),
    topTexts: els.map((e) => textShape(e.text?.content)),
    panelInners: els
      .filter((e) => e.tag === 'collapsible_panel')
      .map((p) => (p.elements ?? []).map((i: AnyRec) => textShape(i.text?.content))),
  };
}

describe('structure equivalence: card budget degrade stages', () => {
  it('A: 达标卡片原样返回', () => {
    expect(budgetSummary(enforceCardBudget(card([div('small')])))).toMatchSnapshot();
  });

  it('B: 单个超大 div 字节超限 → 阶段4 顶层文本截断', () => {
    const c = card([div('X'.repeat(CARD_BUDGET_BYTES + 4000))]);
    expect(budgetSummary(enforceCardBudget(c))).toMatchSnapshot();
  });

  it('C: 多个超限面板 → 阶段1 面板内容截断 + 阶段2 面板数量限制', () => {
    const els = Array.from({ length: 12 }, (_, i) => panel(`P${i}:${'y'.repeat(3000)}`));
    expect(budgetSummary(enforceCardBudget(card(els)))).toMatchSnapshot();
  });

  it('D: 元素总数超限但字节达标 → 阶段4.5 丢弃最旧元素', () => {
    const els = Array.from({ length: MAX_CARD_ELEMENTS + 5 }, (_, i) => div(`d${i}`));
    expect(budgetSummary(enforceCardBudget(card(els)))).toMatchSnapshot();
  });

  it('E: 骨架自身超限 → 阶段5 extreme_fallback 最小卡', () => {
    const els = Array.from({ length: 3 }, (_, i) => div(`e${i}:${'z'.repeat(30000)}`));
    expect(
      budgetSummary(enforceCardBudget(card(els), { maxPanelContentBytes: 50000 })),
    ).toMatchSnapshot();
  });

  it('F: table 数量超限但卡整体达标 → table_count_limited', () => {
    const tbl = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    const els = Array.from({ length: 6 }, (_, i) => div(`t${i}\n${tbl}`));
    expect(budgetSummary(enforceCardBudget(card(els)))).toMatchSnapshot();
  });

  it('G: table 超限且字节超限 → cap 后继续走字节降级', () => {
    const tbl = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    const els = Array.from({ length: 6 }, (_, i) => div(`t${i}\n${tbl}${'q'.repeat(6000)}`));
    expect(budgetSummary(enforceCardBudget(card(els)))).toMatchSnapshot();
  });
});

/** 剔除 Date.now() 派生的动态时间戳。 */
function stableState(state: RunState): Omit<RunState, 'startedAt' | 'finishedAt'> {
  const { startedAt: _startedAt, finishedAt: _finishedAt, ...rest } = state;
  return rest;
}

describe('structure equivalence: run state reducers', () => {
  it('钉住 reduceRunStateInner 全事件分发 + reduceTurnDiffEvent 全字段分支', () => {
    let s = createInitialRunState('run-ub');
    const step = (label: string, ev: unknown): void => {
      s = reduceRunState(s, ev as never);
      expect(stableState(s)).toMatchSnapshot(label);
    };

    step('init', {
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      cwd: '/w',
      model: 'm',
    });
    step('goal_state', {
      type: 'goal_state',
      goal: { phase: 'active', text: 'ship it', currentTurn: 1, totalTurns: 2 },
      known: true,
    });
    step('background_jobs', {
      type: 'background_jobs',
      jobs: [{ id: 'j1', label: 'L', status: 'running' }],
    });
    step('run_status', {
      type: 'run_status',
      contextUsed: 100,
      contextLimit: 1000,
      steps: 3,
      toolMs: 50,
    });
    step('notice', {
      type: 'notice',
      level: 'warn',
      code: 'c',
      text: 'n',
      timestamp: 'T0',
    });
    step('session_info', { type: 'session_info', title: 'T', mode: 'plan' });
    step('turn_started', {
      type: 'turn_started',
      threadId: 'th',
      turnId: 'tn',
      operationKind: 'turn',
    });
    step('turn_diff text 首见', {
      type: 'turn_diff',
      itemId: 'i-text',
      text: 'hello',
      threadId: 'th',
      turnId: 'tn',
      timestamp: 'T1',
    });
    step('turn_diff text 更新+complete+refreshTimestamp', {
      type: 'turn_diff',
      itemId: 'i-text',
      text: 'hello world',
      refreshTimestamp: true,
      complete: true,
      threadId: 'th',
      turnId: 'tn',
      timestamp: 'T2',
    });
    step('turn_diff reasoning', {
      type: 'turn_diff',
      itemId: 'i-reason',
      reasoning: 'thinking hard',
      threadId: 'th',
      turnId: 'tn',
      timestamp: 'T3',
    });
    step('turn_diff toolOutput 首见', {
      type: 'turn_diff',
      itemId: 'i-tool',
      toolOutput: 'out',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolHint: 'shell',
      threadId: 'th',
      turnId: 'tn',
      timestamp: 'T4',
    });
    step('turn_diff toolOutput complete', {
      type: 'turn_diff',
      itemId: 'i-tool',
      toolOutput: 'done',
      complete: true,
      toolStatus: 'ok',
      threadId: 'th',
      turnId: 'tn',
      timestamp: 'T5',
    });
    step('turn_diff plan', {
      type: 'turn_diff',
      itemId: 'i-plan',
      plan: 'PLAN',
      threadId: 'th',
      turnId: 'tn',
      timestamp: 'T6',
    });
    step('turn_diff fileChanges', {
      type: 'turn_diff',
      itemId: 'i-fc',
      fileChanges: [
        { path: 'a.ts', kind: 'add', diff: 'D' },
        { path: 'b.ts', kind: 'delete' },
      ],
      threadId: 'th',
      turnId: 'tn',
      timestamp: 'T7',
    });
    step('turn_diff 多字段组合', {
      type: 'turn_diff',
      itemId: 'i-combo',
      text: 'T',
      reasoning: 'R',
      plan: 'P',
      threadId: 'th',
      turnId: 'tn',
      timestamp: 'T8',
    });
    step('approval_requested', {
      type: 'approval_requested',
      requestId: 1,
      kind: 'command',
      threadId: 'th',
      turnId: 'tn',
      itemId: 'i-ap',
      view: {
        requestId: 1,
        kind: 'command',
        command: 'x',
        commandCwd: '/w',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    });
    step('approval_view_updated', {
      type: 'approval_view_updated',
      requestId: 1,
      view: {
        requestId: 1,
        kind: 'command',
        command: 'y',
        commandCwd: '/w',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    });
    step('approval_expired', { type: 'approval_expired', requestId: 1 });
    step('approval_resolved', { type: 'approval_resolved', requestId: 1, outcome: 'resolved' });
    step('result', { type: 'result', subtype: 'success', session_id: 's1', timestamp: 'T9' });
  });
});
