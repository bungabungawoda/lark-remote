import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createJSONLStream } from './jsonl-stream.js';

/** Collect all items from an async generator into an array. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

/** Create a Readable from string chunks with { objectMode: false } so
 *  the stream emits Buffer chunks (matching real child-process stdout). */
function readableFromStrings(chunks: string[]): Readable {
  return Readable.from(chunks, { objectMode: false });
}

describe('createJSONLStream', () => {
  it('parses normal JSONL input', async () => {
    const input =
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', cwd: '/tmp' }) +
      '\n' +
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' }) +
      '\n';
    const stream = readableFromStrings([input]);
    const events = await collect(createJSONLStream(stream));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(events[1]).toMatchObject({ type: 'result', subtype: 'success' });
  });

  it('yields events as they arrive in chunks', async () => {
    const line1 = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      cwd: '/tmp',
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    const stream = readableFromStrings([line1 + '\n', line2 + '\n']);
    const events = await collect(createJSONLStream(stream));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'system' });
    expect(events[1]).toMatchObject({ type: 'assistant' });
  });

  it('delegates timestamp generation to runner (统一方案)', async () => {
    const input =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }) + '\n';
    const stream = readableFromStrings([input]);
    const events = await collect(createJSONLStream(stream));

    // 统一方案：jsonl-stream 不生成 timestamp，由 runner 的 translate 方法生成
    expect(events[0]).not.toHaveProperty('timestamp');
  });

  it('passes through existing JSONL timestamp to runner', async () => {
    const timestamp = '2026-06-20T15:30:01.000Z';
    const input =
      JSON.stringify({
        type: 'assistant',
        timestamp,
        message: { content: [{ type: 'text', text: 'hello' }] },
      }) + '\n';
    const stream = readableFromStrings([input]);
    const events = await collect(createJSONLStream(stream));

    expect(events[0]).toMatchObject({ timestamp });
  });

  it('parses all event types from design doc', async () => {
    const events = [
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
    ] as const;
    const input = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const stream = readableFromStrings([input]);
    const parsed = await collect(createJSONLStream(stream));

    expect(parsed).toHaveLength(6);
    expect(parsed.map((e) => e.type)).toEqual([
      'system',
      'assistant',
      'assistant',
      'assistant',
      'user',
      'result',
    ]);
  });

  describe('onParseError option', () => {
    // 1. onParseError callback is invoked for bad JSON lines, bad lines are skipped
    it('invokes onParseError for bad JSON lines and skips them', async () => {
      const onParseError = vi.fn();
      const input = '{"a":1}\nnot json at all\n{"b":2}\n';
      const stream = readableFromStrings([input]);
      const events = await collect(createJSONLStream(stream, { onParseError }));

      expect(events).toEqual([{ a: 1 }, { b: 2 }]);
      expect(onParseError).toHaveBeenCalledTimes(1);
      expect(onParseError).toHaveBeenCalledWith('not json at all');
    });

    // 2. onParseError receives multiple bad lines
    it('invokes onParseError for each bad line, preserving good lines in order', async () => {
      const onParseError = vi.fn();
      const input = '{"a":1}\nbad1\n{"b":2}\nbad2\n{"c":3}\n';
      const stream = readableFromStrings([input]);
      const events = await collect(createJSONLStream(stream, { onParseError }));

      expect(events).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
      expect(onParseError).toHaveBeenCalledTimes(2);
      expect(onParseError).toHaveBeenCalledWith('bad1');
      expect(onParseError).toHaveBeenCalledWith('bad2');
    });

    // 3. Existing behavior: bad lines are silently skipped when no options provided
    it('skips bad JSON lines silently when no options provided', async () => {
      const input = '{"a":1}\nnot json\n{"b":2}\n';
      const stream = readableFromStrings([input]);
      const events = await collect(createJSONLStream(stream));

      expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    });

    // 4. Existing behavior: partial line across chunks is flushed at stream end
    it('flushes partial line at stream end across chunks', async () => {
      const stream = readableFromStrings(['{"a":1}\n{"b":2}']);
      const events = await collect(createJSONLStream(stream));

      expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    });

    // 5. Existing behavior: empty and whitespace-only lines are ignored
    it('ignores empty and whitespace-only lines', async () => {
      const input = '{"a":1}\n\n   \n{"b":2}\n';
      const stream = readableFromStrings([input]);
      const events = await collect(createJSONLStream(stream));

      expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    });
  });
});
