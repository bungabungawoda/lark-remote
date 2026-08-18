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
});
