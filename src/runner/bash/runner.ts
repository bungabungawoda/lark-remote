import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { getLogger } from '../../logger/index.js';
import {
  createShellBackend,
  ShellUnavailableError,
  type ShellBackend,
} from '../../platform/shell.js';
import { createTerminator, type Terminator } from '../../platform/terminator.js';
import { useDetachedProcessGroup } from '../../platform/spawn.js';
import {
  isChildProcessRunning,
  registerExitCleanup,
  unregisterExitCleanup,
} from '../common/spawning-runner.js';

interface BashOutputEvent {
  type: 'stdout' | 'stderr' | 'exit';
  content: string;
  exitCode?: number;
}

export interface BashRunner {
  run(command: string, opts: { cwd: string }): AsyncGenerator<BashOutputEvent>;
  stop(opts?: { immediate?: boolean }): Promise<void>;
  get isRunning(): boolean;
}

interface StreamPump {
  readonly kind: 'stdout' | 'stderr';
  readonly queue: string[];
  drainOne(): string | undefined;
  maybeResume(): void;
  flushDecoder(): void;
}

/** One decoder + queue + pause/resume state per child stream. */
function createStreamPump(
  stream: Readable,
  kind: 'stdout' | 'stderr',
  highWater: number,
  lowWater: number,
  notifyData: () => void,
): StreamPump {
  const decoder = new StringDecoder('utf8');
  const queue: string[] = [];
  let paused = false;

  stream.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk);
    getLogger().debug(`[bash-runner] ${kind}: ${text.slice(0, 100)}`);
    if (!text) return;
    queue.push(text);
    if (!paused && queue.length > highWater) {
      paused = true;
      stream.pause();
    }
    notifyData();
  });

  return {
    kind,
    queue,
    drainOne(): string | undefined {
      return queue.shift();
    },
    maybeResume(): void {
      if (paused && queue.length <= lowWater) {
        paused = false;
        stream.resume();
      }
    },
    flushDecoder(): void {
      const tail = decoder.end();
      if (tail) queue.push(tail);
    },
  };
}

/**
 * Lightweight bash executor for `!` commands.
 * Spawns `bash -c "<command>"` and yields stdout/stderr/exit as events.
 *
 * Output streaming is event-driven: the run loop races the next stdout/stderr
 * `data` event against process `exit`/`error`, so it wakes instantly on either
 * (no `setTimeout` busy-wait polling). This drops exit latency from ~100ms
 * (the previous poll granularity) to ~0 and avoids periodic CPU wakeups while
 * a long command produces no output. Each stream has a single `data` handler
 * that logs, enqueues, and wakes the loop.
 */
export class BashProcessRunner implements BashRunner {
  private currentProcess: ChildProcess | null = null;
  /**
   * 背压高水位/低水位（层④，参照 jsonl-stream.ts 的 pauseThreshold/
   * resumeThreshold）。stdout/stderr 队列超过高水位时 pause 流（内存有界），
   * 消费者 drain 到低水位后 resume。构造可注入以便测试用小水位。
   */
  private readonly queueHighWater: number;
  private readonly queueLowWater: number;
  private readonly terminator: Terminator;
  private readonly shell: ShellBackend;

  constructor(opts?: {
    stopGraceMs?: number;
    queueHighWater?: number;
    queueLowWater?: number;
    /** shell 后端注入（测试用）；默认按平台分发 */
    shell?: ShellBackend;
    /** 终止器注入（测试用）；默认按平台分发 */
    terminator?: Terminator;
  }) {
    const stopGraceMs = opts?.stopGraceMs ?? 1000;
    this.queueHighWater = opts?.queueHighWater ?? 32;
    this.queueLowWater = opts?.queueLowWater ?? 16;
    if (this.queueLowWater > this.queueHighWater) {
      this.queueLowWater = this.queueHighWater;
    }
    // `!` bash 无协议停止通道：posix 走组杀（与原 ProcessStopper 同实现），
    // win32 优雅段显式跳过后树杀。
    this.terminator = opts?.terminator ?? createTerminator({ graceMs: stopGraceMs, agent: 'bash' });
    this.shell = opts?.shell ?? createShellBackend();
  }

  get isRunning(): boolean {
    return isChildProcessRunning(this.currentProcess);
  }

