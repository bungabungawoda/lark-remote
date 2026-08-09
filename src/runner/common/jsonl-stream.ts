import { getLogger } from '../../logger/index.js';
import type { AgentEvent } from '../types.js';
import type { Readable } from 'node:stream';

/** Options for {@link createJSONLStream}. */
interface JSONLStreamOptions {
  onParseError?: (line: string) => void;
  /**
   * Pause stdout once `lineQueue` exceeds this depth (P1-4 backpressure).
   * Default 100 (matches production; tests may pass a smaller value).
   */
  pauseThreshold?: number;
  /**
   * Resume stdout once `lineQueue` drains to or below this depth. Must be
   * <= `pauseThreshold`. Only meaningful when `pauseThreshold > 0`.
   */
  resumeThreshold?: number;
}

/**
 * Parse JSONL (newline-delimited JSON) from a readable stream.
 *
 * Handles:
 * - Partial lines at buffer boundaries
 * - Trailing incomplete lines (flush on stream end/close)
 * - JSON parse errors: when `options.onParseError` is provided, bad lines are
 *   forwarded to the callback; otherwise a warning is logged via getLogger().warn
 *   and the line is skipped.
 * - Optional backpressure (P1-4): when `pauseThreshold` is set, stdout is
 *   paused once the parsed-line queue exceeds the threshold and resumed once
 *   the consumer drains it back below `resumeThreshold`, bounding memory in
 *   long runs where the producer (agent stdout) outpaces the consumer (card
 *   rendering + SDK patch).
 *
 * This is the core stream parsing logic shared by Claude, Pi, and other
 * agents that emit JSONL output.
 *
 * Note: timestamp generation is delegated to each runner's translate method
 * (统一方案：所有 runner 自己生成 timestamp).
 */
