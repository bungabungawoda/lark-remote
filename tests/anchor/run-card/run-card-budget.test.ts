/**
 * renderRunCard ≤28KB 预算不变量：病态转义输入、估算阈值附近行为、
 * 交错顺序下的降级保留契约。
 *
 * 合并自 run-card-budget-invariant-adversarial / run-card-estimate-threshold。
 */
import { describe, expect, it } from 'vitest';
import { renderRunCard } from '../../../src/card/run-renderer.js';
import type { RunState } from '../../../src/card/run-state.js';
import { expectNoV1ActionContainer } from '../../lib/card-view.js';

function baseState(runId = 'run-adversarial'): RunState {
  return {
    runId,
    terminal: 'done',
    footer: null,
    blocks: [],
    sessionId: 's-adv',
    resultSubtype: 'success',
  };
}

function assertWithinBudget(state: RunState, label: string): string {
  const card = renderRunCard(state);
  const json = JSON.stringify(card);
  const bytes = Buffer.byteLength(json, 'utf8');
  expect(bytes, `${label} = ${bytes} bytes exceeds 28KB budget`).toBeLessThanOrEqual(28_000);
  return json;
}

function toolBlock(id: string, command: string, output: string, ts = '2026-07-30T14:10:00.000Z') {
  return {
    kind: 'tool' as const,
    tool: {
      id,
      name: 'Bash',
      input: { command },
      output,
      status: 'ok' as const,
      startedAt: ts,
      completedAt: '2026-07-30T14:11:00.000Z',
    },
  };
}

