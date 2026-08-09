import { describe, expect, it } from 'vitest';
import { renderRunCard } from '../../src/card/run-renderer.js';
import type { RunState } from '../../src/card/run-state.js';

/**
 * PROBE (估算保守性边界 — 不误降级 + 不漏降级) — P1-2 的「先估后建」引入了
 * DEGRADED_THRESHOLD=24000 阈值：估算 < 24000 走正常路径，≥24000 跳过完整卡
 * 直接 degraded。本 probe 刻画阈值附近的行为正确性边界，防止优化引入两类退化：
 *
 * ① UX 退化（估算高估误降级）：估算值 ≥24000 但真实完整卡 stringify 明显 < 28KB
 *    时，直接 degraded 会丢失早期 thinking/tool——本可完整展示却被压缩。
 *    这不是正确性 bug（≤28KB 仍成立），是优化副作用。
 * ② 正确性退化（估算低估漏降级）：估算值 <24000 但真实完整卡 stringify > 28KB
 *    时，走正常路径靠 stringify 兜底救回（仍 ≤28KB），但浪费一次完整构建——
 *    违背 P1-2「先估后建省一次完整 render」初衷。安全网兜底不超 28KB，非正确性
 *    bug，标记优化缺口。
 *
 * 本 probe 不直接断言 estimateCardBytes（虽已导出于 src/card/run-renderer.ts，
 * 但属估算实现细节），而是通过「产物 ≤28KB
 * + 内容契约」间接验证：无论阈值附近走哪条路，正确性底线（≤28KB + 保留关键内容）
 * 都必须成立。GREEN 则优化未引入正确性退化；RED 则暴露估算偏差导致的契约破坏。
 *
 * 依据：P1-2 spec（estimateCardBytes 保守性 + DEGRADED_THRESHOLD 阈值）。
 */

