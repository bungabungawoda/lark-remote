import { describe, expect, it } from 'vitest';
import { createInitialRunState, reduceRunState } from '../../src/card/run-state.js';
import { renderRunCard } from '../../src/card/run-renderer.js';

describe('Anchor: multiple thinking events create separate blocks', () => {
  /**
   * RED: Current implementation accumulates all thinking content into a single
   * `state.reasoning.content` string. Multiple thinking events (e.g. thinking1
   * → text → thinking2) get merged into one monolithic reasoning block,
   * losing temporal ordering with text and tool blocks.
   *
   * Expected behavior: each thinking event should produce a separate
   * `{ kind: 'thinking', content, active, timestamp }` block in the
   * `state.blocks` array, interleaved with text/tool blocks in the order
   * they occurred. The `state.reasoning` top-level field should not exist
   * or should not carry thinking content.
   */
  it('test_anchor_multiple_thinking_events_create_separate_blocks', () => {
    let state = createInitialRunState('run-1');

    // First assistant message: thinking1 + text1
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'first reasoning step' },
          { type: 'text', text: 'first answer part' },
        ],
      },
      timestamp: '2026-06-27T10:00:00Z',
    });

    // Second assistant message: thinking2 + text2 + tool_use
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'second reasoning step' },
          { type: 'text', text: 'second answer part' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'a' } },
        ],
      },
      timestamp: '2026-06-27T10:01:00Z',
    });

    // ASSERTION 1: There must be two separate thinking blocks in blocks array
    const thinkingBlocks = state.blocks.filter((b) => b.kind === 'thinking');
    expect(thinkingBlocks.length).toBe(2);

    // ASSERTION 2: Thinking blocks must appear in temporal order interleaved with text/tool
    // Expected block order: thinking1, text1, thinking2, text2, tool
    expect(state.blocks[0]).toMatchObject({
      kind: 'thinking',
      content: 'first reasoning step',
    });
    expect(state.blocks[1]).toMatchObject({
      kind: 'text',
      content: 'first answer part',
    });
    expect(state.blocks[2]).toMatchObject({
      kind: 'thinking',
      content: 'second reasoning step',
    });
    expect(state.blocks[3]).toMatchObject({
      kind: 'text',
      content: 'second answer part',
    });
    expect(state.blocks[4]).toMatchObject({
      kind: 'tool',
      tool: { id: 'tool-1', name: 'Read' },
    });

    // ASSERTION 3: The top-level `reasoning` field should not contain
    // accumulated thinking content — thinking lives in blocks now.
    // Either the field is removed, or it no longer holds the concatenated
    // thinking text.
    expect(state.reasoning?.content).toBeFalsy();
  });
});

describe('Anchor: renderer produces separate collapsible panels per thinking block', () => {
  /**
   * When RunState has multiple thinking blocks interleaved with text blocks,
   * renderRunCard produces:
   * - collapsible_panel for each thinking block (title: 💭 **思考中/思考完成**)
   * - collapsible_panel for each text block in running/finalizing state (title: 💬 **输出**)
   *
   * In terminal (done/error/interrupted/idle_timeout) state, text blocks render
   * as flat markdownDiv (no panel), so only thinking panels appear.
   * This test uses running state where both kinds are collapsible_panel.
   *
   * Each thinking panel: collapsed when inactive (text came after).
   * Each text panel: expanded (running state, visible output).
   */
  it('test_anchor_render_produces_collapsible_panels_per_thinking_block', () => {
    let state = createInitialRunState('run-render');

    // First assistant: thinking (active) + text
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'analyzing the problem' },
          { type: 'text', text: 'here is my answer' },
        ],
      },
      timestamp: '2026-06-27T10:00:00Z',
    });

    // Second assistant: thinking (active) + text
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'revising my approach' },
          { type: 'text', text: 'revised answer' },
        ],
      },
      timestamp: '2026-06-27T10:01:00Z',
    });

    const card = renderRunCard(state) as {
      body?: { elements?: Array<Record<string, unknown>> };
    };

    // CardKit 2.0: elements are in card.body.elements
    const elements = card.body?.elements ?? [];

    // Find all collapsible_panel elements
    const allPanels = elements.filter((el) => el.tag === 'collapsible_panel');

    // Classify panels by their title content (title is in header.title.content)
    const thinkingPanels = allPanels.filter((el) => {
      const titleContent =
        (el as { header?: { title?: { content?: string } } }).header?.title?.content ?? '';
      return titleContent.includes('思考');
    });
    const outputPanels = allPanels.filter((el) => {
      const titleContent =
        (el as { header?: { title?: { content?: string } } }).header?.title?.content ?? '';
      return titleContent.includes('输出');
    });

    // ASSERTION 1: Two thinking blocks → two panels with '思考' in title
    expect(thinkingPanels.length).toBe(2);

    // ASSERTION 2: Two text blocks in running state → two panels with '输出' in title
    // (Current design: running/finalizing text blocks are wrapped in collapsible_panel)
    expect(outputPanels.length).toBe(2);

    // ASSERTION 3: Both thinking panels are collapsed (inactive — text came
    // after each one, markThinkingInactive flips active to false)
    const firstThinkingPanel = thinkingPanels[0] as { expanded?: boolean };
    expect(firstThinkingPanel.expanded).toBe(false);

    const secondThinkingPanel = thinkingPanels[1] as { expanded?: boolean };
    expect(secondThinkingPanel.expanded).toBe(false);

    // ASSERTION 4: Both output panels are expanded (running state, visible output)
    const firstOutputPanel = outputPanels[0] as { expanded?: boolean };
    expect(firstOutputPanel.expanded).toBe(true);

    const secondOutputPanel = outputPanels[1] as { expanded?: boolean };
    expect(secondOutputPanel.expanded).toBe(true);

    // ASSERTION 5: Thinking panels contain their respective content
    const firstPanelJson = JSON.stringify(thinkingPanels[0]);
    const secondPanelJson = JSON.stringify(thinkingPanels[1]);
    expect(firstPanelJson).toContain('analyzing the problem');
    expect(secondPanelJson).toContain('revising my approach');

    // ASSERTION 6: Output panels contain their respective content
    const firstOutputJson = JSON.stringify(outputPanels[0]);
    const secondOutputJson = JSON.stringify(outputPanels[1]);
    expect(firstOutputJson).toContain('here is my answer');
    expect(secondOutputJson).toContain('revised answer');
  });
});

