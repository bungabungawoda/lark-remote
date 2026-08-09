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

describe('createJSONLStream onParseError option', () => {
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
