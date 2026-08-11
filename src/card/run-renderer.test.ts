import { describe, expect, it } from 'vitest';
import {
  createInitialRunState,
  finishRun,
  reduceRunState,
  type RunBlock,
  type RunState,
} from './run-state.js';
import { renderRunCard } from './run-renderer.js';

describe('renderRunCard', () => {
  it('test_anchor_running_card_is_v2_and_stop_is_bound_to_run', () => {
    const card = renderRunCard(createInitialRunState('run-7')) as {
      schema?: string;
      config: Record<string, unknown>;
      body?: { elements?: Array<Record<string, unknown>> };
    };

    // CardKit 2.0: schema is '2.0', stop uses behaviors callback
    expect(card.schema).toBe('2.0');
    const json = JSON.stringify(card);
    expect(json).toContain('"cmd":"stop"');
    expect(json).toContain('"runId":"run-7"');
    // New session button is always present
    expect(json).toContain('"cmd":"new-session"');
  });

  it('test_anchor_terminal_card_has_no_running_controls_and_fits_utf8_budget', () => {
    let state = createInitialRunState('run-8');
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '中😀'.repeat(20_000) }] },
    });
    state = finishRun(state, 'done', { resultSubtype: 'success' });
    const card = renderRunCard(state) as {
      body?: { elements?: Array<{ tag: string }> };
    };

    // 2.0: no stop button in terminal state
    const json = JSON.stringify(card);
    expect(json).not.toContain('"cmd":"stop"');
    // New session button is always present, even in terminal state
    expect(json).toContain('"cmd":"new-session"');
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThan(30_000);
  });

  it('test_anchor_tool_collapse_running_vs_terminal_behavior', () => {
    // Running state with 4 tools: each tool is independent (new design)
    // All 4 tools shown individually, with the last one expanded
    let state = createInitialRunState('run-tools');
    for (let index = 0; index < 4; index++) {
      state = reduceRunState(state, {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: `tool-${index}`,
              name: `Tool${index}`,
              input: {},
            },
          ],
        },
      });
    }
    const runningJson = JSON.stringify(renderRunCard(state));
    // Each tool is independent - all 4 shown individually
    expect(runningJson).toContain('Tool0');
    expect(runningJson).toContain('Tool1');
    expect(runningJson).toContain('Tool2');
    expect(runningJson).toContain('Tool3');
    // Collapsed format is not used
    expect(runningJson).not.toContain('个工具调用（已折叠）');

    // Terminal states: all tools shown individually (not collapsed)
    const expected = {
      done: '已完成',
      error: '出错',
      interrupted: '已中断',
      idle_timeout: '已超时',
    } as const;
    for (const [terminal, title] of Object.entries(expected)) {
      const terminalState = finishRun(
        createInitialRunState(`run-${terminal}`),
        terminal as keyof typeof expected,
        terminal === 'error' ? { errorMsg: 'boom' } : {},
      );
      const serialized = JSON.stringify(renderRunCard(terminalState));
      expect(serialized).toContain(title);
      expect(serialized).not.toContain('"cmd":"stop"');
      expect(serialized).not.toContain('正在思考');
    }
  });

  // RED (Round 2): All block types must have timestamp in panel header (parentheses)
  it('test_anchor_all_block_types_timestamp_in_panel_header', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      let state = createInitialRunState('run-all-ts');
      // Thinking block
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:00:00.000Z',
        message: { content: [{ type: 'thinking', thinking: '思考内容' }] },
      });
      // Tool block
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:01:00.000Z',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        },
      });
      // Tool result
      state = reduceRunState(state, {
        type: 'user',
        timestamp: '2026-07-19T10:02:00.000Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      });
      // Text block
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '输出内容' }] },
      });

      const serialized = JSON.stringify(renderRunCard(state));

      // All block timestamps must be in panel header right side (parentheses)
      // Thinking: `💭 **思考完成** (2026-07-19 18:00)`
      expect(serialized).toMatch(/💭 \*\*思考完成\*\* \(2026-07-19 18:00\)/);
      // Tool: `✅ **Bash** — ls (2026-07-19 18:02)` - shows completion time (tool result timestamp)
      expect(serialized).toMatch(/✅ \*\*Bash\*\* — ls \(2026-07-19 18:02\)/);
      // Text: `💬 **输出** (2026-07-19 18:03)`
      expect(serialized).toMatch(/💬 \*\*输出\*\* \(2026-07-19 18:03\)/);
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });

  // RED (Round 1): text block timestamp must be in panel header `💬 **输出** (ts)`,
  // not in content body as `_ts_\n\ncontent`
  it('test_anchor_text_block_timestamp_in_panel_header', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      let state = createInitialRunState('run-text-ts');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '完成了' }] },
      });

      const serialized = JSON.stringify(renderRunCard(state));
      // Text block must have panel header with timestamp in parentheses
      expect(serialized).toContain('💬 **输出** (2026-07-19 18:03)');
      // Old format `_ts_` in body must NOT appear for text blocks
      expect(serialized).not.toContain('_2026-07-19 18:03_');
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });

  it('renders local timestamps for thinking, response, and tools', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      let state = createInitialRunState('run-timestamps');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-06-20T10:00:00.000Z',
        message: { content: [{ type: 'thinking', thinking: '分析问题' }] },
      });
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-06-20T10:01:00.000Z',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } }],
        },
      });
      state = reduceRunState(state, {
        type: 'user',
        timestamp: '2026-06-20T10:02:00.000Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }],
        },
      });
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-06-20T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '完成了' }] },
      });

      const serialized = JSON.stringify(renderRunCard(state));
      // Thinking timestamp in panel header (right side)
      expect(serialized).toContain('思考完成** (2026-06-20 18:00)');
      // Tool timestamp in panel header
      expect(serialized).toContain('Read');
      expect(serialized).toContain('2026-06-20 18:02');
      // Text block timestamp is in panel header format (not `_ts_` in body)
      expect(serialized).toContain('💬 **输出** (2026-06-20 18:03)');
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });

  it('interleaves thinking blocks with text and tools in time order', () => {
    // Build state: thinking → text → thinking → tool → text
    let state = createInitialRunState('run-interleave');
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:00:00.000Z',
      message: { content: [{ type: 'thinking', thinking: '第一轮思考' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:01:00.000Z',
      message: { content: [{ type: 'text', text: '第一段文本' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:02:00.000Z',
      message: { content: [{ type: 'thinking', thinking: '第二轮思考' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:03:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-06-20T10:04:00.000Z',
      message: { content: [{ type: 'text', text: '第二段文本' }] },
    });

    const card = renderRunCard(state) as { body?: { elements?: object[] } };
    const elements = card.body?.elements ?? [];

    // Get content that includes our test strings
    const allJson = JSON.stringify(elements);

    // Should contain all our test content markers
    expect(allJson).toContain('第一轮思考');
    expect(allJson).toContain('第一段文本');
    expect(allJson).toContain('第二轮思考');
    expect(allJson).toContain('Read');
    expect(allJson).toContain('第二段文本');
  });

  it('respects showThinking false by filtering thinking from interleaved output', () => {
    let state = createInitialRunState('run-no-thinking');
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hidden' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'visible text' }] },
    });

    const card = renderRunCard(state, { showThinking: false }) as { elements: object[] };
    const serialized = JSON.stringify(card);

    expect(serialized).not.toContain('hidden');
    expect(serialized).toContain('visible text');
  });

  it('test_probe_token_stats_use_K_units', () => {
    // Test that done state renders token stats in K units (e.g., 120K instead of 120,000)
    let state = createInitialRunState('run-token');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      contextLength: 120000,
      compactCount: 2,
      cacheReadTokens: 80000,
      cacheCreationTokens: 20000,
    });
    const card = renderRunCard(state) as {
      body?: { elements?: Array<{ text?: { content?: string } }> };
    };
    const json = JSON.stringify(card);

    // Context length should be in K units
    expect(json).toContain('120K');
    expect(json).not.toContain('120,000');
    // Compact count in new format
    expect(json).toContain('Compact - 2次');
    // Token stats should use K units
    // Input = contextLength + cacheRead = 120K + 80K = 200K
    expect(json).toContain('Input token - 200K');
    // Output estimate = 10% of contextLength = 12K
    expect(json).toContain('Output token - 12K');
    // Cache percentage = 80000 / (120000 + 80000) = 40%
    expect(json).toContain('Cached token - 80K (40%)');
  });

  it('test_anchor_done_card_uses_real_input_output_tokens_when_present', () => {
    // Bug: codex run card showed "Output token - 2K" (10% estimate of
    // contextLength) instead of the real output_tokens. When the
    // run state carries real inputTokens/outputTokens (threaded from the
    // codex ResultEvent.usage), the done card MUST render the real values.
    let state = createInitialRunState('run-codex-real');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      contextLength: 20000,
      inputTokens: 18000,
      outputTokens: 200,
      cacheReadTokens: 8000,
    });
    const card = renderRunCard(state) as {
      body?: { elements?: Array<{ text?: { content?: string } }> };
    };
    const json = JSON.stringify(card);

    // Real output (200), NOT the 10% estimate from contextLength.
    expect(json).toContain('Output token - 200');
    expect(json).not.toMatch(/Output token - \d+K/);
    // Real input (18000 → "18K"), NOT contextLength+cache (28000 → "28K").
    expect(json).toContain('Input token - 18K');
    expect(json).not.toContain('Input token - 28K');
    // Unified ccusage cache% = cacheRead / (input + cacheRead)
    // = 8000 / (18000 + 8000) = 30.8% ≈ 31%.
    expect(json).toContain('Cached token - 8K (31%)');
  });

  it('test_anchor_done_card_threads_cache_creation_and_total_tokens', () => {
    // cacheCreationTokens must reach formatUsageStats (renders "Cache create"),
    // and totalTokens must be threaded so the done card uses max(total, sum)
    // (folds extra such as opencode reasoning). Here sum4 = 240+3+0+100 = 343
    // but totalTokens = 393, so Total must be 393 (not 343).
    let state = createInitialRunState('run-extras');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      inputTokens: 240,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 100,
      totalTokens: 393,
    });
    const json = JSON.stringify(renderRunCard(state));
    expect(json).toContain('Cache create - 100');
    expect(json).toContain('Total token - 393');
  });

  it('test_anchor_done_card_threads_cumulative_input_output', () => {
    // Session-cumulative total/input/output (read from jsonl, threaded via FinishMeta
    // -> RunState -> formatUsageStats) must render as "· 累计 X" on the
    // Total/Input/Output lines. Per-turn values stay as-is; cache line must
    // NOT carry a cumulative suffix.
    let state = createInitialRunState('run-cum');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      contextLength: 31235,
      inputTokens: 677,
      outputTokens: 376,
      cacheReadTokens: 30182,
      cacheCreationTokens: 0,
      totalTokens: 31235,
      cumulativeTotalTokens: 50000,
      cumulativeInputTokens: 46630,
      cumulativeOutputTokens: 3319,
    });
    const json = JSON.stringify(renderRunCard(state));
    // Per-turn unchanged.
    expect(json).toContain('Input token - 677');
    expect(json).toContain('Output token - 376');
    // Cumulative appended (50000 -> 50K, 46630 -> 47K, 3319 -> 3K).
    expect(json).toContain('累计 50K');
    expect(json).toContain('累计 47K');
    expect(json).toContain('累计 3K');
    // Cache line: verify format without 累计 suffix.
    expect(json).toContain('Cached token - 30K (98%)');
  });

  it('done 卡：Cached 与 Cache create 行带 session 累计后缀', () => {
    // renderRunCard 必须把 state.cumulativeCacheReadTokens /
    // cumulativeCacheCreationTokens 透传给 formatUsageStats，否则 Cached /
    // Cache create 行不带 "· 累计 X"。bridge 已把这两个字段塞进 finishRun meta，
    // 缺口仅在渲染器（usage 对象漏传 cumulativeCacheRead/Creation）。
    let state = createInitialRunState('run-cache-cum');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      contextLength: 31235,
      inputTokens: 677,
      outputTokens: 376,
      cacheReadTokens: 30182,
      cacheCreationTokens: 2000,
      totalTokens: 31235,
      cumulativeInputTokens: 5100,
      cumulativeCacheReadTokens: 10000,
      cumulativeCacheCreationTokens: 2500,
    });
    const json = JSON.stringify(renderRunCard(state));
    // Cached 行：累计命中量 + 累计命中率
    // （cumCacheRead / (cumInput + cumCacheRead) = 10000 / (5100+10000) ≈ 66%）
    expect(json).toContain('Cached token - 30K (98%) · 累计 10K (66%)');
    // Cache create 行：累计创建量（2500 -> 3K）
    expect(json).toContain('Cache create - 2K · 累计 3K');
  });
});