  async *run(command: string, opts: { cwd: string }): AsyncGenerator<BashOutputEvent> {
    if (this.isRunning) {
      getLogger().warn('[bash-runner] run() called while already running');
      throw new Error('bash process already running');
    }

    getLogger().debug(`[bash-runner] spawning command="${command}" cwd=${opts.cwd}`);

    let proc: ChildProcess;
    try {
      proc = this.shell.spawn(command, {
        cwd: opts.cwd,
        options: {
          stdio: ['ignore', 'pipe', 'pipe'],
          // posix 建新进程组（负 PID 组杀）；win32 不 detached（`.cmd` 垫片丢 stdio）
          detached: useDetachedProcessGroup(),
          windowsHide: true,
        },
      });
    } catch (err) {
      // win32 Git Bash 缺失：同步抛出，转成明确错误输出而非悬死。
      if (err instanceof ShellUnavailableError) {
        getLogger().warn(`[bash-runner] shell unavailable: ${err.message}`);
        yield { type: 'stderr', content: `${err.message}\n` };
        yield { type: 'exit', content: '', exitCode: 1 };
        return;
      }
      throw err;
    }

    this.currentProcess = proc;
    // stdio 固定为 ['ignore','pipe','pipe']，两条流必为 pipe（backend 返回的
    // 宽化 ChildProcess 类型丢掉了这一点，这里收窄一次）
    const stdout = proc.stdout!;
    const stderr = proc.stderr!;
    getLogger().info(
      `[bash-runner] spawn pid=${proc.pid} command="${command.slice(0, 50)}..." cwd=${opts.cwd}`,
    );
    // register with the process-level exit dispatcher while the process
    // is alive — bridge exit/restart (SIGINT/SIGTERM/exit) then kills the whole
    // group via cleanupOnExit instead of orphaning `!` processes.
    registerExitCleanup(this);

    // Resolved by a `data` event to signal "more output may be available,
    // re-check the queues". Held as a field so either stream's handler can
    // resolve the single in-flight waiter. Cleared on resolve and on loop exit.
    let dataWaiter: (() => void) | null = null;
    const notifyData = (): void => {
      if (dataWaiter) {
        const resolve = dataWaiter;
        dataWaiter = null;
        resolve();
      }
    };
    // 背压：队列超高水位 → pause；drain 到低水位 → resume（两路流共用）。
    const pumps = [
      createStreamPump(stdout, 'stdout', this.queueHighWater, this.queueLowWater, notifyData),
      createStreamPump(stderr, 'stderr', this.queueHighWater, this.queueLowWater, notifyData),
    ];
    function* drainQueues(): Generator<BashOutputEvent> {
      for (const pump of pumps) {
        while (pump.queue.length > 0) {
          yield { type: pump.kind, content: pump.drainOne()! };
          // Resume after the consumer takes the item (matches drain semantics:
          // the low-water check observes the queue left for the next call).
          pump.maybeResume();
        }
      }
    }

    // Use the `exit` event (not `close`): `close` waits for ALL child processes
    // including background daemons (`nohup &`), which can take forever. `exit`
    // fires as soon as bash itself exits. A SIGKILL from /stop sets `signal`
    // while `code` stays null, so callers distinguish signal-kill from exit.
    // A spawn failure (e.g. bash missing) emits `error` and never `exit`;
    // resolving completion with code=1 here lets the loop terminate instead of
    // spinning forever on a permanently-null exitCode check (the old poll loop
    // had the same latent hang on a missing bash binary).
    let completionResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const completion = new Promise<void>((resolve) => {
      proc.once('exit', (code, signal) => {
        completionResult = { code, signal };
        resolve();
      });
      proc.once('error', (err: Error) => {
        getLogger().error('[bash-runner] process error:', err.message);
        completionResult = { code: 1, signal: null };
        resolve();
      });
    });

    try {
      while (completionResult === null) {
        // Register the wakeup before draining: data can arrive between the
        // drain and the wait, and a wakeup without a waiter would be lost.
        const nextData = new Promise<void>((resolve) => {
          dataWaiter = resolve;
        });
        // Drain queued chunks before waiting, so output is streamed
        // incrementally rather than batched at exit.
        yield* drainQueues();

        if (completionResult === null && !pumps.some((pump) => pump.queue.length > 0)) {
          // Wait for the next chunk OR process exit/error -- no fixed-interval
          // polling. Racing `completion` guarantees the loop wakes on exit even
          // when the command produces no output (e.g. `true`, `nohup &`).
          await Promise.race([nextData, completion]);
        }
        dataWaiter = null;
      }

      const { code, signal } = completionResult;
      // Drain chunks that arrived between the last drain and exit, then flush
      // decoder tails (split multibyte characters).
      for (const pump of pumps) pump.flushDecoder();
      yield* drainQueues();
      getLogger().info(`[bash-runner] process exited with code=${code} signal=${signal}`);
      // A SIGKILL'd process (e.g. from /stop) has exitCode=null and a signal
      // set. Reporting `code ?? 0` would falsely claim success; use -1 to
      // signal abnormal termination by signal.
      yield { type: 'exit', content: '', exitCode: code ?? (signal ? -1 : 0) };
    } finally {
      dataWaiter = null;
      this.currentProcess = null;
      // Run finished — remove from the exit dispatcher so dead runners are not
      // retained (mirror agent-runner slot eviction; keeps the Set bounded to
      // active bash runs only).
      unregisterExitCleanup(this);
    }
  }

  /**
   * called by the process-level exit dispatcher on SIGINT/SIGTERM/exit.
   * Kills the whole process group (leader + background children) via
   * Terminator, matching agent-runner cleanupOnExit semantics.
   */
  cleanupOnExit(): void {
    const proc = this.currentProcess;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      this.terminator.cleanupOnExit(proc);
    } catch {
      // fire-and-forget: nothing else to do at process exit
    }
  }

  async stop(opts?: { immediate?: boolean }): Promise<void> {
    const proc = this.currentProcess;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      this.currentProcess = null;
      return;
    }

    // Delegate to Terminator for unified stop semantics
    await this.terminator.stop(proc, { immediate: opts?.immediate === true });

    this.currentProcess = null;
  }
}
