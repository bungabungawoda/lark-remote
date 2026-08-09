import { describe, expect, it } from 'vitest';
import { renderRunCard } from '../../src/card/run-renderer.js';
import type { RunState } from '../../src/card/run-state.js';

/**
 * ADVERSARIAL PROBE — 攻击 renderRunCard 的 ≤28KB 不变量。
 *
 * P1-2 引入 estimateCardBytes 廉价估算 + DEGRADED_THRESHOLD=24000 阈值，用估算
 * 决定走正常路径还是 degraded。估算用 ESTIMATE_ESCAPE_FACTOR=1.2 覆盖 JSON 转义
 * 膨胀，但真实转义对 \n → \\n 是 2× 膨胀，对 " → \" 也是 2×。若 content 高密度
 * 转义字符，估算的 1.2 因子严重低估真实 stringify 体积。
 *
 * 安全网理论：估算低估 → 走正常路径 → stringify 兜底发现 >28KB → fallthrough
 * degraded/extreme → 最终 ≤28KB。本 probe 用病态输入验证这条安全网在极端转义
 * 膨胀下**真的兜得住**——任一产出 >28KB 即暴露安全网漏洞（真 bug）。
 *
 * 攻击向量：
 * ① 100% \n 文本（转义 2×），非连续（间插 tool 阻止 groupBlocks 合并）最大化膨胀
 * ② 100% " 文本（转义 2×）
 * ③ 满命令(600) + 满输出(1200) 的 tool 堆叠
 * ④ 极端组合：高转义 text + 大量 thinking + 大量 tool 同时存在
 */

function baseState(): RunState {
  return {
    runId: 'run-adversarial',
    terminal: 'done',
    footer: null,
    blocks: [],
    sessionId: 's-adv',
    resultSubtype: 'success',
  };
}

function assertWithinBudget(state: RunState, label: string) {
  const card = renderRunCard(state);
  const json = JSON.stringify(card);
  const bytes = Buffer.byteLength(json, 'utf8');
  expect(bytes, `${label} = ${bytes} bytes exceeds 28KB budget`).toBeLessThanOrEqual(28_000);
}

describe('renderRunCard ≤28KB invariant under pathological inputs', () => {
  it('all-newline text blocks separated by tools (max escape inflation, no merge)', () => {
    const state = baseState();
    // 4 个 6000-\n 文本块，间插 tool 阻止 groupBlocks 合并
    // 真实：每块 6000 \n → 12000 \\n，4 块 = 48000 + 结构 → 远超 28KB
    for (let i = 0; i < 4; i++) {
      state.blocks.push({
        kind: 'text',
        content: '\n'.repeat(6000),
        timestamp: `2026-07-30T14:0${i}:00.000Z`,
      });
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-nl-' + i,
          name: 'Bash',
          input: { command: 'echo ' + i },
          output: 'ok',
          status: 'ok',
          startedAt: '2026-07-30T14:10:00.000Z',
          completedAt: '2026-07-30T14:11:00.000Z',
        },
      });
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
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-q-' + i,
          name: 'Read',
          input: { file_path: 'a' + i + '.ts' },
          output: 'x',
          status: 'ok',
          startedAt: '2026-07-30T15:10:00.000Z',
          completedAt: '2026-07-30T15:11:00.000Z',
        },
      });
    }
    assertWithinBudget(state, 'all-quote text × tool-separated');
  });

  it('max command (600) + max output (1200) tools stacked', () => {
    const state = baseState();
    for (let i = 0; i < 8; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-max-' + i,
          name: 'Bash',
          input: { command: 'c'.repeat(600) },
          output: 'o'.repeat(1200),
          status: 'ok',
          startedAt: '2026-07-30T16:0${i}:00.000Z'.replace('${i}', String(i)),
          completedAt: '2026-07-30T16:11:00.000Z',
        },
      });
    }
    assertWithinBudget(state, 'max-command+output tools × 8');
  });

  it('extreme combo: high-escape text + large thinking + max tools', () => {
    const state = baseState();
    // 高转义文本（非连续）
    for (let i = 0; i < 3; i++) {
      state.blocks.push({
        kind: 'text',
        content: '\n'.repeat(4000) + '"'.repeat(2000),
        timestamp: `2026-07-30T17:0${i}:00.000Z`,
      });
      // 大 thinking
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + i + '\n'.repeat(4000),
        active: false,
        timestamp: `2026-07-30T17:1${i}:00.000Z`,
      });
      // 满 tool
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-combo-' + i,
          name: 'Bash',
          input: { command: 'cmd-' + i + '-' + 'c'.repeat(590) },
          output: 'o'.repeat(1200),
          status: 'ok',
          startedAt: '2026-07-30T17:20:00.000Z',
          completedAt: '2026-07-30T17:21:00.000Z',
        },
      });
    }
    assertWithinBudget(state, 'extreme combo high-escape+thinking+tools');
  });

  it('all-backslash text (escapeMarkdown doubles, then JSON.stringify doubles again = 4×)', () => {
    const state = baseState();
    // escapeMarkdown 把 \ → \\，JSON.stringify 再把 \\ → \\\\ = 4× 膨胀
    // 估算的 1.2 因子严重低估。非连续间插 tool。
    for (let i = 0; i < 4; i++) {
      state.blocks.push({
        kind: 'text',
        content: '\\'.repeat(5000),
        timestamp: `2026-07-30T18:0${i}:00.000Z`,
      });
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-bs-' + i,
          name: 'Bash',
          input: { command: 'ls' },
          output: 'done',
          status: 'ok',
          startedAt: '2026-07-30T18:10:00.000Z',
          completedAt: '2026-07-30T18:11:00.000Z',
        },
      });
    }
    assertWithinBudget(state, 'all-backslash text 4× inflation × tool-separated');
  });
});
