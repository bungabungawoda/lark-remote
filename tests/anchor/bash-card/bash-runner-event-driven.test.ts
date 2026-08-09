/**
 * Anchor Tests: BashProcessRunner.run() event-driven streaming loop
 *
 * Spec basis (③): BashRunner 事件驱动重构 —
 * "`BashRunner` 用事件驱动替代 busy-wait 轮询". The run loop must race the
 * next stdout/stderr `data` event against process `exit`/`error` so it wakes
 * instantly on either, instead of polling every 100ms via setTimeout. These
 * anchors inject a fake ChildProcess (vi.mock('node:child_process')) so output
 * chunks and exit can be emitted with deterministic timing -- the
 * "可注入 fake stdout chunk 做精确测试" benefit called out in the candidate's
 * Test Improvement note. No real `bash` is spawned and no wall-clock timing is
 * asserted (vitest's ~80ms child_process overhead makes latency assertions
 * non-discriminating against the old 100ms poll floor).
 *
 * What goes wrong if missing/incorrect (②):
 *   - If run() stops listening to `exit`/`error` (regression to a poll-only
 *     loop that checks proc.exitCode), a no-output command never breaks the
 *     loop and the generator hangs -> `exit` anchor times out.
 *   - If run() stops draining the queue before awaiting (batch-at-exit),
 *     stdout is not streamed incrementally -> ordering anchor fails.
 *   - If the `error` handler is dropped, a spawn failure (bash missing) hangs
 *     forever instead of yielding an exit event -> spawn-error anchor times out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';

interface BashOutputEvent {
  type: 'stdout' | 'stderr' | 'exit';
  content: string;
  exitCode?: number;
}

// 使用 vi.hoisted 避免 TDZ 错误
const { mockSpawn, mockLogger } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { BashProcessRunner } from '../../../src/runner/bash/index.js';

/**
 * Fake ChildProcess: stdout/stderr use PassThrough (real Readable streams with
 * pause/resume) so the runner's backpressure logic works without typeof guards.
 * The proc itself is an EventEmitter for `exit`/`error` events. The `exitCode`/
 * `signalCode` fields are set by emitExit to mirror Node's real ChildProcess.
 */
function createFakeProc(pid = 12345): ChildProcess {
  const proc = new EventEmitter() as unknown as {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  };
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => true;
  return proc as unknown as ChildProcess;
}

function emitStdout(proc: ChildProcess, data: string): void {
  (proc as unknown as { stdout: PassThrough }).stdout.write(Buffer.from(data));
}
function emitStderr(proc: ChildProcess, data: string): void {
  (proc as unknown as { stderr: PassThrough }).stderr.write(Buffer.from(data));
}
function emitExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  const p = proc as unknown as {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  p.exitCode = code;
  p.signalCode = signal;
  proc.emit('exit', code, signal);
}

/** Run a function on the next macrotask so the generator has suspended at its
 *  first `await Promise.race(...)` before events fire. Multiple nextTick
 *  callbacks execute in registration order, and all promise continuations
 *  (microtasks) drain fully between macrotasks, so emitted events are observed
 *  by the generator one batch at a time. */
function nextTick(fn: () => void): void {
  setTimeout(fn, 0);
}

async function drain(gen: AsyncGenerator<BashOutputEvent>): Promise<BashOutputEvent[]> {
  const events: BashOutputEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('BashProcessRunner.run() event-driven streaming (Candidate 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects exit via the exit event when no stdout is produced (no busy-wait)', async () => {
    // Regression discriminator for the busy-wait removal: the run loop must
    // break on the `exit` event handler resolving the completion promise, not
    // on a periodic poll of proc.exitCode. A no-output command that exits
    // immediately must yield exactly one `exit` event. If the loop regresses to
    // a setTimeout poll that does not race `exit`, the generator never wakes and
    // this test times out (the assertion never runs).
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const gen = new BashProcessRunner().run('true', { cwd: '/tmp' });
    nextTick(() => emitExit(proc, 0, null));

    const events = await drain(gen);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('exit');
    expect(events[0].exitCode).toBe(0);
  });

  it('streams stdout before the exit event (drains queue before awaiting)', async () => {
    // Pins the drain-before-wait structure: a stdout chunk must be yielded
    // incrementally, not held until exit and batched. Emitting stdout then
    // exit on separate macrotasks must yield [stdout, exit] in arrival order.
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const gen = new BashProcessRunner().run('echo hi', { cwd: '/tmp' });
    nextTick(() => emitStdout(proc, 'hello'));
    nextTick(() => emitExit(proc, 0, null));

    const events = await drain(gen);
    expect(events.map((e) => e.type)).toEqual(['stdout', 'exit']);
    expect(events[0]).toMatchObject({ type: 'stdout', content: 'hello' });
    expect(events[1]).toMatchObject({ type: 'exit', exitCode: 0 });
  });

  it('preserves order of multiple stdout chunks then exit', async () => {
    // Multiple chunks emitted in one macrotask are all queued (notifyData wakes
    // the loop once; subsequent chunks land in the queue without an extra
    // waiter) and drained in arrival order before the exit event.
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const gen = new BashProcessRunner().run('printf a\\nb', { cwd: '/tmp' });
    nextTick(() => {
      emitStdout(proc, 'a');
      emitStdout(proc, 'b');
    });
    nextTick(() => emitExit(proc, 0, null));

    const events = await drain(gen);
    expect(events.map((e) => e.type)).toEqual(['stdout', 'stdout', 'exit']);
    expect(events[0].content).toBe('a');
    expect(events[1].content).toBe('b');
    expect(events[2].exitCode).toBe(0);
  });

  it('delivers stderr as a stderr event before exit', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const gen = new BashProcessRunner().run('echo err >&2', { cwd: '/tmp' });
    nextTick(() => emitStderr(proc, 'boom'));
    nextTick(() => emitExit(proc, 0, null));

    const events = await drain(gen);
    expect(events.map((e) => e.type)).toEqual(['stderr', 'exit']);
    expect(events[0]).toMatchObject({ type: 'stderr', content: 'boom' });
  });

  it('reports a signal kill as exitCode -1 (not 0/false success)', async () => {
    // /stop SIGKILL: exitCode stays null, signal is set. Reporting `code ?? 0`
    // would falsely claim success; the loop must use `-1` for signal kills.
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const gen = new BashProcessRunner().run('sleep 30', { cwd: '/tmp' });
    nextTick(() => emitExit(proc, null, 'SIGKILL'));

    const events = await drain(gen);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('exit');
    expect(events[0].exitCode).toBe(-1);
  });

  it('yields an exit event on spawn error instead of hanging', async () => {
    // Discriminator vs the old busy-wait loop: a spawn `error` (e.g. bash
    // missing) emits `error` and never `exit`, so proc.exitCode/signalCode stay
    // null forever. The old loop's break condition (`exitCode !== null ||
    // signalCode !== null`) was never true and it polled forever (a latent hang
    // masked only because `bash` is always present in practice). The event-
    // driven rewrite resolves completion on `error` too, yielding exit(code=1).
    // If the `error` handler is dropped, this test times out instead of passing.
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const gen = new BashProcessRunner().run('true', { cwd: '/tmp' });
    nextTick(() => proc.emit('error', new Error('ENOENT: spawn bash')));

    const events = await drain(gen);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('exit');
    expect(events[0].exitCode).toBe(1);
  }, 3000);
});
