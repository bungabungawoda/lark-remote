import { describe, it, expect } from 'vitest';
import { PiRpcTranslator } from './translator.js';
import type { PiRpcEvent } from './protocol-types.js';

function update(type: string, extra: Record<string, unknown> = {}): PiRpcEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: type as never, ...extra } as never,
  } as unknown as PiRpcEvent;
}

describe('PiRpcTranslator', () => {
  it('test_anchor_maps_message_stream_to_assistant_events', () => {
    const t = new PiRpcTranslator();
    t.setSessionId('aaaaaaaa-1111-2222-3333-444444444444');

    expect(
      t.handleEvent({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    ).toEqual([]);
    expect(t.handleEvent(update('text_start'))).toEqual([]);
    expect(t.handleEvent(update('text_delta', { delta: 'Hello' }))).toEqual([]);
    expect(t.handleEvent(update('text_delta', { delta: ' world' }))).toEqual([]);
    expect(t.handleEvent(update('text_end', { content: 'Hello world' }))).toEqual([]);

    const end = t.handleEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
        usage: { input: 100, output: 20 },
      },
    });
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ type: 'assistant' });
    expect((end[0] as { message: { content: Array<{ text: string }> } }).message.content).toEqual([
      { type: 'text', text: 'Hello world' },
    ]);
  });

  it('test_anchor_agent_settled_produces_success_result_for_turn', () => {
    const t = new PiRpcTranslator();
    t.setSessionId('aaaaaaaa-1111-2222-3333-444444444444');
    t.setOperationKind('turn');

    const events = t.handleEvent({ type: 'agent_settled' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: 'aaaaaaaa-1111-2222-3333-444444444444',
    });
  });

  it('test_anchor_agent_settled_ignored_for_compaction_turn', () => {
    const t = new PiRpcTranslator();
    t.setSessionId('aaaaaaaa-1111-2222-3333-444444444444');
    t.setOperationKind('compact');
    expect(t.handleEvent({ type: 'agent_settled' })).toEqual([]);
  });

  it('test_anchor_accumulates_usage_into_result', () => {
    const t = new PiRpcTranslator();
    t.setSessionId('aaaaaaaa-1111-2222-3333-444444444444');
    t.handleEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, totalTokens: 128 },
      },
    });
    t.handleEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'b' }],
        usage: { input: 50, output: 10, cacheRead: 2, cacheWrite: 1, totalTokens: 64 },
      },
    });

    const result = t.produceResultFromSettled();
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 150,
        output_tokens: 30,
        cache_read_tokens: 7,
        cache_creation_tokens: 4,
        total_tokens: 64,
      },
    });
  });

  it('test_anchor_stop_reason_error_produces_error_result', () => {
    const t = new PiRpcTranslator();
    t.setSessionId('aaaaaaaa-1111-2222-3333-444444444444');
    t.handleEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Connection error.',
      },
    });
    const result = t.produceResultFromSettled();
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'error',
      errorMessage: 'Connection error.',
    });
  });

  it('test_anchor_maps_toolResult_to_user_event', () => {
    const t = new PiRpcTranslator();
    t.setSessionId('aaaaaaaa-1111-2222-3333-444444444444');
    const events = t.handleEvent({
      type: 'message_end',
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: 'ok' }],
        toolCallId: 'tool-1',
        isError: false,
      },
    });
    expect(events[0]).toMatchObject({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false }],
      },
    });
  });

  it('test_anchor_turn_started_reflects_operation_kind', () => {
    const t = new PiRpcTranslator();
    const turn = t.produceTurnStarted('aaaaaaaa-1111-2222-3333-444444444444', 't1');
    expect(turn.operationKind).toBe('turn');

    const c = new PiRpcTranslator();
    c.setOperationKind('compact');
    const ct = c.produceTurnStarted('aaaaaaaa-1111-2222-3333-444444444444', 'c1');
    expect(ct.operationKind).toBe('compaction');
  });

  it('test_anchor_compact_success_result', () => {
    const t = new PiRpcTranslator();
    const r = t.produceCompactResult('aaaaaaaa-1111-2222-3333-444444444444', {
      id: 'req_1',
      type: 'response',
      command: 'compact',
      success: true,
      data: {},
    });
    expect(r).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: 'aaaaaaaa-1111-2222-3333-444444444444',
    });
  });

  it('test_anchor_compact_error_result_carries_message', () => {
    const t = new PiRpcTranslator();
    const r = t.produceCompactResult('aaaaaaaa-1111-2222-3333-444444444444', {
      id: 'req_1',
      type: 'response',
      command: 'compact',
      success: false,
      error: 'Nothing to compact (session too small)',
    });
    expect(r).toMatchObject({
      type: 'result',
      subtype: 'error',
      errorMessage: 'Nothing to compact (session too small)',
    });
  });

  // =========================================================================
  // 信息保真 C3.4：compaction 通知 / reasoning token / toolcall 占位
  // =========================================================================

  it('test_anchor_compaction_start_produces_info_notice_with_reason', () => {
    const t = new PiRpcTranslator();
    const events = t.handleEvent({ type: 'compaction_start', reason: 'placeholder' });
    expect(events).toHaveLength(1);
    const notice = events[0] as { type: string; level: string; code?: string; text: string };
    expect(notice.type).toBe('notice');
    expect(notice.level).toBe('info');
    expect(notice.code).toBe('compaction');
    expect(notice.text).toContain('placeholder');
  });

  it('test_anchor_compaction_end_aborted_produces_warn_notice', () => {
    const t = new PiRpcTranslator();
    const events = t.handleEvent({
      type: 'compaction_end',
      aborted: true,
      errorMessage: 'placeholder',
    });
    expect(events).toHaveLength(1);
    const notice = events[0] as { type: string; level: string; code?: string; text: string };
    expect(notice.type).toBe('notice');
    expect(notice.level).toBe('warn');
    expect(notice.code).toBe('compaction');
    expect(notice.text).toContain('placeholder');
  });

  it('test_anchor_compaction_end_success_produces_info_notice', () => {
    const t = new PiRpcTranslator();
    const events = t.handleEvent({ type: 'compaction_end', aborted: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'notice', level: 'info' });
  });

  it('test_anchor_accumulates_reasoning_tokens_into_result_usage', () => {
    const t = new PiRpcTranslator();
    t.setSessionId('aaaaaaaa-1111-2222-3333-444444444444');
    t.handleEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        usage: { input: 100, output: 20, reasoning: 50 },
      },
    });
    t.handleEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'b' }],
        usage: { input: 50, output: 10, reasoning: 50 },
      },
    });
    const result = t.produceResultFromSettled();
    expect(result).toMatchObject({
      type: 'result',
      usage: { input_tokens: 150, reasoning_tokens: 100 },
    });
  });

  it('test_anchor_toolcall_start_emits_no_tool_use_placeholder', () => {
    const t = new PiRpcTranslator();
    t.setSessionId('aaaaaaaa-1111-2222-3333-444444444444');
    t.handleEvent({ type: 'message_start', message: { role: 'assistant', content: [] } });
    const startEvents = t.handleEvent(update('toolcall_start'));
    // toolcall_start 不再发空壳 tool_use（占位被工具块首见前的空 name 渲染）。
    expect(startEvents).toEqual([]);

    const endEvents = t.handleEvent(
      update('toolcall_end', {
        toolCall: { id: 'tool-1', name: 'Bash', arguments: { command: 'ls' } },
      }),
    );
    expect(endEvents).toEqual([]);
    const end = t.handleEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [] },
    });
    expect(end).toHaveLength(1);
    const content = (
      end[0] as {
        message: { content: Array<{ type: string; id: string; name: string; input: unknown }> };
      }
    ).message.content;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('test_anchor_message_end_resets_pending_tool_call', () => {
    // 防御：toolcall_start 后若永无 toolcall_end（异常流），message_end 必须
    // 复位 pending 状态——否则下一条 assistant 消息的 toolcall_end 会凭空
    // 补发一个无 start 的 tool_use。
    const t = new PiRpcTranslator();
    t.setSessionId('aaaaaaaa-1111-2222-3333-444444444444');
    t.handleEvent({ type: 'message_start', message: { role: 'assistant', content: [] } });
    t.handleEvent(update('toolcall_start'));
    t.handleEvent({ type: 'message_end', message: { role: 'assistant', content: [] } });

    // 下一条消息：未 start 直接 end → 不应产出 tool_use
    t.handleEvent({ type: 'message_start', message: { role: 'assistant', content: [] } });
    t.handleEvent(
      update('toolcall_end', {
        toolCall: { id: 'tool-orphan', name: 'Bash', arguments: { command: 'ls' } },
      }),
    );
    const end = t.handleEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [] },
    });
    const content = (end[0] as { message: { content: Array<{ type: string }> } }).message.content;
    expect(content.filter((c) => c.type === 'tool_use')).toHaveLength(0);
  });
});