export function createJSONLStream(
  stdout: Readable,
  options?: JSONLStreamOptions,
): AsyncGenerator<AgentEvent> {
  const lineQueue: string[] = [];
  // P3-1: accumulate partial-line fragments in an array instead of repeatedly
  // string-concatenating a growing `partialLine`. A huge single JSON line
  // (large tool_result / text_end) spanning many chunks caused O(n²) copies:
  // each chunk rebuilt `partialLine + text` over the whole accumulated prefix.
  // With a fragment array, we join only once per chunk (at the line boundary)
  // and push complete lines; the residual tail stays as array fragments until
  // the next newline or stream end. Net allocation: O(n) instead of O(n²).
  const partialFragments: string[] = [];
  // P2-14: accumulated byte length of partialFragments. Backpressure (above)
  // only counts COMPLETE lines in lineQueue; a never-newline stream (malformed
  // output, binary garbage) accumulates fragments without ever completing a
  // line, so pause never fires and memory grows unbounded. Cap the partial
  // line at 10MB: once exceeded, flush it as a bad line via onParseError and
  // reset the buffer, bounding peak memory for a single pathological line.
  const PARTIAL_BYTE_LIMIT = 10 * 1024 * 1024;
  let partialBytes = 0;
  const completeLines: string[] = [];
  let done = false;
  let resolveNext: (() => void) | null = null;
  // P1-4 backpressure thresholds. Default matches production (100).
  const pauseThreshold = options?.pauseThreshold ?? 100;
  // Default low-water mark is half the high-water mark for meaningful hysteresis
  // (avoids per-line pause/resume thrashing when callers don't set it explicitly).
  let resumeThreshold = options?.resumeThreshold ?? Math.max(0, Math.floor(pauseThreshold / 2));
  // Clamp misconfiguration: resumeThreshold > pauseThreshold would resume at queue
  // high water then immediately re-pause on the next line → thrash (P1-4 review nit).
  if (resumeThreshold > pauseThreshold) resumeThreshold = pauseThreshold;
  let paused = false;

  function notify() {
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  }

  // Flush any trailing partial line and mark the stream finished. Shared by the
  // 'end'/'close'/'error' handlers so flush logic lives in one place (P1-4 review nit).
  function flushAndFinish() {
    if (partialFragments.length > 0) {
      const trimmed = partialFragments.join('').trim();
      if (trimmed) lineQueue.push(trimmed);
      partialFragments.length = 0;
      partialBytes = 0;
    }
    done = true;
    notify();
  }

  // P2-14: flush an oversize partial line as a bad line. When partialFragments
  // exceeds the byte cap, the partial line is treated as malformed (a single
  // JSON line should never reach 10MB) and reported via onParseError rather
  // than accumulated indefinitely. Resets the buffer so a pathological stream
  // cannot leak memory line after line.
  function flushOversizePartial() {
    if (partialFragments.length === 0) return;
    const line = partialFragments.join('');
    partialFragments.length = 0;
    partialBytes = 0;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (options?.onParseError) {
      options.onParseError(trimmed);
    } else {
      getLogger().warn(`[jsonl-stream] dropped oversize partial line (${line.length} bytes)`);
    }
  }

  // Apply backpressure after pushing new lines: pause stdout when the queue
  // exceeds the high-water mark so the producer stops feeding until the
  // consumer drains it. P1-4 bounds memory in long runs.
  function maybePause() {
    if (pauseThreshold > 0 && !paused && lineQueue.length > pauseThreshold) {
      paused = true;
      stdout.pause();
    }
  }

  // Release backpressure after consuming a line: resume stdout once the queue
  // drains to the low-water mark so the producer can feed again.
  function maybeResume() {
    if (paused && lineQueue.length <= resumeThreshold) {
      paused = false;
      stdout.resume();
    }
  }

  stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    // P3-1: split on newlines. The first segment continues the pending partial
    // line (joined with accumulated fragments — one join per chunk, not per
    // byte); subsequent segments are complete lines. The last segment is the
    // new partial tail (kept as a single fragment).
    const segments = text.split('\n');
    if (segments.length === 1) {
      // No newline in this chunk: the whole chunk is a partial fragment.
      partialFragments.push(segments[0]);
      partialBytes += segments[0].length;
      // P2-14: cap the partial line. A never-newline stream would otherwise
      // accumulate fragments without bound (backpressure only counts complete
      // lines). Flush as a bad line once the byte cap is exceeded.
      if (partialBytes > PARTIAL_BYTE_LIMIT) {
        flushOversizePartial();
      }
    } else {
      // First segment completes the pending line.
      partialFragments.push(segments[0]);
      partialBytes += segments[0].length;
      completeLines.push(partialFragments.join(''));
      partialFragments.length = 0;
      partialBytes = 0;
      // Middle segments are each complete lines.
      for (let i = 1; i < segments.length - 1; i++) {
        completeLines.push(segments[i]);
      }
      // Last segment is the new partial tail.
      partialFragments.push(segments[segments.length - 1]);
      partialBytes = segments[segments.length - 1].length;
      // P2-14: the trailing partial tail can itself exceed the cap if a single
      // chunk is larger than 10MB with no internal newline.
      if (partialBytes > PARTIAL_BYTE_LIMIT) {
        flushOversizePartial();
      }
    }
    // Push complete lines into the queue (skipping blank/whitespace-only).
    for (const line of completeLines) {
      const trimmed = line.trim();
      if (trimmed) lineQueue.push(trimmed);
    }
    completeLines.length = 0;
    notify();
    maybePause();
  });

  stdout.on('end', () => {
    flushAndFinish();
  });

  stdout.on('close', () => {
    flushAndFinish();
  });

  // P1-4: handle stdout 'error' so the generator terminates instead of
  // hanging forever on the `await new Promise` below. Without this, a stdout
  // error (e.g. broken pipe, runner crash) leaves the consumer awaiting a
  // notify that never comes → bridge serial queue blocks permanently. We do
  // not re-throw the error through the generator (the runner's `try/catch`
  // around `for await` and the proc 'close' path already surface failures via
  // the unified result event); we only guarantee the generator ends. The error
  // is logged for diagnosis.
  stdout.on('error', (err: Error) => {
    getLogger().warn(`[jsonl-stream] stdout error: ${err.message}`);
    flushAndFinish();
  });

  async function* generator(): AsyncGenerator<AgentEvent> {
    while (true) {
      while (lineQueue.length > 0) {
        const line = lineQueue.shift()!;
        try {
          yield JSON.parse(line) as AgentEvent;
        } catch {
          if (options?.onParseError) {
            options.onParseError(line);
          } else {
            getLogger().warn(`[jsonl-stream] failed to parse JSONL: ${line.slice(0, 100)}`);
          }
        }
        maybeResume();
      }
      if (done) return;
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
  }

  return generator();
}
