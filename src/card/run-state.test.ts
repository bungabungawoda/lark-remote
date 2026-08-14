import { describe, expect, it } from 'vitest';
import {
  createInitialRunState,
  finishRun,
  reduceRunState,
  type RunTerminal,
  type RunFooter,
} from './run-state.js';

describe('RunState', () => {
  it('test_anchor_result_event_transitions_to_finalizing_not_terminal', () => {
    // 进程退出作为唯一终态触发源：result 事件只进入非终态 finalizing，
    // 不直接置 done/error。停止按钮在 finalizing 仍显示。
    // 缺失/错误会让卡片在进程仍存活时误显示"已完成"+丢失停止按钮（双事实来源 bug）。
    const initial = createInitialRunState('run-1');
    // system.init must precede result (pre-init result guard §9.22)
    const inited = reduceRunState(initial, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    const state = reduceRunState(inited, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    });

    expect(state.terminal).toBe('finalizing');
    expect(state.resultSubtype).toBe('success');
    // finalizing 不是终态：footer 清空，thinking 折叠
    expect(state.footer).toBeNull();
  });

  it('test_anchor_result_error_event_transitions_to_finalizing_with_error', () => {
    const initial = createInitialRunState('run-1');
    const inited = reduceRunState(initial, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    const state = reduceRunState(inited, {
      type: 'result',
      subtype: 'error',
      session_id: 'session-1',
      errorMessage: 'Test error',
    });

    expect(state.terminal).toBe('finalizing');
    expect(state.resultSubtype).toBe('error');
    expect(state.errorMsg).toBe('Test error');
  });

  it('test_anchor_result_interrupted_keeps_interrupted_semantics', () => {
    // 审批超时/取消导致的中断是独立终态：不得并入 success，也不得归因于 Agent
    // 报错（errorMsg 保持 undefined，不落「Agent 返回错误结果」兜底）。
    const initial = createInitialRunState('run-1');
    const inited = reduceRunState(initial, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    const state = reduceRunState(inited, {
      type: 'result',
      subtype: 'interrupted',
      session_id: 'session-1',
    });

    expect(state.terminal).toBe('finalizing');
    expect(state.resultSubtype).toBe('interrupted');
    expect(state.errorMsg).toBeUndefined();
  });

  it('test_anchor_compact_boundary_increments_compact_count', () => {
    const initial = createInitialRunState('run-1');
    const result = reduceRunState(initial, {
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { postTokens: 5000, preTokens: 8000 },
    });

    expect(result.compactCount).toBe(1);
  });

  it('test_anchor_finishRun_accepts_cacheToken_stats', () => {
    const initial = createInitialRunState('run-1');
    const finished = finishRun(initial, 'done', {
      contextLength: 1000,
      compactCount: 2,
      cacheReadTokens: 5000,
      cacheCreationTokens: 200,
    });

    expect(finished.contextLength).toBe(1000);
    expect(finished.compactCount).toBe(2);
    expect(finished.cacheReadTokens).toBe(5000);
    expect(finished.cacheCreationTokens).toBe(200);
  });

  it('test_anchor_finishRun_from_finalizing_to_done', () => {
    // 进程退出后 bridge finally 从 finalizing 转 done（状态转移表）。
    // 缺失会让卡片永远停在"完成中"，workspace 永久 busy（不一致）。
    const initial = createInitialRunState('run-1');
    const inited = reduceRunState(initial, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    const finalizing = reduceRunState(inited, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    });
    expect(finalizing.terminal).toBe('finalizing');

    const done = finishRun(finalizing, 'done', { resultSubtype: 'success' });
    expect(done.terminal).toBe('done');
    expect(done.resultSubtype).toBe('success');
  });

  it('test_anchor_finishRun_from_finalizing_to_interrupted', () => {
    // /stop 在 finalizing 期间触发：finalizing -> interrupted。
    // 缺失会让 /stop 对"完成中"的 run 无效，进程杀不掉。
    const initial = createInitialRunState('run-1');
    const inited = reduceRunState(initial, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    const finalizing = reduceRunState(inited, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    });

    const interrupted = finishRun(finalizing, 'interrupted');
    expect(interrupted.terminal).toBe('interrupted');
  });

  it('test_anchor_finishRun_from_finalizing_to_idle_timeout', () => {
    // idle watchdog 在 finalizing 期间触发：finalizing -> idle_timeout。
    const initial = createInitialRunState('run-1');
    const inited = reduceRunState(initial, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    const finalizing = reduceRunState(inited, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    });

    const timed = finishRun(finalizing, 'idle_timeout', { idleTimeoutMinutes: 15 });
    expect(timed.terminal).toBe('idle_timeout');
    expect(timed.idleTimeoutMinutes).toBe(15);
  });

  it('test_anchor_finishRun_on_terminal_supplements_meta_without_changing_terminal', () => {
    // 进程退出 finally 的 else-if-sawResult 分支：已终态时补充 usage meta（§4.2）。
    // 缺失会让 finalizing 期间被 /stop 的卡片丢失 token 统计。
    const initial = createInitialRunState('run-1');
    const inited = reduceRunState(initial, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    const finalizing = reduceRunState(inited, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    });
    const interrupted = finishRun(finalizing, 'interrupted');
    expect(interrupted.terminal).toBe('interrupted');
    expect(interrupted.contextLength).toBeUndefined();

    // 在已终态上 finish，传入 meta（模拟 bridge finally 补充 usage）
    const supplemented = finishRun(interrupted, 'done', {
      contextLength: 1000,
      totalTokens: 500,
      cacheReadTokens: 200,
    });

    // terminal 保持首个终态（interrupted），不被 'done' 覆盖
    expect(supplemented.terminal).toBe('interrupted');
    // meta 已应用
    expect(supplemented.contextLength).toBe(1000);
    expect(supplemented.totalTokens).toBe(500);
    expect(supplemented.cacheReadTokens).toBe(200);
  });

  it('test_anchor_finishRun_on_terminal_ignores_undefined_meta_fields', () => {
    const initial = createInitialRunState('run-1');
    const inited = reduceRunState(initial, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    const finalizing = reduceRunState(inited, {
      type: 'result',
      subtype: 'error',
      session_id: 'session-1',
      errorMessage: '原始错误',
    });
    const errorState = finishRun(finalizing, 'error');
    expect(errorState.errorMsg).toBe('原始错误');

    // 传入 undefined errorMsg 不应清空已有 errorMsg
    const supplemented = finishRun(errorState, 'done', {
      contextLength: 500,
      errorMsg: undefined,
    });
    expect(supplemented.terminal).toBe('error');
    expect(supplemented.errorMsg).toBe('原始错误');
    expect(supplemented.contextLength).toBe(500);
  });

  it('test_anchor_multiple_result_events_merge_error_wins', () => {
    // agent 自身 result + 合成 result（进程退出）合并语义。
    // error 优先：任一为 error 即 error。
    // 缺失会让"agent 报错 + 进程干净退出"误判为 done。
    let state = createInitialRunState('run-1');
    state = reduceRunState(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    // agent result(success)
    state = reduceRunState(state, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    });
    expect(state.terminal).toBe('finalizing');
    expect(state.resultSubtype).toBe('success');

    // 合成 result(error) - 进程崩溃
    state = reduceRunState(state, {
      type: 'result',
      subtype: 'error',
      session_id: 'session-1',
      errorMessage: 'killed by signal',
    });
    expect(state.terminal).toBe('finalizing');
    expect(state.resultSubtype).toBe('error'); // error 优先
    expect(state.errorMsg).toBe('killed by signal');
  });

  it('test_anchor_multiple_result_events_errorMsg_first_wins', () => {
    // errorMsg 首个非 undefined 胜出：agent 的错误信息更具体。
    let state = createInitialRunState('run-1');
    state = reduceRunState(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    // agent result(error, "auth failed")
    state = reduceRunState(state, {
      type: 'result',
      subtype: 'error',
      session_id: 'session-1',
      errorMessage: 'auth failed',
    });
    expect(state.errorMsg).toBe('auth failed');

    // 合成 result(success) - 进程干净退出，无 errorMsg
    state = reduceRunState(state, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    });
    // subtype 仍 error（error 优先），errorMsg 保留 agent 的"auth failed"
    expect(state.resultSubtype).toBe('error');
    expect(state.errorMsg).toBe('auth failed');
  });

  it('test_anchor_finalizing_continues_processing_assistant_events', () => {
    // finalizing 非终态：for-await 继续消费事件（Claude 后台任务输出不被丢弃 §5 不变量 3）。
    const state0 = createInitialRunState('run-1');
    const inited = reduceRunState(state0, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    // result -> finalizing
    const state1 = reduceRunState(inited, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    });
    expect(state1.terminal).toBe('finalizing');

    // finalizing 后，assistant 事件应被正常处理（不被终态守卫拦截）
    const state2 = reduceRunState(state1, {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'background task output' }],
      },
    });

    expect(state2.terminal).toBe('finalizing'); // 仍是 finalizing，未变终态
    expect(state2.blocks).toHaveLength(1);
    expect(state2.blocks[0]).toMatchObject({ kind: 'text', content: 'background task output' });
  });

  it('test_anchor_terminal_state_blocks_incoming_events', () => {
    // 终态守卫：done/error/interrupted/idle_timeout 后事件被忽略（§5 不变量 1）。
    const state0 = createInitialRunState('run-1');
    const inited = reduceRunState(state0, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });
    const finalizing = reduceRunState(inited, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    });
    const done = finishRun(finalizing, 'done');

    // 终态 done: assistant 事件应被忽略
    const afterAssistant = reduceRunState(done, {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'This should be ignored' }],
      },
    });

    expect(afterAssistant).toBe(done); // 完全不变
    expect(afterAssistant.blocks).toHaveLength(0);
  });

  it('test_anchor_mixed_content_and_tool_result_preserve_order', () => {
    let state = createInitialRunState('run-1');
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'reason' },
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'a' } },
        ],
      },
    });
    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'body', is_error: false }],
      },
    });

    const thinkingBlocks = state.blocks.filter((b) => b.kind === 'thinking');
    expect(thinkingBlocks.length).toBe(1);
    expect(thinkingBlocks[0]).toMatchObject({ content: 'reason', active: false });
    expect(state.blocks[1]).toMatchObject({ kind: 'text', content: 'answer' });
    expect(state.blocks[2]).toMatchObject({
      kind: 'tool',
      tool: { id: 'tool-1', status: 'ok', output: 'body' },
    });
  });

  // P3-4: reduceToolResultEvent must rebuild ONLY the block matching tool_use_id,
  // keeping every other block's object reference identical (in-place update).
  // The old `.map()` recreated every block object even when only one matched —
  // O(N) allocations per tool_result on the run-card hot path. The anchor locks
  // both the perf intent (unmatched blocks unchanged by reference) and the
  // immutability invariant (matched block gets a NEW object, no shared mutation).
  it('test_anchor_tool_result_rebuilds_only_matching_block_keeps_other_refs', () => {
    let state = createInitialRunState('run-1');
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'reason-A' },
          { type: 'text', text: 'answer-A' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'a' } },
          { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file: 'b' } },
        ],
      },
    });
    const beforeThinking = state.blocks[0];
    const beforeText = state.blocks[1];
    const beforeTool1 = state.blocks[2];
    const beforeTool2 = state.blocks[3];

    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'body-1', is_error: false },
        ],
      },
    });

    // Unmatched blocks keep the EXACT same object reference (not recreated).
    expect(state.blocks[0]).toBe(beforeThinking);
    expect(state.blocks[1]).toBe(beforeText);
    // tool-2 unmatched → same reference.
    expect(state.blocks[3]).toBe(beforeTool2);
    // tool-1 matched → updated output/status/completedAt.
    expect(state.blocks[2]).not.toBe(beforeTool1);
    expect(state.blocks[2]).toMatchObject({
      kind: 'tool',
      tool: { id: 'tool-1', status: 'ok', output: 'body-1' },
    });
    // footer advanced to streaming.
    expect(state.footer).toBe('streaming');
  });

  // P3-4: no matching tool_use_id → blocks array unchanged by reference (early exit).
  it('test_anchor_tool_result_no_match_keeps_blocks_ref', () => {
    let state = createInitialRunState('run-1');
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'a' } },
        ],
      },
    });
    const beforeBlocks = state.blocks;

    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'nonexistent', content: 'x', is_error: false },
        ],
      },
    });

    // No match → footer still advanced (matches parity with current behavior),
    // but the blocks array reference itself is preserved (no recreation).
    expect(state.blocks).toBe(beforeBlocks);
  });

  // P3-4: multiple tool_results in one user message each update their own tool.
  it('test_anchor_tool_result_multiple_content_each_update_own_tool', () => {
    let state = createInitialRunState('run-1');
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'a' } },
          { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file: 'b' } },
        ],
      },
    });
    const beforeTool1 = state.blocks[0];
    const beforeTool2 = state.blocks[1];

    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'body-1', is_error: false },
          { type: 'tool_result', tool_use_id: 'tool-2', content: 'body-2', is_error: true },
        ],
      },
    });

    expect(state.blocks[0]).not.toBe(beforeTool1);
    expect(state.blocks[1]).not.toBe(beforeTool2);
    expect(state.blocks[0]).toMatchObject({
      kind: 'tool',
      tool: { id: 'tool-1', status: 'ok', output: 'body-1' },
    });
    expect(state.blocks[1]).toMatchObject({
      kind: 'tool',
      tool: { id: 'tool-2', status: 'error', output: 'body-2' },
    });
  });

  it('test_anchor_runTerminal_includes_finalizing', () => {
    // RunTerminal 类型包含 finalizing。
    const terminals: RunTerminal[] = [
      'running',
      'finalizing',
      'done',
      'error',
      'interrupted',
      'idle_timeout',
    ];
    expect(terminals).toContain('finalizing');
  });

  // §9.22 pre-init result guard: Claude CLI --resume emits a historical result
  // (from the previous turn) before sending system.init for the new run.
  // Without this guard, that stale result would prematurely transition to
  // 'finalizing', freezing the card at "⏳ 等待进程退出" for the entire run.
  it('test_anchor_pre_init_result_ignored_when_sessionId_undefined', () => {
    const initial = createInitialRunState('run-1');
    // No system.init yet → sessionId is undefined
    expect(initial.sessionId).toBeUndefined();

    // result event before init should be completely ignored
    const afterResult = reduceRunState(initial, {
      type: 'result',
      subtype: 'success',
      session_id: 'stale-session',
    });
    expect(afterResult.terminal).toBe('running'); // NOT finalizing
    expect(afterResult.resultSubtype).toBeUndefined();
    expect(afterResult.footer).toBe('thinking'); // unchanged

    // After init, a result should work normally
    const inited = reduceRunState(afterResult, {
      type: 'system',
      subtype: 'init',
      session_id: 'real-session',
    });
    expect(inited.sessionId).toBe('real-session');

    const afterRealResult = reduceRunState(inited, {
      type: 'result',
      subtype: 'success',
      session_id: 'real-session',
    });
    expect(afterRealResult.terminal).toBe('finalizing');
    expect(afterRealResult.resultSubtype).toBe('success');
  });

  it('test_anchor_pre_init_result_error_also_ignored', () => {
    // Even error results before init should be ignored (they're stale replay)
    const initial = createInitialRunState('run-1');
    const afterResult = reduceRunState(initial, {
      type: 'result',
      subtype: 'error',
      session_id: 'stale-session',
      errorMessage: 'stale error',
    });
    expect(afterResult.terminal).toBe('running');
    expect(afterResult.errorMsg).toBeUndefined();
  });

  it('test_anchor_runFooter_excludes_background', () => {
    // RunFooter 移除 'background' 值（§4.1）。
    const footers: RunFooter[] = ['thinking', 'tool_running', 'streaming', null];
    expect(footers).not.toContain('background');
  });
});
