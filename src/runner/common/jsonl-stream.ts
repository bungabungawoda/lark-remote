import { getLogger } from '../../logger/index.js';
import type { AgentEvent } from '../types.js';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Options for {@link createJSONLStream}. */
interface JSONLStreamOptions {
  onParseError?: (line: string) => void;
  /**
   * Pause stdout once `lineQueue` exceeds this depth (backpressure).
   * Default 100 (matches production; tests may pass a smaller value).
   */
  pauseThreshold?: number;
  /**
   * Resume stdout once `lineQueue` drains to or below this depth. Must be
   * <= `pauseThreshold`. Only meaningful when `pauseThreshold > 0`.
   */
  resumeThreshold?: number;
}

// =============================================================================
// createJSONLStream 的模块级命名 handler（闭包搬出，状态显式打包进 state）
// =============================================================================

interface JSONLStreamState {
  lineQueue: string[];
  partialFragments: string[];
  decoder: StringDecoder;
  completeLines: string[];
  done: boolean;
  resolveNext: (() => void) | null;
  partialBytes: number;
  pauseThreshold: number;
  resumeThreshold: number;
  paused: boolean;
  partialByteLimit: number;
  stdout: Readable;
  options: JSONLStreamOptions | undefined;
}

function notify(state: JSONLStreamState): void {
  if (state.resolveNext) {
    state.resolveNext();
    state.resolveNext = null;
  }
}

/** Flush trailing partial line and mark the stream finished (end/close/error 共用). */
function flushAndFinish(state: JSONLStreamState): void {
  // decoder.end() 吐出被 chunk 边界切开的最后一个多字节字符的残余字节
  //（无残尾时返回空串）：不加这句，末尾被切开的字符会凭空丢失。
  const tail = state.decoder.end();
  if (tail) state.partialFragments.push(tail);
  if (state.partialFragments.length > 0) {
    const trimmed = state.partialFragments.join('').trim();
    if (trimmed) state.lineQueue.push(trimmed);
    state.partialFragments.length = 0;
    state.partialBytes = 0;
  }
  state.done = true;
  notify(state);
}

/** 超长 partial line 当坏行经 onParseError 上报并清空，避免无换行流吃满内存。 */
function flushOversizePartial(state: JSONLStreamState): void {
  if (state.partialFragments.length === 0) return;
  const line = state.partialFragments.join('');
  state.partialFragments.length = 0;
  state.partialBytes = 0;
  const trimmed = line.trim();
  if (!trimmed) return;
  if (state.options?.onParseError) {
    state.options.onParseError(trimmed);
  } else {
    getLogger().warn(`[jsonl-stream] dropped oversize partial line (${line.length} bytes)`);
  }
}

function maybePause(state: JSONLStreamState): void {
  if (state.pauseThreshold > 0 && !state.paused && state.lineQueue.length > state.pauseThreshold) {
    state.paused = true;
    state.stdout.pause();
  }
}

function maybeResume(state: JSONLStreamState): void {
  if (state.paused && state.lineQueue.length <= state.resumeThreshold) {
    state.paused = false;
    state.stdout.resume();
  }
}

/** 把本 chunk 产出的完整行移入 lineQueue（跳过空白行）。 */
function enqueueCompleteLines(state: JSONLStreamState): void {
  for (const line of state.completeLines) {
    const trimmed = line.trim();
    if (trimmed) state.lineQueue.push(trimmed);
  }
  state.completeLines.length = 0;
}

/** 无换行 chunk：整块作为 partial fragment，超限则按坏行冲掉。 */
function handleChunkWithoutNewline(state: JSONLStreamState, text: string): void {
  state.partialFragments.push(text);
  state.partialBytes += text.length;
  if (state.partialBytes > state.partialByteLimit) flushOversizePartial(state);
}

/** 有换行 chunk：首段补完 pending 行、中段为完整行、末段为新的 partial tail。 */
function handleChunkWithNewline(state: JSONLStreamState, segments: string[]): void {
  state.partialFragments.push(segments[0]);
  state.partialBytes += segments[0].length;
  state.completeLines.push(state.partialFragments.join(''));
  state.partialFragments.length = 0;
  state.partialBytes = 0;
  for (let i = 1; i < segments.length - 1; i++) {
    state.completeLines.push(segments[i]);
  }
  state.partialFragments.push(segments[segments.length - 1]);
  state.partialBytes = segments[segments.length - 1].length;
  // 单个 >10MB 且内部无换行的 chunk，其尾部 partial 自身也可能超限。
  if (state.partialBytes > state.partialByteLimit) flushOversizePartial(state);
}

function onDataChunk(state: JSONLStreamState, chunk: Buffer): void {
  // StringDecoder 按字节边界解码：多字节字符被 chunk 边界切开时裸 toString
  // 会产出不可逆的 U+FFFD（同族修复见 jsonrpc/transport.ts）。
  const text = state.decoder.write(chunk);
  const segments = text.split('\n');
  if (segments.length === 1) {
    handleChunkWithoutNewline(state, segments[0]);
  } else {
    handleChunkWithNewline(state, segments);
  }
  enqueueCompleteLines(state);
  notify(state);
  maybePause(state);
}

function onStdoutError(state: JSONLStreamState, err: Error): void {
  getLogger().warn(`[jsonl-stream] stdout error: ${err.message}`);
  flushAndFinish(state);
}

async function* jsonlGenerator(state: JSONLStreamState): AsyncGenerator<AgentEvent> {
  while (true) {
    while (state.lineQueue.length > 0) {
      const line = state.lineQueue.shift()!;
      try {
        yield JSON.parse(line) as AgentEvent;
      } catch {
        if (state.options?.onParseError) {
          state.options.onParseError(line);
        } else {
          getLogger().warn(`[jsonl-stream] failed to parse JSONL: ${line.slice(0, 100)}`);
        }
      }
      maybeResume(state);
    }
    if (state.done) return;
    await new Promise<void>((r) => {
      state.resolveNext = r;
    });
  }
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
 * - Optional backpressure: when `pauseThreshold` is set, stdout is
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
  const pauseThreshold = options?.pauseThreshold ?? 100;
  const state: JSONLStreamState = {
    lineQueue: [],
    partialFragments: [],
    decoder: new StringDecoder('utf8'),
    completeLines: [],
    done: false,
    resolveNext: null,
    partialBytes: 0,
    pauseThreshold,
    // 默认低水位为高水位一半，避免逐行 pause/resume 抖动（调用方未显式设置时）。
    resumeThreshold: options?.resumeThreshold ?? Math.max(0, Math.floor(pauseThreshold / 2)),
    paused: false,
    // 单条 never-newline 流的 fragment 上限（10MB），防内存无界增长。
    partialByteLimit: 10 * 1024 * 1024,
    stdout,
    options,
  };
  // 误配（resumeThreshold > pauseThreshold）会在高水位立刻 re-pause，钳到高水位。
  if (state.resumeThreshold > state.pauseThreshold) state.resumeThreshold = state.pauseThreshold;

  stdout.on('data', (chunk: Buffer) => onDataChunk(state, chunk));
  stdout.on('end', () => flushAndFinish(state));
  stdout.on('close', () => flushAndFinish(state));
  // stdout error 只保证 generator 结束并记日志，不向 generator 重抛（runner
  // 的 try/catch 与 proc close 路径已统一上报失败）；否则 consumer 会永久挂住。
  stdout.on('error', (err: Error) => onStdoutError(state, err));

  return jsonlGenerator(state);
}
