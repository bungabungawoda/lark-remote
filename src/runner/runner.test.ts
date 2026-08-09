import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createJSONLStream } from './common/jsonl-stream.js';
import type { AgentEvent } from './index.js';

function toReadable(chunks: string[]): Readable {
  const readable = new Readable({ read() {} });
  for (const chunk of chunks) {
    readable.push(chunk);
  }
  readable.push(null);
  return readable;
}

describe('createJSONLStream', () => {
  it('parses normal JSONL input', async () => {
    const input = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        cwd: '/tmp',
        model: 'opus',
      }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' }),
    ].join('\n');

    const readable = toReadable([input]);
    const events: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('system');
    expect(events[1].type).toBe('result');
  });

  it('handles last line without trailing newline', async () => {
    const line1 = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      cwd: '/tmp',
      model: 'opus',
    });
    const line2 = JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' });
    // No trailing \n
    const input = line1 + '\n' + line2;

    const readable = toReadable([input]);
    const events: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
  });

  it('skips empty lines', async () => {
    const line1 = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      cwd: '/tmp',
      model: 'opus',
    });
    const input = '\n' + line1 + '\n\n\n';

    const readable = toReadable([input]);
    const events: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
  });

  it('skips invalid JSON lines with warning', async () => {
    const line1 = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      cwd: '/tmp',
      model: 'opus',
    });
    const input =
      line1 +
      '\nnot-json\n' +
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' });

    const readable = toReadable([input]);
    const events: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      events.push(event);
    }

    // Invalid line is skipped
    expect(events).toHaveLength(2);
  });

  it('yields events as they arrive in chunks', async () => {
    const line1 = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      cwd: '/tmp',
      model: 'opus',
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });

    const readable = toReadable([line1 + '\n', line2 + '\n']);
    const events: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('system');
    expect(events[1].type).toBe('assistant');
  });

  it('delegates timestamp generation to runner (统一方案)', async () => {
    const readable = toReadable([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }) + '\n',
    ]);
    const events: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      events.push(event);
    }

    // 统一方案：jsonl-stream 不生成 timestamp，由 runner 的 translate 方法生成
    expect(events[0]?.timestamp).toBeUndefined();
  });

  it('passes through existing JSONL timestamp to runner', async () => {
    const timestamp = '2026-06-20T15:30:01.000Z';
    const readable = toReadable([
      JSON.stringify({
        type: 'assistant',
        timestamp,
        message: { content: [{ type: 'text', text: 'hello' }] },
      }) + '\n',
    ]);
    const events: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      events.push(event);
    }

    expect(events[0]?.timestamp).toBe(timestamp);
  });

  it('handles partial line split across chunks', async () => {
    const line1 = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      cwd: '/tmp',
      model: 'opus',
    });
    // Split the line across two chunks
    const half1 = line1.slice(0, 30);
    const half2 = line1.slice(30) + '\n';

    const readable = toReadable([half1, half2]);
    const events: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
  });

  it('flushes last line without trailing newline on close', async () => {
    const line1 = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      cwd: '/tmp',
      model: 'opus',
    });
    // No trailing \n
    const readable = toReadable([line1]);
    const events: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
  });

  it('parses all event types from design doc', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: '/tmp', model: 'opus' },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: '/tmp/a' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'file content', is_error: false },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 's1',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.01,
      },
    ];

    const input = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const readable = toReadable([input]);

    const parsed: AgentEvent[] = [];
    for await (const event of createJSONLStream(readable)) {
      parsed.push(event);
    }

    expect(parsed).toHaveLength(6);
    expect(parsed[0].type).toBe('system');
    expect(parsed[1].type).toBe('assistant');
    expect(parsed[2].type).toBe('assistant');
    expect(parsed[3].type).toBe('assistant');
    expect(parsed[4].type).toBe('user');
    expect(parsed[5].type).toBe('result');
  });
});