// CardKit 2.0 renderer — renderRunCard coverage (2.0 path
// is the production default for streaming run cards).
describe('renderRunCard (CardKit 2.0)', () => {
  type Card2 = {
    schema?: string;
    body?: {
      elements?: Array<
        { tag?: string; tabs?: Array<{ id?: string; label?: string }> } & Record<string, unknown>
      >;
    };
  };

  function render2(state: ReturnType<typeof createInitialRunState>): Card2 {
    return renderRunCard(state) as Card2;
  }

  it('produces schema 2.0 with inline content (no tabs for streaming) and no 1.x action container (regression: 200861)', () => {
    const card = render2(createInitialRunState('run-2-001'));
    const json = JSON.stringify(card);
    expect(card.schema).toBe('2.0');
    // No tabs in streaming mode - content is inline
    expect(card.body?.elements?.find((e) => e.tag === 'tabs')).toBeUndefined();
    // 200861 铁律：2.0 卡片禁止混入 1.x `tag:"action"` 容器
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('running card has stop button with 2.0 behaviors bound to runId', () => {
    const card = render2(createInitialRunState('run-2-stop'));
    const json = JSON.stringify(card);
    expect(json).toContain('"cmd":"stop"');
    expect(json).toContain('"runId":"run-2-stop"');
    expect(json).toContain('"type":"callback"');
  });

  it('terminal (done) card has no stop button but has new-session button', () => {
    const state = finishRun(createInitialRunState('run-2-done'), 'done', {
      resultSubtype: 'success',
    });
    const card = render2(state);
    const json = JSON.stringify(card);
    expect(json).not.toContain('"cmd":"stop"');
    // New session button is always present
    expect(json).toContain('"cmd":"new-session"');
    // Status text uses div + lark_md (not 1.x tag component which is unsupported in 2.0)
    expect(json).toContain('"tag":"div"');
    expect(json).toContain('已完成');
  });

  it('header title is agent-aware via options.agentKind', () => {
    // Initial state has footer='thinking', so header shows "思考中"
    const state = createInitialRunState('run-agent');

    // Default: no agentKind → 'Claude'
    const defaultJson = JSON.stringify(renderRunCard(state));
    expect(defaultJson).toContain('Claude · 思考中');

    // Explicit claude
    const claudeJson = JSON.stringify(renderRunCard(state, { agentKind: 'claude' }));
    expect(claudeJson).toContain('Claude · 思考中');

    // Codex (renderer is already agent-aware)
    const codexJson = JSON.stringify(renderRunCard(state, { agentKind: 'codex' }));
    expect(codexJson).toContain('Codex · 思考中');
    expect(codexJson).not.toContain('Claude');

    // Opencode
    const opencodeJson = JSON.stringify(renderRunCard(state, { agentKind: 'opencode' }));
    expect(opencodeJson).toContain('Opencode · 思考中');

    // Terminal state uses different label
    const doneState = finishRun(state, 'done', { resultSubtype: 'success' });
    const doneJson = JSON.stringify(renderRunCard(doneState, { agentKind: 'codex' }));
    expect(doneJson).toContain('Codex · 已完成');
  });

  it('terminal done card displays compact count from state', () => {
    let state = createInitialRunState('run-compact');
    state = finishRun(state, 'done', {
      resultSubtype: 'success',
      compactCount: 2,
    });
    const json = JSON.stringify(renderRunCard(state));
    expect(json).toMatch(/Compact\s+-\s+2次/);
  });

  it('result event transitions to finalizing (non-terminal) - stop button still shows', () => {
    // 进程退出是唯一终态触发源：result 事件只进入非终态 finalizing，
    // 停止按钮仍显示（showStop = running || finalizing）。
    // 缺失会让用户在进程仍存活（等后台任务）时丢失停止按钮。
    let state = createInitialRunState('run-2');
    state = reduceRunState(state, {
      type: 'result',
      subtype: 'success',
      session_id: 'run-2',
      total_cost_usd: 0.01,
    });
    // 验证进入 finalizing 非终态（不是 done）
    expect(state.terminal).toBe('finalizing');

    // finalizing 仍显示停止按钮（进程未退出，用户可 /stop）
    const json = JSON.stringify(render2(state));
    expect(json).toContain('"cmd":"stop"');
  });

  it('does not duplicate tool calls in main content and tools section', () => {
    // Regression: CardKit 2.0 flat layout was rendering tools twice —
    // once as a markdown list ("**工具调用:**\n- ⏳ Agent\n- ✅ Bash -- …")
    // in buildMainContent, and again as collapsible panels in buildToolsContent.
    // In flat layout, buildToolsContent already renders all tools (with
    // collapse strategy), so buildMainContent must NOT emit tool summaries.
    let state = createInitialRunState('run-dup-tools');
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '开始工作' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2', is_error: false },
        ],
      },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.ts' } }],
      },
    });
    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok', is_error: false }],
      },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pwd' } }],
      },
    });

    const json = JSON.stringify(render2(state));

    // Tool names must appear (rendered by buildToolsContent)
    expect(json).toContain('Bash');
    expect(json).toContain('Read');

    // The duplicate markdown list header from buildMainContent must NOT appear
    expect(json).not.toContain('**工具调用:**');
  });

  it('does not duplicate tool calls in terminal state either', () => {
    // Same regression check for finalized (done) cards
    let state = createInitialRunState('run-dup-done');
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '完成' }] },
    });
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
      },
    });
    state = finishRun(state, 'done', { resultSubtype: 'success' });

    const json = JSON.stringify(render2(state));
    expect(json).toContain('Bash');
    expect(json).not.toContain('**工具调用:**');
  });

  it('degrades thinking: keeps last 2 + omission hint when budget exceeded', () => {
    // Build a RunState directly (bypassing reduceRunState's internal truncation)
    // with enough content to trigger the 28KB budget exceeded fallback.
    // - 7 thinking blocks with large content
    // - 5 tool calls with large output
    // - Large text content
    const state = {
      runId: 'run-degrade-thinking',
      terminal: 'done' as const,
      footer: null,
      blocks: [] as RunBlock[],
      sessionId: 's1',
      resultSubtype: 'success' as const,
    };

    // Add 7 thinking blocks (exceeds the 2 that should be kept in degradation)
    for (let i = 0; i < 7; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'x'.repeat(2500),
        active: false,
        timestamp: `2026-07-04T10:0${i}:00.000Z`,
      });
    }

    // Add 5 tool blocks with large output
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-d-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: 'o'.repeat(3500),
          status: 'ok',
          startedAt: '2026-07-04T10:10:00.000Z',
          completedAt: '2026-07-04T10:11:00.000Z',
        },
      });
    }

    // Add large text content that must be preserved in degradation
    state.blocks.push({
      kind: 'text',
      content: '这是重要的文本输出，必须完整保留。' + 'T'.repeat(8000),
      timestamp: '2026-07-04T10:30:00.000Z',
    });

    // Render the card (budget check happens inside)
    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // Verify the card triggered budget exceeded (should be much smaller than 28KB)
    expect(cardBytes).toBeLessThan(28_000);

    // Test expectations for the degraded behavior (will fail in RED):
    // 1. Should contain the last 2 thinking blocks (思考6 and 思考7)
    expect(json).toContain('思考6');
    expect(json).toContain('思考7');

    // 2. Should NOT contain the earlier thinking blocks (思考1-思考5)
    expect(json).not.toContain('思考1');
    expect(json).not.toContain('思考2');
    expect(json).not.toContain('思考3');
    expect(json).not.toContain('思考4');
    expect(json).not.toContain('思考5');

    // 3. Should contain omission hint for early thinking
    expect(json).toMatch(/5 个早期思考已省略/);

    // 4. Text content must be preserved intact
    expect(json).toContain('这是重要的文本输出，必须完整保留。');

    // 5. Tools: last 3 tool panels preserved in degraded mode (new design)
    // The card should have the last 3 tool panels individually (chronologically)
    // Each tool is rendered as: ✅ **Bash** — cmdN (timestamp)
    expect(json).toContain('**Bash** — cmd2');
    expect(json).toContain('**Bash** — cmd3');
    expect(json).toContain('**Bash** — cmd4');
    // Should have omit hint for earlier tools (2 omitted: cmd0, cmd1)
    expect(json).toMatch(/另外 2 个工具调用已省略/);
    // Old one-line summary format should NOT appear
    expect(json).not.toMatch(/\d+ 次工具调用$/);

    // 6. CardKit 2.0 schema compliance — no V1 action container
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('extreme fallback: degrades further when even degraded card exceeds 28KB', () => {
    // Build a massive RunState that exceeds 28KB even after degraded rendering.
    // Degraded path: last 2 thinking (each truncated to REASONING_BYTES=4500) +
    // text (truncated to TEXT_BYTES=10000) + tool summary + summary.
    // Total degraded ≈ 9KB thinking + 10KB text + overhead ≈ 23KB — still fits.
    // To force extreme fallback, we add MULTIPLE large text blocks that each
    // survive as separate markdown divs after truncation.
    const state: RunState = {
      runId: 'run-extreme',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-extreme',
      resultSubtype: 'success',
    };

    // 20 thinking blocks with 5KB content each
    for (let i = 0; i < 20; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'X'.repeat(5000),
        active: false,
        timestamp: `2026-07-04T10:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }

    // 20 tool blocks with 5KB output each
    for (let i = 0; i < 20; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-ext-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: 'O'.repeat(5000),
          status: 'ok',
          startedAt: '2026-07-04T11:00:00.000Z',
          completedAt: '2026-07-04T11:01:00.000Z',
        },
      });
    }

    // Multiple text blocks interleaved with tools — groupBlocks merges consecutive
    // text, so we alternate with tool blocks to create many separate text groups.
    // Each text block will be individually truncated to TEXT_BYTES in buildMainContent.
    // 3 text blocks * ~10KB each = ~30KB text in degraded path = exceeds 28KB.
    for (let i = 0; i < 3; i++) {
      state.blocks.push({
        kind: 'text',
        content: '文本块' + (i + 1) + ':关键输出尾部信息必须保留' + 'T'.repeat(12000),
        timestamp: `2026-07-04T12:0${i}:00.000Z`,
      });
      // Insert a tool between text blocks to prevent groupBlocks merging them
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-sep-' + i,
          name: 'Write',
          input: { file_path: 'out' + i + '.txt' },
          output: 'written',
          status: 'ok',
          startedAt: '2026-07-04T12:10:00.000Z',
          completedAt: '2026-07-04T12:10:05.000Z',
        },
      });
    }
    // Final text block (no trailing tool)
    // Important: extreme fallback truncates TEXT to 5KB from END,
    // so we must put the critical content at the END, not the beginning.
    state.blocks.push({
      kind: 'text',
      content: 'F'.repeat(12000) + '最终关键输出尾部信息，截断后仍保留',
      timestamp: '2026-07-04T13:00:00.000Z',
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // Card must fit within 28KB budget (extreme fallback should ensure this)
    expect(cardBytes).toBeLessThanOrEqual(28_000);

    // Extreme fallback keeps only the last 1 thinking block
    expect(json).toContain('思考20');
    // Earlier thinking blocks are omitted (20 - 1 = 19 earlier blocks)
    expect(json).toMatch(/19 个早期思考已省略/);

    // Text is truncated to 5KB tail in extreme fallback, but the critical
    // tail content must survive in at least the last text block
    expect(json).toContain('最终关键输出尾部信息，截断后仍保留');

    // Extreme fallback: keeps last 1 tool panel chronologically
    // Since Write tools were added after Bash tools, Write is the last tool
    expect(json).toContain('Write');
    expect(json).toMatch(/另外 \d+ 个工具调用已省略/);
    // Old one-line summary should NOT appear
    expect(json).not.toMatch(/\d+ 次工具调用$/);

    // CardKit 2.0 schema compliance
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('budget boundary: complete rendering when card fits within 28KB', () => {
    // Build a small RunState that fits comfortably within 28KB
    // All thinking blocks and tool details should be preserved (no degradation)
    const state: RunState = {
      runId: 'run-small',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-small',
      resultSubtype: 'success',
    };

    // 2 small thinking blocks
    state.blocks.push({
      kind: 'thinking',
      content: '分析用户需求',
      active: false,
      timestamp: '2026-07-04T10:00:00.000Z',
    });
    state.blocks.push({
      kind: 'thinking',
      content: '设计解决方案',
      active: false,
      timestamp: '2026-07-04T10:01:00.000Z',
    });

    // 2 small tool calls
    state.blocks.push({
      kind: 'tool',
      tool: {
        id: 'tool-s-1',
        name: 'Read',
        input: { file_path: 'a.ts' },
        output: 'const x = 1;',
        status: 'ok',
        startedAt: '2026-07-04T10:02:00.000Z',
        completedAt: '2026-07-04T10:02:30.000Z',
      },
    });
    state.blocks.push({
      kind: 'tool',
      tool: {
        id: 'tool-s-2',
        name: 'Bash',
        input: { command: 'echo hello' },
        output: 'hello',
        status: 'ok',
        startedAt: '2026-07-04T10:03:00.000Z',
        completedAt: '2026-07-04T10:03:10.000Z',
      },
    });

    // Small text content
    state.blocks.push({
      kind: 'text',
      content: '这是正常的输出文本。',
      timestamp: '2026-07-04T10:04:00.000Z',
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);

    // Both thinking blocks are preserved (not degraded)
    expect(json).toContain('分析用户需求');
    expect(json).toContain('设计解决方案');

    // No omission hint (all thinking shown)
    expect(json).not.toMatch(/\d+ 个早期思考已省略/);

    // Tool details are preserved (not just a one-line summary)
    expect(json).toContain('Read');
    expect(json).toContain('Bash');
    expect(json).toContain('const x = 1;');
    expect(json).toContain('hello');

    // No tool summary line (tools rendered individually, not as summary)
    expect(json).not.toMatch(/\d+ 次工具调用$/);

    // Text content preserved
    expect(json).toContain('这是正常的输出文本。');
  });

  it('compatibility: small cards are unaffected by degradation logic', () => {
    // Minimal state — just a running card with a single text block
    let state = createInitialRunState('run-compat');
    state = reduceRunState(state, {
      type: 'assistant',
      timestamp: '2026-07-04T10:00:00.000Z',
      message: { content: [{ type: 'text', text: 'Hello from Claude!' }] },
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);

    // Card is small — should be under 28KB without any degradation
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28_000);

    // Content fully preserved
    expect(json).toContain('Hello from Claude!');

    // No degradation artifacts
    expect(json).not.toMatch(/\d+ 个早期思考已省略/);
    expect(json).not.toMatch(/\d+ 次工具调用$/);

    // Running state has stop button
    expect(json).toContain('"cmd":"stop"');
    expect(json).toContain('"runId":"run-compat"');

    // CardKit 2.0 schema compliance
    expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  // RED test: degraded card must still have new-session button
  it('RED: degraded card has new-session button even when budget exceeded', () => {
    // Build a RunState that exceeds 28KB to trigger degraded rendering
    const state: RunState = {
      runId: 'run-degraded-buttons',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's1',
      resultSubtype: 'success',
    };

    // Add multiple large thinking blocks (triggers degraded path)
    for (let i = 0; i < 7; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'x'.repeat(2500),
        active: false,
        timestamp: `2026-07-14T10:0${i}:00.000Z`,
      });
    }

    // Add large tool outputs
    for (let i = 0; i < 5; i++) {
      state.blocks.push({
        kind: 'tool',
        tool: {
          id: 'tool-d-' + i,
          name: 'Bash',
          input: { command: 'cmd' + i },
          output: 'o'.repeat(3500),
          status: 'ok',
          startedAt: '2026-07-14T10:10:00.000Z',
          completedAt: '2026-07-14T10:11:00.000Z',
        },
      });
    }

    // Add large text content
    state.blocks.push({
      kind: 'text',
      content: '重要输出必须保留。' + 'T'.repeat(8000),
      timestamp: '2026-07-14T10:30:00.000Z',
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // Must be under budget after degradation
    expect(cardBytes).toBeLessThan(28_000);

    // Degraded path must preserve the new-session button - THIS WILL FAIL
    expect(json).toContain('"cmd":"new-session"');
  });

  // RED test: extreme fallback card must still have new-session button
  it('RED: extreme fallback card has new-session button even when budget exceeded', () => {
    // Build an even larger state to trigger extreme fallback
    const state: RunState = {
      runId: 'run-extreme-buttons',
      terminal: 'done',
      footer: null,
      blocks: [],
      sessionId: 's-extreme',
      resultSubtype: 'success',
    };

    // 20 thinking blocks with 5KB each
    for (let i = 0; i < 20; i++) {
      state.blocks.push({
        kind: 'thinking',
        content: '思考' + (i + 1) + ':' + 'X'.repeat(5000),
        active: false,
        timestamp: `2026-07-14T10:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }

    // Large text blocks
    for (let i = 0; i < 3; i++) {
      state.blocks.push({
        kind: 'text',
        content: '文本块' + (i + 1) + ':关键信息' + 'T'.repeat(12000),
        timestamp: `2026-07-14T12:0${i}:00.000Z`,
      });
    }

    state.blocks.push({
      kind: 'text',
      content: 'F'.repeat(12000) + '最终关键输出尾部信息',
      timestamp: '2026-07-14T13:00:00.000Z',
    });

    const card = renderRunCard(state);
    const json = JSON.stringify(card);
    const cardBytes = Buffer.byteLength(json, 'utf8');

    // Must fit in budget
    expect(cardBytes).toBeLessThanOrEqual(28_000);

    // Extreme fallback must preserve new-session button - THIS WILL FAIL
    expect(json).toContain('"cmd":"new-session"');
  });

  // =========================================================================
  // Text block: terminal state uses collapsible_panel (to protect tables from 11310)
  // =========================================================================
  describe('text block: terminal state uses collapsible_panel', () => {
    it('done state text block IS wrapped in collapsible_panel (to protect tables)', () => {
      // Output is wrapped in collapsible_panel (expanded) to protect markdown tables
      // from being counted toward 11310 limit (5 tables max per card).
      let state = createInitialRunState('run-text-unfold');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '这是重要输出' }] },
      });
      state = finishRun(state, 'done', { resultSubtype: 'success' });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };
      const elements = card.body?.elements ?? [];
      const json = JSON.stringify(card);

      // Content must be visible
      expect(json).toContain('这是重要输出');

      // Find the element containing the text content - should be in collapsible_panel
      const textElement = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('这是重要输出'),
      );

      // Text MUST be inside a collapsible_panel in terminal state (to protect tables from 11310)
      expect(textElement).toBeDefined();
      expect((textElement as Record<string, unknown>)?.expanded).toBe(true);
    });

    it('done state text block uses notation font size inside panel', () => {
      let state = createInitialRunState('run-text-fontsize');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '正常字号输出' }] },
      });
      state = finishRun(state, 'done', { resultSubtype: 'success' });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };

      // Find the collapsible_panel containing the text
      const elements = card.body?.elements ?? [];
      const textPanel = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('正常字号输出'),
      );

      // Must exist inside collapsible_panel
      expect(textPanel).toBeDefined();

      // Inside panel, text uses notation size
      const panelElements = (textPanel as Record<string, unknown>)?.elements as Array<
        Record<string, unknown>
      >;
      const textDiv = panelElements?.find((el) => el.tag === 'div');
      const textObj = (textDiv as Record<string, unknown>)?.text as Record<string, unknown>;
      expect(textObj?.text_size).toBe('notation');
    });

    it('done state text block shows timestamp in panel header', () => {
      const oldTz = process.env.TZ;
      process.env.TZ = 'Asia/Shanghai';
      try {
        let state = createInitialRunState('run-text-ts-prefix');
        state = reduceRunState(state, {
          type: 'assistant',
          timestamp: '2026-07-19T10:03:00.000Z',
          message: { content: [{ type: 'text', text: '输出内容' }] },
        });
        state = finishRun(state, 'done', { resultSubtype: 'success' });

        const json = JSON.stringify(renderRunCard(state));

        // Timestamp should appear in panel header (not as content prefix)
        expect(json).toContain('💬 **输出** (2026-07-19 18:03)');
        // Old prefix format should NOT appear
        expect(json).not.toContain('_2026-07-19 18:03_');
      } finally {
        if (oldTz === undefined) delete process.env.TZ;
        else process.env.TZ = oldTz;
      }
    });

    it('running state text block still uses collapsible_panel with expanded=true', () => {
      let state = createInitialRunState('run-text-running');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '流式输出' }] },
      });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };
      const elements = card.body?.elements ?? [];

      // Find the collapsible_panel containing the text
      const panelElement = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('流式输出'),
      );

      // Running state: text must be in a collapsible_panel
      expect(panelElement).toBeDefined();
      // And it must be expanded (visible)
      expect((panelElement as Record<string, unknown>)?.expanded).toBe(true);
    });

    it('GREEN: finalizing state text block also uses collapsible_panel (like done)', () => {
      // Finalizing: result received, process not yet exited. Output is complete, uses panel.
      let state = createInitialRunState('run-text-finalizing');
      state = reduceRunState(state, {
        type: 'assistant',
        timestamp: '2026-07-19T10:03:00.000Z',
        message: { content: [{ type: 'text', text: '等待退出' }] },
      });
      state = reduceRunState(state, {
        type: 'result',
        subtype: 'success',
        session_id: 'run-text-finalizing',
        total_cost_usd: 0.01,
      });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };
      const elements = card.body?.elements ?? [];

      // finalizing state: text MUST be in a collapsible_panel (to protect tables)
      const textPanel = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('等待退出'),
      );
      expect(textPanel).toBeDefined();
      expect((textPanel as Record<string, unknown>)?.expanded).toBe(true);
    });

    it('RED: degraded path also uses collapsible_panel in terminal state', () => {
      // Build a large state that triggers degraded rendering
      const state: RunState = {
        runId: 'run-degrade-text',
        terminal: 'done',
        footer: null,
        blocks: [],
        sessionId: 's-degrade',
        resultSubtype: 'success',
      };

      // Many thinking blocks to trigger budget exceeded
      for (let i = 0; i < 7; i++) {
        state.blocks.push({
          kind: 'thinking',
          content: '思考' + (i + 1) + ':' + 'x'.repeat(2500),
          active: false,
          timestamp: `2026-07-04T10:0${i}:00.000Z`,
        });
      }
      // Many tool blocks
      for (let i = 0; i < 5; i++) {
        state.blocks.push({
          kind: 'tool',
          tool: {
            id: 'tool-dt-' + i,
            name: 'Bash',
            input: { command: 'cmd' + i },
            output: 'o'.repeat(3500),
            status: 'ok',
            startedAt: '2026-07-04T10:10:00.000Z',
            completedAt: '2026-07-04T10:11:00.000Z',
          },
        });
      }
      // Text block
      state.blocks.push({
        kind: 'text',
        content: '重要输出必须可见',
        timestamp: '2026-07-04T10:30:00.000Z',
      });

      const card = renderRunCard(state) as {
        body?: { elements?: Array<Record<string, unknown>> };
      };
      const json = JSON.stringify(card);

      // Must fit in budget (degraded)
      expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28_000);

      // Text content must be visible
      expect(json).toContain('重要输出必须可见');

      // Text MUST be in a collapsible_panel (to protect tables from 11310)
      const elements = card.body?.elements ?? [];
      const textPanel = elements.find(
        (el) => el.tag === 'collapsible_panel' && JSON.stringify(el).includes('重要输出必须可见'),
      );
      expect(textPanel).toBeDefined();
    });
  });
});
