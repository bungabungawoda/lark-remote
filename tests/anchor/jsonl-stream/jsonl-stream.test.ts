/**
 * Merged anchor tests for createJSONLStream
 *
 * Source files (merged 2026-08-04, Phase 4):
 *   - jsonl-stream-backpressure.test.ts
 *   - jsonl-stream-error-under-pause.test.ts
 *   - jsonl-stream-hysteresis.test.ts
 *   - jsonl-stream-no-pause-when-disabled.test.ts
 *   - jsonl-stream-resume-on-drain.test.ts
 *   - p2-14-jsonl-stream-partial-bound.test.ts
 *   - p3-1-jsonl-stream-chunk-accumulation.test.ts
 */
import { describe, expect, it, test, vi } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// P1-4 A1: createJSONLStream backpressure
// ---------------------------------------------------------------------------

describe('P1-4 A1: createJSONLStream backpressure', () => {
  test('test_anchor_jsonl_stream_pause_on_queue_depth', async () => {
    const readable = new Readable({ read() {} });
    const pauseSpy = vi.spyOn(readable, 'pause');
    const resumeSpy = vi.spyOn(readable, 'resume');

    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    const stream = createJSONLStream(readable, { pauseThreshold: 50, resumeThreshold: 10 });

    for (let i = 0; i < 60; i++) {
      readable.push(`{"type":"text","data":"chunk-${i}"}\n`);
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(pauseSpy).toHaveBeenCalled();

    let consumed = 0;
    for await (const _event of stream) {
      consumed++;
      if (consumed >= 55) break;
    }

    expect(resumeSpy).toHaveBeenCalled();

    readable.push(null);
    for await (const _ of stream) {
      break;
    }
  });
});

// ---------------------------------------------------------------------------
// P1-4 A3: stream error under pause
// ---------------------------------------------------------------------------

describe('P1-4 A3: stream error under pause', () => {
  test('test_anchor_jsonl_stream_error_terminates_generator', async () => {
    const readable = new Readable({ read() {} });

    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    const stream = createJSONLStream(readable, {
      pauseThreshold: 3,
      resumeThreshold: 1,
    });

    for (let i = 0; i < 5; i++) {
      readable.push(`{"type":"text","data":"line-${i}"}\n`);
    }

    const error = new Error('stdout pipe broken');
    process.nextTick(() => readable.destroy(error));

    const events: unknown[] = [];
    let rejected = false;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Generator hung on error under pause')), 2000),
    );
    await Promise.race([
      (async () => {
        try {
          for await (const event of stream) {
            events.push(event);
          }
        } catch {
          rejected = true;
        }
      })(),
      timeoutPromise,
    ]);

    expect(events.length > 0 || rejected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1-4 A3: backpressure hysteresis invariant
// ---------------------------------------------------------------------------

describe('P1-4 A3: backpressure hysteresis invariant', () => {
  test('test_anchor_jsonl_stream_resume_below_pause_threshold', async () => {
    const readable = new Readable({ read() {} });
    const pauseTimes: number[] = [];
    const resumeTimes: number[] = [];
    const origPause = readable.pause.bind(readable);
    const origResume = readable.resume.bind(readable);

    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    const stream = createJSONLStream(readable, {
      pauseThreshold: 10,
      resumeThreshold: 5,
    });

    readable.pause = function () {
      pauseTimes.push(pauseTimes.length);
      return origPause();
    };
    readable.resume = function () {
      resumeTimes.push(resumeTimes.length);
      return origResume();
    };

    for (let i = 0; i < 15; i++) {
      readable.push(`{"type":"text","data":"line-${i}"}\n`);
    }
    readable.push(null);

    for await (const _ of stream) {
      // drain all 15
    }

    expect(pauseTimes.length).toBeGreaterThanOrEqual(1);
    expect(resumeTimes.length).toBeGreaterThanOrEqual(1);
    expect(resumeTimes.length).toBeGreaterThanOrEqual(1);
  });

  test('test_anchor_jsonl_stream_resume_threshold_below_pause_threshold', async () => {
    const readable = new Readable({ read() {} });
    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    let pauseCount = 0;
    let resumeCount = 0;
    const origPause = readable.pause.bind(readable);
    const origResume = readable.resume.bind(readable);
    readable.pause = function () {
      pauseCount++;
      return origPause();
    };
    readable.resume = function () {
      resumeCount++;
      return origResume();
    };

    const stream = createJSONLStream(readable, {
      pauseThreshold: 10,
      resumeThreshold: 5,
    });

    for (let i = 0; i < 12; i++) {
      readable.push(`{"type":"text","data":"line-${i}"}\n`);
    }
    readable.push(null);

    let consumed = 0;
    for await (const _ of stream) {
      consumed++;
    }

    expect(pauseCount).toBeGreaterThanOrEqual(1);
    expect(resumeCount).toBeGreaterThanOrEqual(1);
    expect(pauseCount).toBeGreaterThanOrEqual(1);
    expect(consumed).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// P1-4 A4: backpressure disabled when pauseThreshold=0
// ---------------------------------------------------------------------------

describe('P1-4 A4: backpressure disabled when pauseThreshold=0', () => {
  test('test_anchor_jsonl_stream_no_pause_when_disabled', async () => {
    const readable = new Readable({ read() {} });
    const pauseSpy = vi.spyOn(readable, 'pause');

    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    const stream = createJSONLStream(readable, { pauseThreshold: 0 });

    for (let i = 0; i < 500; i++) {
      readable.push(`{"type":"text","data":"line-${i}"}\n`);
    }
    readable.push(null);

    for await (const _ of stream) {
      // drain all 500
    }

    expect(pauseSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P1-4 A5: resume on drain-to-empty prevents deadlock
// ---------------------------------------------------------------------------

describe('P1-4 A5: resume on drain-to-empty prevents deadlock', () => {
  test('test_anchor_jsonl_stream_resume_when_queue_drained', async () => {
    const readable = new Readable({ read() {} });
    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    let resumeCount = 0;
    const origPause = readable.pause.bind(readable);
    const origResume = readable.resume.bind(readable);
    readable.pause = function () {
      return origPause();
    };
    readable.resume = function () {
      resumeCount++;
      return origResume();
    };

    const stream = createJSONLStream(readable, {
      pauseThreshold: 5,
      resumeThreshold: 2,
    });

    for (let i = 0; i < 8; i++) {
      readable.push(`{"type":"text","data":"phase1-${i}"}\n`);
    }

    let phase1Count = 0;
    const drainPhase1 = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        stream.next().then((r) => {
          if (r.done) {
            clearInterval(interval);
            resolve();
            return;
          }
          phase1Count++;
          if (phase1Count >= 8) {
            clearInterval(interval);
            resolve();
          }
        });
      }, 5);
    });
    await drainPhase1;

    const resumeAfterPhase1 = resumeCount;
    expect(resumeAfterPhase1).toBeGreaterThan(0);

    let phase2Received = 0;
    for (let i = 0; i < 5; i++) {
      readable.push(`{"type":"text","data":"phase2-${i}"}\n`);
    }
    readable.push(null);

    for await (const _ of stream) {
      phase2Received++;
    }

    expect(phase2Received).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// P2-14: createJSONLStream bounds a never-newline single line
// ---------------------------------------------------------------------------

describe('P2-14: createJSONLStream bounds a never-newline single line', () => {
  it('test_anchor_jsonl_stream_truncates_oversize_partial_line', async () => {
    const onParseError = vi.fn();
    const readable = new Readable({ read() {} });

    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');
    const stream = createJSONLStream(readable, { onParseError });

    const big = 'x'.repeat(11 * 1024 * 1024);
    readable.push(big);

    await new Promise((r) => setTimeout(r, 30));

    expect(onParseError).toHaveBeenCalled();

    readable.push(null);
    for await (const _ of stream) {
      void _;
      break;
    }
  });
});

// ---------------------------------------------------------------------------
// P3-1: partialLine chunk-array accumulation
// ---------------------------------------------------------------------------

describe('P3-1: partialLine chunk-array accumulation', () => {
  test('test_anchor_jsonl_stream_large_single_line_across_chunks', async () => {
    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    const bigValue = 'x'.repeat(8000);
    const fullLine = `{"type":"text","data":"${bigValue}"}\n`;
    const chunkSize = 1000;
    const readable = new Readable({ read() {} });
    const stream = createJSONLStream(readable);

    for (let i = 0; i < fullLine.length; i += chunkSize) {
      readable.push(fullLine.slice(i, i + chunkSize));
    }
    readable.push(null);

    const events: unknown[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; data: string };
    expect(ev.type).toBe('text');
    expect(ev.data).toBe(bigValue);
    expect(ev.data).toHaveLength(8000);
  });

  test('test_anchor_jsonl_stream_trailing_partial_flush_on_end', async () => {
    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    const readable = new Readable({ read() {} });
    const stream = createJSONLStream(readable);

    readable.push('{"type":"a"}\n');
    readable.push('{"type":"b","v":1');
    readable.push('234}');
    readable.push(null);

    const events: unknown[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events).toHaveLength(2);
    expect((events[0] as { type: string }).type).toBe('a');
    expect((events[1] as { type: string; v: number }).v).toBe(1234);
  });

  test('test_anchor_jsonl_stream_multi_line_single_chunk', async () => {
    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    const readable = new Readable({ read() {} });
    const stream = createJSONLStream(readable);

    readable.push('{"i":1}\n{"i":2}\n{"i":3}\n');
    readable.push(null);

    const events: unknown[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.map((e) => (e as { i: number }).i)).toEqual([1, 2, 3]);
  });

  test('test_anchor_jsonl_stream_blank_lines_skipped', async () => {
    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    const readable = new Readable({ read() {} });
    const stream = createJSONLStream(readable);

    readable.push('{"i":1}\n\n  \n{"i":2}\n');
    readable.push(null);

    const events: unknown[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.map((e) => (e as { i: number }).i)).toEqual([1, 2]);
  });

  test('test_anchor_jsonl_stream_split_right_at_newline_boundary', async () => {
    const { createJSONLStream } = await import('../../../src/runner/common/jsonl-stream.js');

    const readable = new Readable({ read() {} });
    const stream = createJSONLStream(readable);

    readable.push('{"i":1}');
    readable.push('\n{"i":2}\n');
    readable.push(null);

    const events: unknown[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.map((e) => (e as { i: number }).i)).toEqual([1, 2]);
  });
});
