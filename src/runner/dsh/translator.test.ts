/**
 * Characterization 钉子：DshTranslator.eventToAgentEvents 的全部事件类型映射、
 * usage 累加口径、turn/end 终态与文案。纯结构拆分不得改变任何字段/顺序。
 */
import { describe, it, expect } from 'vitest';
import { DshTranslator, mapUsage } from './translator.js';
import type { DshSessionEvent } from '../../dsh/types.js';

const TIME = 1700000000000;
const TS = new Date(TIME).toISOString();

function ev(type: string, data: Record<string, unknown>, seq = 1): DshSessionEvent {
  return { type, seq, time: TIME, data };
}

function message(usage?: unknown, msg?: unknown, seq = 1): DshSessionEvent {
  return ev(
    'assistant/message',
    { ...(usage ? { usage } : {}), ...(msg ? { message: msg } : {}) },
    seq,
  );
}

function turnEnd(kind: string, error?: { message?: string }): DshSessionEvent {
  return ev('turn/end', { reason: { kind, ...(error ? { error } : {}) } });
}

describe('DshTranslator.eventToAgentEvents (characterization)', () => {
  it('text-delta chunk → assistant text event, timestamp from event.time', () => {
    const t = new DshTranslator();
    expect(
      t.eventToAgentEvents(
        ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'hello' } }),
        'sid',
      ),
    ).toEqual([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] }, timestamp: TS },
    ]);
  });

  it('reasoning-delta chunk → thinking with itemId r:0:<index>', () => {
    const t = new DshTranslator();
    expect(
      t.eventToAgentEvents(
        ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 3, text: 'hmm' } }),
        'sid',
      ),
    ).toEqual([
      {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'hmm', itemId: 'r:0:3' }] },
        timestamp: TS,
      },
    ]);
  });

  it('missing / empty / usage chunk → []', () => {
    const t = new DshTranslator();
    expect(t.eventToAgentEvents(ev('assistant/chunk', {}), 'sid')).toEqual([]);
    expect(
      t.eventToAgentEvents(
        ev('assistant/chunk', { chunk: { type: 'text-delta', text: '' } }),
        'sid',
      ),
    ).toEqual([]);
    expect(
      t.eventToAgentEvents(
        ev('assistant/chunk', {
          chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
        }),
        'sid',
      ),
    ).toEqual([]);
  });

  it('assistant/message records durable usage and final answer text', () => {
    const t = new DshTranslator();
    expect(
      t.eventToAgentEvents(
        message(
          { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
          {
            content: [
              { type: 'text', text: 'part1' },
              { type: 'text', text: 'part2' },
            ],
          },
        ),
        'sid',
      ),
    ).toEqual([]);
    expect(t.eventToAgentEvents(message({ inputTokens: 5, outputTokens: 1 }), 'sid')).toEqual([]);

    const out = t.eventToAgentEvents(turnEnd('completed'), 'sid');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: 'sid',
      timestamp: TS,
      finalAnswerText: 'part1part2',
      usage: {
        input_tokens: 15,
        output_tokens: 3,
        cache_read_tokens: 3,
        cache_creation_tokens: 4,
        total_tokens: 25,
      },
    });
  });

  it('only live usage chunk → turn/end falls back to last stream usage', () => {
    const t = new DshTranslator();
    t.eventToAgentEvents(
      ev('assistant/chunk', {
        chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 } },
      }),
      'sid',
    );
    const out = t.eventToAgentEvents(turnEnd('completed'), 'sid');
    expect(out[0]).toMatchObject({
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_tokens: 2,
        cache_creation_tokens: 0,
        total_tokens: 12,
      },
    });
  });

  it('no usage at all → turn/end has no usage field', () => {
    const t = new DshTranslator();
    const out = t.eventToAgentEvents(turnEnd('completed'), 'sid');
    expect(out[0]).not.toHaveProperty('usage');
  });

  it('turn/end subtype mapping and error message wording', () => {
    for (const kind of ['completed']) {
      const t = new DshTranslator();
      expect(t.eventToAgentEvents(turnEnd(kind), 'sid')[0]).toMatchObject({ subtype: 'success' });
    }
    for (const kind of ['aborted', 'interrupted', 'forked']) {
      const t = new DshTranslator();
      expect(t.eventToAgentEvents(turnEnd(kind), 'sid')[0]).toMatchObject({
        subtype: 'interrupted',
      });
    }
    for (const kind of ['error', 'max-tokens', 'blocked', 'weird']) {
      const t = new DshTranslator();
      expect(t.eventToAgentEvents(turnEnd(kind), 'sid')[0]).toMatchObject({
        subtype: 'error',
        errorMessage: `turn ended with reason: ${kind}`,
      });
    }
    const t = new DshTranslator();
    expect(t.eventToAgentEvents(turnEnd('error', { message: 'detail x' }), 'sid')[0]).toMatchObject(
      {
        subtype: 'error',
        errorMessage: 'turn ended with reason: error: detail x',
      },
    );
  });

  it('tool/call → assistant.tool_use with parsed arguments', () => {
    const t = new DshTranslator();
    expect(
      t.eventToAgentEvents(
        ev('tool/call', { callId: 'c1', name: 'Bash', arguments: '{"command":"ls"}' }),
        'sid',
      ),
    ).toEqual([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }],
        },
        timestamp: TS,
      },
    ]);
    // 非 JSON 字符串参数保持原文
    expect(
      t.eventToAgentEvents(ev('tool/call', { callId: 'c2', name: 'X', arguments: 'plain' }), 'sid'),
    ).toEqual([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'c2', name: 'X', input: 'plain' }] },
        timestamp: TS,
      },
    ]);
    // 缺 id/name → []
    expect(t.eventToAgentEvents(ev('tool/call', { name: 'X' }), 'sid')).toEqual([]);
    expect(t.eventToAgentEvents(ev('tool/call', { callId: 'c3' }), 'sid')).toEqual([]);
  });

  it('tool/call 的空白串 / 非字符串 / 带空白 JSON arguments 都产出可见 input', () => {
    const inputOf = (args: unknown): unknown => {
      const t = new DshTranslator();
      const out = t.eventToAgentEvents(
        ev('tool/call', { callId: 'c', name: 'Bash', arguments: args }),
        'sid',
      );
      return (out[0] as unknown as { message: { content: Array<{ input: unknown }> } }).message
        .content[0].input;
    };
    expect(inputOf('   ')).toEqual({});
    expect(inputOf({ a: 1 })).toEqual({ a: 1 });
    expect(inputOf(undefined)).toEqual({});
    expect(inputOf('  {"x":1}  ')).toEqual({ x: 1 });
  });

  it('tool/result → user.tool_result with flattened content and is_error', () => {
    const t = new DshTranslator();
    expect(
      t.eventToAgentEvents(
        ev('tool/result', {
          message: {
            toolCallId: 'c1',
            content: [{ type: 'text', text: 'line1' }, { type: 'image', data: 'x' }, 'raw'],
            isError: true,
          },
        }),
        'sid',
      ),
    ).toEqual([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'c1',
              content: 'line1\n[image]\nraw',
              is_error: true,
            },
          ],
        },
        timestamp: TS,
      },
    ]);
    // 字符串 content 直接透传；缺 toolCallId → []
    expect(
      t.eventToAgentEvents(
        ev('tool/result', { message: { toolCallId: 'c2', content: 'just text' } }),
        'sid',
      ),
    ).toEqual([
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'c2', content: 'just text', is_error: false },
          ],
        },
        timestamp: TS,
      },
    ]);
    expect(t.eventToAgentEvents(ev('tool/result', { message: {} }), 'sid')).toEqual([]);
  });

  it('tool/result without content falls back to error.message hint', () => {
    const t = new DshTranslator();
    const out = t.eventToAgentEvents(
      ev('tool/result', { message: { toolCallId: 'c1' }, error: { message: 'boom' } }),
      'sid',
    );
    expect(out[0]).toMatchObject({
      message: { content: [{ content: 'boom' }] },
    });
  });

  it('unknown event types → []', () => {
    const t = new DshTranslator();
    expect(t.eventToAgentEvents(ev('something/else', {}), 'sid')).toEqual([]);
  });

  it('mapUsage exported helper keeps the cacheWrite → cache_creation mapping', () => {
    expect(
      mapUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
    ).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 3,
      cache_creation_tokens: 4,
      total_tokens: 10,
    });
  });
});