describe('renderRunCard budget invariants', () => {
  it('all-newline text blocks separated by tools (max escape inflation, no merge)', () => {
    const state = baseState();
    for (let i = 0; i < 4; i++) {
      state.blocks.push({
        kind: 'text',
        content: '\n'.repeat(6000),
        timestamp: `2026-07-30T14:0${i}:00.000Z`,
      });
      state.blocks.push(toolBlock('tool-nl-' + i, 'echo ' + i, 'ok'));
    }
    assertWithinBudget(state, 'all-newline text × tool-separated');
  });

  it('all-double-quote text blocks (escape inflation, no merge)', () => {
    const state = baseState();
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'text',
        content: '"'.repeat(5000),
        timestamp: `2026-07-30T15:0${i}:00.000Z`,
      });
      state.blocks.push(
        toolBlock('tool-q-' + i, 'a' + i + '.ts', 'x', `2026-07-30T15:1${0}:00.000Z`),
      );
    }
    assertWithinBudget(state, 'all-quote text × tool-separated');
  });

  it('max command (600) + max output (1200) tools stacked', () => {
    const state = baseState();
    for (let i = 0; i < 8; i++) {
      state.blocks.push(
        toolBlock(
          'tool-max-' + i,
          'c'.repeat(600),
          'o'.repeat(1200),
          `2026-07-30T16:0${i}:00.000Z`,
        ),
      );
    }
    assertWithinBudget(state, 'max-command+output tools × 8');
  });

  it('extreme combo: high-escape text + large thinking + max tools', () => {
    const state = baseState();
    for (let i = 0; i < 3; i++) {
      state.blocks.push({
        kind: 'text',
        content: '\n'.repeat(4000) + '"'.repeat(2000),
        timestamp: `2026-07-30T17:0${i}:00.000Z`,
      });
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + i + '\n'.repeat(4000),
        active: false,
        timestamp: `2026-07-30T17:1${i}:00.000Z`,
      });
      state.blocks.push(
        toolBlock(
          'tool-combo-' + i,
          'c'.repeat(590),
          'o'.repeat(1200),
          `2026-07-30T17:2${i}:00.000Z`,
        ),
      );
    }
    assertWithinBudget(state, 'extreme combo high-escape+thinking+tools');
  });

  it('all-backslash text (escapeMarkdown doubles, then JSON.stringify doubles again = 4×)', () => {
    const state = baseState();
    for (let i = 0; i < 4; i++) {
      state.blocks.push({
        kind: 'text',
        content: '\\'.repeat(5000),
        timestamp: `2026-07-30T18:0${i}:00.000Z`,
      });
      state.blocks.push(toolBlock('tool-bs-' + i, 'ls', 'done', `2026-07-30T18:1${0}:00.000Z`));
    }
    assertWithinBudget(state, 'all-backslash text 4× inflation × tool-separated');
  });

  // ── 估算阈值边界 ─────────────────────────────────────────────────
  it('test_anchor_estimate_overcount_still_within_budget_does_not_break_correctness', () => {
    const state = baseState('run-threshold-boundary');
    for (let i = 0; i < 10; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考块' + (i + 1) + '内容' + 'y'.repeat(1500),
        active: false,
        timestamp: `2026-07-30T11:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    expect(cardBytes).toBeLessThanOrEqual(28_000);
    expect(json).toContain('思考块9');
    expect(json).toContain('思考块10');
    expectNoV1ActionContainer(json);

    // 互斥：要么降级（早期省略），要么完整（全部保留）——不能既降级又完整。
    const isDegraded = /\d+ 个早期思考已省略/.test(json);
    const allPresent = ['思考块1', '思考块5'].every((t) => json.includes(t));
    expect(isDegraded || allPresent).toBe(true);
  });

  it('test_anchor_high_escape_content_estimate_undercount_falls_back_safely', () => {
    const state = baseState('run-high-escape');
    for (let i = 0; i < 6; i++) {
      state.blocks.push({
        kind: 'text',
        content: '行' + i + '\n'.repeat(400) + '"quote'.repeat(200),
        timestamp: `2026-07-30T12:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(28_000);
    expectNoV1ActionContainer(json);
  });

  it('test_anchor_interleaved_order_filter_merge_equivalence', () => {
    const state = baseState('run-interleaved');
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '交错思考' + (i + 1) + ':' + 'z'.repeat(4500),
        active: false,
        timestamp: `2026-07-30T13:0${i}:00.000Z`,
      });
      state.blocks.push(
        toolBlock('tool-inter-' + i, 'cmd' + i, 'o'.repeat(3500), `2026-07-30T13:1${0}:00.000Z`),
      );
      state.blocks.push({
        kind: 'text',
        content: '交错文本' + (i + 1) + ':' + 'T'.repeat(1500),
        timestamp: `2026-07-30T13:2${i}:00.000Z`,
      });
    }

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(28_000);

    // degraded 保留 last 2 thinking（交错思考4/5），早期省略。
    expect(json).toContain('交错思考4');
    expect(json).toContain('交错思考5');
    expect(json).not.toContain('交错思考1');
    expect(json).not.toContain('交错思考2');

    // degraded 保留 last 3 tool（cmd2/3/4），最早 cmd0 省略。
    expect(json).toContain('cmd2');
    expect(json).toContain('cmd3');
    expect(json).toContain('cmd4');
    expect(json).not.toContain('cmd0');

    // 全部 text 保留。
    expect(json).toContain('交错文本1');
    expect(json).toContain('交错文本3');
    expect(json).toContain('交错文本5');

    expect(/\d+ 个早期思考已省略/.test(json)).toBe(true);
  });
});

describe('run card 28KB budget - plan/file_change', () => {
  it('fits within 28KB with 20 file changes', () => {
    const state = baseState('run-budget-filechange');
    for (let i = 0; i < 20; i++) {
      state.blocks.push({
        kind: 'file_change',
        path: `/src/components/Component${i}.tsx`,
        operation: 'edit',
        diff: `--- a/src/components/Component${i}.tsx\n+++ b/src/components/Component${i}.tsx\n@@ -1,5 +1,7 @@\n+// Added import\n import { useState } from 'react';\n \n export function Component${i}() {\n-  return <div>Old</div>;\n+  return <div>New</div>;\n }\n`,
      });
    }

    const json = JSON.stringify(renderRunCard(state, { agentKind: 'claude' }));
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(28_000);
  });

  it('fits within 28KB with multiple plan events', () => {
    const state = baseState('run-budget-plan');
    for (let i = 0; i < 10; i++) {
      const step = `Step ${i + 1}: Perform some analysis and make decisions about the codebase structure.\nThis is a detailed plan step that explains what the agent will do.`;
      state.blocks.push({
        kind: 'plan',
        content: state.plan ? state.plan + step : step,
        active: false,
      });
      state.plan = state.plan ? state.plan + step : step;
    }

    const json = JSON.stringify(renderRunCard(state, { agentKind: 'codex' }));
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(28_000);
  });
});