describe('Anchor: consecutive thinking blocks in same assistant event are merged', () => {
  /**
   * When a single assistant message contains multiple consecutive thinking
   * content blocks (no text/tool in between), they should be merged into a
   * single thinking block in the RunState, rather than creating separate
   * blocks. This prevents visual noise from fragmented thinking panels.
   *
   * Example: an assistant message with [thinking("step 1"), thinking("step 2")]
   * should produce ONE thinking block with content "step 1\nstep 2" (or similar
   * concatenation), not two separate thinking blocks.
   *
   * Current behavior: each thinking content block creates a separate RunBlock.
   * This test should FAIL until merging is implemented.
   */
  it('test_anchor_consecutive_thinking_blocks_in_same_assistant_are_merged', () => {
    let state = createInitialRunState('run-merge');

    // Single assistant message with two consecutive thinking blocks, then text
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'step 1: analyze input' },
          { type: 'thinking', thinking: 'step 2: formulate response' },
          { type: 'text', text: 'final answer' },
        ],
      },
      timestamp: '2026-06-27T10:00:00Z',
    });

    // ASSERTION 1: There should be exactly ONE thinking block (merged),
    // not two separate blocks
    const thinkingBlocks = state.blocks.filter((b) => b.kind === 'thinking');
    expect(thinkingBlocks.length).toBe(1);

    // ASSERTION 2: The merged thinking block should contain content from
    // both original thinking blocks
    const mergedBlock = thinkingBlocks[0];
    expect(mergedBlock.content).toContain('step 1: analyze input');
    expect(mergedBlock.content).toContain('step 2: formulate response');

    // ASSERTION 3: The block order should be: thinking (merged), text
    expect(state.blocks[0].kind).toBe('thinking');
    expect(state.blocks[1].kind).toBe('text');

    // ASSERTION 4: The thinking block should be inactive (text came after)
    expect((state.blocks[0] as { active: boolean }).active).toBe(false);
  });

  it('test_anchor_consecutive_thinking_across_assistant_events_remain_separate', () => {
    /**
     * Consecutive thinking blocks in DIFFERENT assistant events should NOT
     * be merged — they represent distinct turns with text/tool output in
     * between. Only consecutive thinking within the SAME assistant event
     * should merge.
     */
    let state = createInitialRunState('run-no-merge');

    // First assistant: thinking + text
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'first turn reasoning' },
          { type: 'text', text: 'partial answer' },
        ],
      },
      timestamp: '2026-06-27T10:00:00Z',
    });

    // Second assistant: thinking (same content as first, but different turn)
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'second turn reasoning' },
          { type: 'text', text: 'final answer' },
        ],
      },
      timestamp: '2026-06-27T10:01:00Z',
    });

    // These are across different assistant events with text in between,
    // so they must remain as two separate thinking blocks
    const thinkingBlocks = state.blocks.filter((b) => b.kind === 'thinking');
    expect(thinkingBlocks.length).toBe(2);
    expect(thinkingBlocks[0].content).toContain('first turn reasoning');
    expect(thinkingBlocks[1].content).toContain('second turn reasoning');
  });
});

describe('Anchor: result event marks all thinking blocks inactive', () => {
  /**
   * RED: When a `result` event arrives, it means the assistant turn has ended
   * (the CLI will wait for background tasks then exit). Any thinking block
   * still in `active: true` state should be flipped to `active: false` —
   * the assistant is no longer thinking; it has finished.
   *
   * Current behavior: `reduceResultEvent` sets `terminal` to
   * `finalizing` and calls `markThinkingInactive`. So thinking blocks are
   * marked inactive after the result event.
   *
   * Expected: after `reduceResultEvent`, all thinking blocks must have
   * `active: false`.
   */
  it('test_anchor_result_event_marks_thinking_blocks_inactive', () => {
    let state = createInitialRunState('run-result-inactive');

    // Assistant message with ONLY thinking — no text or tool follows.
    // This is the scenario where markThinkingInactive would NOT have been
    // called by any text/tool handler, leaving thinking.active = true.
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'pondering deeply...' }],
      },
      timestamp: '2026-06-27T10:00:00Z',
    });

    // Sanity: thinking block should be active before result event
    const thinkingBefore = state.blocks.filter((b) => b.kind === 'thinking');
    expect(thinkingBefore.length).toBe(1);
    expect((thinkingBefore[0] as { active: boolean }).active).toBe(true);

    // Now the result event arrives — assistant turn is over
    // system.init must precede result (pre-init result guard §9.22)
    state = reduceRunState(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'test-session',
    });
    state = reduceRunState(state, {
      type: 'result',
      subtype: 'success',
      session_id: 'test-session',
    });

    // ASSERTION: After result event, all thinking blocks must be inactive.
    // The assistant is done thinking; the UI should not show "思考中".
    const thinkingAfter = state.blocks.filter((b) => b.kind === 'thinking');
    for (const block of thinkingAfter) {
      expect((block as { active: boolean }).active).toBe(false);
    }
  });
});