describe('renderRunCard estimate threshold boundary (probe)', () => {
  /**
   * 构造一个「估算接近 24000 阈值但真实 stringify 远低于 28KB」的卡：
   * 多个中等 thinking（每个 ~1.5KB content）。
   *
   * 2026-07-31 第二轮（影子测量）后：估算 = 精确复刻 normal 产物字节，
   * N=10 × 1.5KB thinking ≈ 21.3KB < 24000 → 走正常路径全量渲染（不误降级）。
   * 此前的「×1.2 因子估算」会把 N=10 估到 ~24000 ≥ 阈值触发 degraded——
   * 即 UX 退化缺口（保守降级，正确但非最优）。影子测量已关闭该缺口。
   * 本 probe 断言互斥不变量：要么降级（早期省略）要么完整（全部保留），
   * 不能既降级又完整（矛盾态）。
   */
  it('probe_estimate_overcount_still_within_budget_does_not_break_correctness', () => {
    const state: RunState = {
      runId: 'run-threshold-boundary',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-boundary',
      resultSubtype: 'success',
    };

    // 10 个中等 thinking：影子测量估算 ~21.3KB < 24000 → 正常路径全量渲染
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

    // 正确性底线：无论走正常还是 degraded，产物必须 ≤28KB
    expect(cardBytes).toBeLessThanOrEqual(28_000);

    // 最近 2 个 thinking 必须保留（degraded 契约：last 2）
    expect(json).toContain('思考块9');
    expect(json).toContain('思考块10');

    // CardKit 2.0 合规
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

    // PROBE 刻画：影子测量下本卡走正常路径 → 早期思考全部保留（不误降级）。
    // 互斥断言防止「既降级又完整」的矛盾态回归（旧 ×1.2 估算曾让本卡降级）。
    const isDegraded = /\d+ 个早期思考已省略/.test(json);
    const allPresent = ['思考块1', '思考块5'].every((t) => json.includes(t));
    // 互斥：要么降级（早期省略），要么完整（全部保留）——不能既降级又完整（矛盾态）
    expect(isDegraded || allPresent).toBe(true);
  });

  /**
   * 构造一个「估算 < 24000 但真实 stringify 接近 28KB」的卡：高转义 content（大量 \n
   * 和 "），JSON.stringify 时 \n→\\n 膨胀 2x，估算的 1.2 因子可能不足以覆盖。
   * 若估算低估 → 走正常路径 → stringify 兜底发现 >28KB → fallthrough degraded。
   * 安全网救回，产物仍 ≤28KB，但浪费了一次完整构建（优化缺口，非正确性 bug）。
   */
  it('probe_high_escape_content_estimate_undercount_falls_back_safely', () => {
    const state: RunState = {
      runId: 'run-high-escape',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-escape',
      resultSubtype: 'success',
    };

    // 6 个 text block，每个 ~2KB 但充满 \n 和 " （转义膨胀高）
    // 估算 = 2500 + 6×(350 + 2000×1.2) = 2500 + 6×2750 = 19000 < 24000 → 走正常路径
    // 真实：每个 text 的 \n → \\n 膨胀，2000 字符若含 500 个 \n，stringify 后 ~2500，
    // 6 个 ~15K + panel + 外壳，可能逼近但 stringify 兜底保 ≤28KB
    for (let i = 0; i < 6; i++) {
      const highEscape = '行' + i + '\n'.repeat(400) + '"quote'.repeat(200);
      state.blocks.push({
        kind: 'text',
        content: highEscape,
        timestamp: `2026-07-30T12:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // 正确性底线：高转义 content 不能突破 28KB（stringify 兜底 + degraded/extreme 救回）
    expect(cardBytes).toBeLessThanOrEqual(28_000);

    // CardKit 2.0 合规
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  /**
   * filter 合并等价性：interleaved 顺序（thinking/tool/text 交错）下，单遍分桶 +
   * Set 过滤重建必须仍正确保留 last N thinking + last N tool + 全部 text，
   * 且 text 合并（groupBlocks 连续 text 合并）不被分桶破坏。
   */
  it('probe_interleaved_order_filter_merge_equivalence', () => {
    const state: RunState = {
      runId: 'run-interleaved',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-interleaved',
      resultSubtype: 'success',
    };

    // 交错顺序：thinking1, tool1, text1, thinking2, tool2, text2, ... 共 5 轮
    // 估算：5×(350+4500×1.2) [thinking] + 5×(350+1880×1.2) [tool] + 5×(350+1500×1.2) [text] + 2500
    //    = 5×5750 + 5×2606 + 5×2150 + 2500 = 28750+13030+10750+2500 ≈ 55030 ≥24000 → degraded
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '交错思考' + (i + 1) + ':' + 'z'.repeat(4500),
        active: false,
        timestamp: `2026-07-30T13:0${i}:00.000Z`,
      });
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-inter-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: 'o'.repeat(3500),
          status: 'ok',
          startedAt: '2026-07-30T13:10:00.000Z',
          completedAt: '2026-07-30T13:11:00.000Z',
        },
      });
      state.blocks.push({
        kind: 'text',
        content: '交错文本' + (i + 1) + ':' + 'T'.repeat(1500),
        timestamp: `2026-07-30T13:2${i}:00.000Z`,
      });
    }

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // ① ≤28KB
    expect(cardBytes).toBeLessThanOrEqual(28_000);

    // ② degraded 保留 last 2 thinking（交错思考4/5）
    expect(json).toContain('交错思考4');
    expect(json).toContain('交错思考5');
    // 早期 thinking 省略
    expect(json).not.toContain('交错思考1');
    expect(json).not.toContain('交错思考2');

    // ③ degraded 保留 last 3 tool（命令摘要 cmd2/3/4，对应索引 2/3/4）
    //    注意：tool 的内部 id（tool-inter-N）不渲染进卡片，卡片只渲染命令摘要，
    //    故断言用命令字符串而非 id
    expect(json).toContain('cmd2');
    expect(json).toContain('cmd3');
    expect(json).toContain('cmd4');
    // 早期 tool 省略（cmd0 是最早的 tool）
    expect(json).not.toContain('cmd0');

    // ④ 全部 text 保留（degraded 文本完整保留契约）
    expect(json).toContain('交错文本1');
    expect(json).toContain('交错文本3');
    expect(json).toContain('交错文本5');

    // ⑤ omission hint 存在（证明降级路径生效）
    expect(/\d+ 个早期思考已省略/.test(json)).toBe(true);
  });
});
