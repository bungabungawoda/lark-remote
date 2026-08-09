import { describe, expect, it } from 'vitest';
import { renderRunCard } from '../../../src/card/run-renderer.js';
import type { RunBlock, RunState } from '../../../src/card/run-state.js';

/**
 * P2-29 anchor: degraded path ignores showToolResult=false.
 *
 * Normal path (buildChronologicalContent) computes `showResult = options.showToolResult !== false`
 * and passes it to renderTool → toolBodyMd({ ...tool, output: undefined }) when false.
 * But buildDegradedElements (line ~319) and buildExtremeFallbackElements (line ~425)
 * hardcode `renderTool(group.tool, true, true)` — showResult always true.
 *
 * This test builds a RunState large enough to trigger the degraded path (estimate
 * ≥ DEGRADED_THRESHOLD=24000), with a tool whose output contains a unique marker.
 * With showToolResult:false the output should be hidden, but the bug makes it
 * appear → RED.
 */
describe('P2-29 degraded path ignores showToolResult', () => {
  it('test_anchor_degraded_path_hides_tool_output_when_showtoolresult_false', () => {
    const UNIQUE_OUTPUT_MARKER = 'UNIQUE_OUTPUT_MARKER_P2_29_XYZ';

    const state: RunState = {
      runId: 'run-p2-29',
      terminal: 'done',
      footer: null,
      blocks: [] as RunBlock[],
      sessionId: 's-p2-29',
      resultSubtype: 'success',
    };

    // 7 thinking blocks with large content to push estimate over DEGRADED_THRESHOLD
    for (let i = 0; i < 7; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'x'.repeat(2500),
        active: false,
        timestamp: `2026-08-04T10:0${i}:00.000Z`,
      });
    }

    // 5 tool blocks with large output — ensures normal-path estimate stays
    // above DEGRADED_THRESHOLD. The last tool carries the unique marker in
    // its output so we can detect whether output was rendered.
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-p2-29-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: i === 4 ? UNIQUE_OUTPUT_MARKER + 'o'.repeat(3000) : 'o'.repeat(3500),
          status: 'ok',
          startedAt: '2026-08-04T10:10:00.000Z',
          completedAt: '2026-08-04T10:11:00.000Z',
        },
      });
    }

    // Large text block
    state.blocks.push({
      kind: 'text',
      content: '重要输出必须保留。' + 'T'.repeat(8000),
      timestamp: '2026-08-04T10:30:00.000Z',
    });

    // Render with showToolResult:false — output should be hidden
    const card = renderRunCard(state, { showToolResult: false });
    const json = JSON.stringify(card);

    // Sanity: card must fit within budget (degraded path triggered)
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28_000);

    // Sanity: degraded path WAS triggered — omission hint for thinking present
    expect(json).toMatch(/个早期思考已省略/);

    // The tool's command (input) should still be visible (showToolUse default true)
    expect(json).toContain('cmd4');

    // BUG (P2-29): degraded path hardcodes showResult=true, so the unique
    // output marker leaks into the card even though showToolResult:false.
    // When fixed, output is hidden → marker absent → test passes (GREEN).
    expect(json).not.toContain(UNIQUE_OUTPUT_MARKER);
  });
});
