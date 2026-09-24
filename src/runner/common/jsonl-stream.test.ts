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

/** A push-driven stdout whose pause()/resume() calls are counted. */
function makeStdout() {
  const stdout = new Readable({ read() {} });
  const marks = { pause: 0, resume: 0 };
  const origPause = stdout.pause.bind(stdout);
  const origResume = stdout.resume.bind(stdout);
  stdout.pause = () => {
    marks.pause += 1;
    return origPause();
  };
  stdout.resume = () => {
    marks.resume += 1;
    return origResume();
  };
  return { stdout, marks };
}

/** Let every queued 'data' event for already-pushed chunks be delivered. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Push n one-line JSON chunks (each ends with a newline → n complete lines). */
async function pushLines(stdout: Readable, n: number, tag = 'line'): Promise<void> {
  for (let i = 0; i < n; i++) stdout.push(`{"i":${i},"t":"${tag}"}\n`);
  await settle();
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

  // 背压的水位线只在"恰好等于"这一点上有意义：早一行是多一次 pause/resume 抖动，
  // 晚一行是队列再也不降、stdout 永久停住。既有锚点用例都用远离边界的深度
  // （50/10、10/5、20/10），所以把 `>` 改成 `>=`、把缺省 100 改成 0 都能全绿。
  describe('backpressure 水位边界（P1-4）', () => {
    it('pauses one line past the default high-water mark of 100', async () => {
      const { stdout, marks } = makeStdout();
      const gen = createJSONLStream(stdout);

      await pushLines(stdout, 100);
      expect(marks.pause).toBe(0);
      await pushLines(stdout, 1);
      expect(marks.pause).toBe(1);

      stdout.push(null);
      expect(await collect(gen)).toHaveLength(101);
    });

    it('resumes exactly when the queue drains to resumeThreshold', async () => {
      const { stdout, marks } = makeStdout();
      const gen = createJSONLStream(stdout, { pauseThreshold: 3, resumeThreshold: 1 });
      // 挂上 'data' 监听器时 Node 自己会先 resume 一次，放行次数按这之后算。
      const opened = marks.resume;

      await pushLines(stdout, 4);
      expect(marks.pause).toBe(1);

      // maybeResume 在消费者取下一行之前评估，所以第 k 次取用看到的是取走
      // k-1 行之后的深度：深度 3、2 都不该放行，到 1 才放行。
      await gen.next();
      await gen.next();
      await gen.next();
      expect(marks.resume - opened).toBe(0);
      await gen.next();
      expect(marks.resume - opened).toBe(1);

      stdout.push(null);
      await collect(gen);
    });

    it('derives the default resume mark as half the pause mark', async () => {
      const { stdout, marks } = makeStdout();
      const gen = createJSONLStream(stdout, { pauseThreshold: 8 });
      const opened = marks.resume;

      await pushLines(stdout, 9);
      expect(marks.pause).toBe(1);
      // 缺省低水位 = floor(8/2) = 4：深度降到 4 那次取用才放行。
      for (let i = 0; i < 5; i++) await gen.next();
      expect(marks.resume - opened).toBe(0);
      await gen.next();
      expect(marks.resume - opened).toBe(1);

      stdout.push(null);
      await collect(gen);
    });

    it('with pauseThreshold 1 the default resume mark is 0, not 1', async () => {
      const { stdout, marks } = makeStdout();
      const gen = createJSONLStream(stdout, { pauseThreshold: 1 });
      const opened = marks.resume;

      await pushLines(stdout, 2);
      expect(marks.pause).toBe(1);
      // floor(1/2)=0 会被 max(0,…) 保住：残留 1 行时放行等于把滞回压成 0 宽度，
      // 下一行刚到就又 pause，退化成逐行抖动。
      await gen.next();
      await gen.next();
      expect(marks.resume - opened).toBe(0);
      stdout.push(null);
      expect((await gen.next()).done).toBe(true);
      expect(marks.resume - opened).toBe(1);

      await collect(gen);
    });
  });

  // P2-14 的单行字节上限：累计量必须跨 chunk 相加，而不是每个 chunk 重新计数。
  // 写成 `partialBytes = segments[0].length` 后，永不换行的输出（二进制垃圾、
  // 半截 JSON）再也不会越界，内存无上限增长，而既有锚点只喂了一个 11MB 整块。
  describe('oversize partial line（P2-14）', () => {
    it('accumulates partial bytes across chunks and drops only past the cap', async () => {
      const CAP = 10 * 1024 * 1024;
      const MB = 1024 * 1024;
      const dropped: number[] = [];
      const { stdout } = makeStdout();
      const gen = createJSONLStream(stdout, {
        onParseError: (line) => {
          dropped.push(line.length);
        },
      });

      const whole = 'x'.repeat(CAP);
      for (let off = 0; off < CAP; off += MB) stdout.push(whole.slice(off, off + MB));
      await settle();
      expect(dropped).toEqual([]);

      stdout.push('y');
      await settle();
      expect(dropped).toEqual([CAP + 1]);

      stdout.push(null);
      expect(await collect(gen)).toEqual([]);
      expect(dropped).toEqual([CAP + 1]);
    });
  });
});
