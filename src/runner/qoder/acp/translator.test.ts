/**
 * Unit tests for QoderAcpTranslator: notification / server-request → AgentEvent
 * translation pinned against the shapes the mock ACP server emits.
 *
 * Wire 细节按保守口径（qoder ACP 未真机验证）：thinking 身份只用 wire 自带
 * messageId；tool content 不当 args；tool_result 取对象 .text / 字符串透传。
 */

import { describe, expect, it } from 'vitest';
import { QoderAcpTranslator } from './translator.js';

function translate(
  translator: QoderAcpTranslator,
  update: Record<string, unknown>,
  sessionId = 'aaaaaaaa-1111-2222-3333-444444444444',
) {
  return translator.handleNotification('session/update', { sessionId, update });
}

describe('QoderAcpTranslator', () => {
  it('agent_message_chunk → assistant text delta (direct passthrough)', () => {
    const translator = new QoderAcpTranslator();
    const events = translate(translator, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '你好' },
    });
    expect(events).toHaveLength(1);
    const event = events[0] as unknown as {
      type: string;
      message: { content: Array<Record<string, unknown>> };
    };
    expect(event.type).toBe('assistant');
    expect(event.message.content[0]).toEqual({ type: 'text', text: '你好' });
  });

  it('agent_thought_chunk → thinking block with wire messageId as itemId', () => {
    const translator = new QoderAcpTranslator();
    const events = translate(translator, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '思考中' },
      messageId: 'msg-1',
    });
    const event = events[0] as unknown as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(event.message.content[0]).toEqual({
      type: 'thinking',
      thinking: '思考中',
      itemId: 'msg-1',
    });
  });

  it('tool_call with execute kind → Bash tool_use panel with parsed rawInput', () => {
    const translator = new QoderAcpTranslator();
    const events = translate(translator, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Bash: ls',
      kind: 'execute',
      rawInput: { command: 'ls /home/user/project' },
    });
    const event = events[0] as unknown as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(event.message.content[0]).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'Bash',
      input: { command: 'ls /home/user/project' },
    });
  });

  it('tool_call_update completed with object rawOutput → tool_result text extraction', () => {
    const translator = new QoderAcpTranslator();
    const events = translate(translator, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      rawOutput: { type: 'text', text: 'Stdout: ok' },
    });
    const toolResult = events.find(
      (e) => (e as { message?: { content?: Array<Record<string, unknown>> } }).message,
    ) as unknown as { message: { content: Array<Record<string, unknown>> } };
    expect(toolResult.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: 'Stdout: ok',
      is_error: false,
    });
  });

  it('tool_call_update failed → tool_result with is_error', () => {
    const translator = new QoderAcpTranslator();
    const events = translate(translator, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'failed',
      rawOutput: 'boom',
    });
    const toolResult = events.find(
      (e) => (e as { message?: { content?: Array<Record<string, unknown>> } }).message,
    ) as unknown as { message: { content: Array<Record<string, unknown>> } };
    expect(toolResult.message.content[0]).toMatchObject({
      type: 'tool_result',
      content: 'boom',
      is_error: true,
    });
  });

  it('usage_update → context occupancy folded into the prompt result', () => {
    const translator = new QoderAcpTranslator();
    translate(translator, {
      sessionUpdate: 'usage_update',
      used: 1234,
      size: 1000000,
    });
    const result = translator.handlePromptResponse('s1', { stopReason: 'end_turn' }) as {
      subtype?: string;
      usage?: Record<string, number>;
    };
    expect(result.subtype).toBe('success');
    expect(result.usage?.total_tokens).toBe(1234);
    expect(result.usage?.context_limit).toBe(1000000);
  });

  it('request_permission with toolCall → approval_requested with command + decisions', () => {
    const translator = new QoderAcpTranslator();
    const events = translator.handleServerRequest(42, 'session/request_permission', {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'call_perm',
        title: 'Bash: ls /home/user/project',
        kind: 'bash',
        status: 'pending',
        rawInput: { command: 'ls /home/user/project', description: '列出目录' },
      },
      options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    });
    expect(events).toHaveLength(1);
    const event = events[0] as unknown as {
      type: string;
      requestId: number;
      view: Record<string, unknown>;
    };
    expect(event.type).toBe('approval_requested');
    expect(event.requestId).toBe(42);
    expect(event.view.command).toBe('ls /home/user/project');
    expect(event.view.reason).toBe('列出目录');
    expect(event.view.availableDecisions).toEqual([
      'accept',
      'decline',
      'cancel',
      'acceptForSession',
    ]);
  });

  it('request_permission without toolCall → no events (runner fallback responds METHOD_NOT_FOUND)', () => {
    const translator = new QoderAcpTranslator();
    const events = translator.handleServerRequest(43, 'session/request_permission', {
      sessionId: 's1',
      options: [{ optionId: 'skip', kind: 'reject_once', name: 'Skip' }],
    });
    expect(events).toEqual([]);
  });

  it('prompt stopReason mapping: end_turn/cancelled/other → success/interrupted/error', () => {
    const translator = new QoderAcpTranslator();
    expect(
      (translator.handlePromptResponse('s1', { stopReason: 'end_turn' }) as { subtype?: string })
        .subtype,
    ).toBe('success');
    expect(
      (translator.handlePromptResponse('s1', { stopReason: 'cancelled' }) as { subtype?: string })
        .subtype,
    ).toBe('interrupted');
    expect(
      (translator.handlePromptResponse('s1', { stopReason: 'refusal' }) as { subtype?: string })
        .subtype,
    ).toBe('error');
  });

  it('non-session/update notifications are ignored', () => {
    const translator = new QoderAcpTranslator();
    expect(translator.handleNotification('fs/read_text_file', {})).toEqual([]);
  });
});
