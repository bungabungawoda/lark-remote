import { spawn, type ChildProcess } from 'node:child_process';
import { getLogger } from '../../logger/index.js';
import { ProcessStopper } from '../common/process-stopper.js';
import { registerExitCleanup, unregisterExitCleanup } from '../common/spawning-runner.js';

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
   * 背压高水位/低水位（P1-4 层④，参照 jsonl-stream.ts 的 pauseThreshold/
   * resumeThreshold）。stdout/stderr 队列超过高水位时 pause 流（内存有界），
   * 消费者 drain 到低水位后 resume。构造可注入以便测试用小水位。
   */
  private readonly queueHighWater: number;
  private readonly queueLowWater: number;
  private stopper: ProcessStopper;

  constructor(opts?: { stopGraceMs?: number; queueHighWater?: number; queueLowWater?: number }) {
    const stopGraceMs = opts?.stopGraceMs ?? 1000;
    this.queueHighWater = opts?.queueHighWater ?? 32;
    this.queueLowWater = opts?.queueLowWater ?? 16;
    if (this.queueLowWater > this.queueHighWater) {
      this.queueLowWater = this.queueHighWater;
    }
    this.stopper = new ProcessStopper({ graceMs: stopGraceMs });
  }

  get isRunning(): boolean {
    return (
      this.currentProcess !== null &&
      this.currentProcess.exitCode === null &&
      this.currentProcess.signalCode === null
    );
  }

  async *run(command: string, opts: { cwd: string }): AsyncGenerator<BashOutputEvent> {
    if (this.isRunning) {
      getLogger().warn('[bash-runner] run() called while already running');
      throw new Error('bash process already running');
    }

    getLogger().debug(`[bash-runner] spawning command="${command}" cwd=${opts.cwd}`);

    const proc = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Spawn in new process group so we can kill the entire group
      detached: true,
    });

    this.currentProcess = proc;
    getLogger().info(
      `[bash-runner] spawn pid=${proc.pid} command="${command.slice(0, 50)}..." cwd=${opts.cwd}`,
    );
    // P1-22: register with the process-level exit dispatcher while the process
    // is alive — bridge exit/restart (SIGINT/SIGTERM/exit) then kills the whole
    // group via cleanupOnExit instead of orphaning `!` processes.
    registerExitCleanup(this);

    // Single handler per stream: log + enqueue + wake the run loop. The
    // previous implementation registered two `data` listeners per stream (one
    // for logging, one for queueing) -- both fired on the same chunk.
    const stdoutQueue: string[] = [];
    const stderrQueue: string[] = [];
    // 背压状态（P1-4 层④）：队列超高水位 → pause 对应流；drain 到低水位 → resume。
    let stdoutPaused = false;
    let stderrPaused = false;
    const maybePauseStdout = (): void => {
      if (!stdoutPaused && stdoutQueue.length > this.queueHighWater) {
        stdoutPaused = true;
        proc.stdout.pause();
      }
    };
    const maybeResumeStdout = (): void => {
      if (stdoutPaused && stdoutQueue.length <= this.queueLowWater) {
        stdoutPaused = false;
        proc.stdout.resume();
      }
    };
    const maybePauseStderr = (): void => {
      if (!stderrPaused && stderrQueue.length > this.queueHighWater) {
        stderrPaused = true;
        proc.stderr.pause();
      }
    };
    const maybeResumeStderr = (): void => {
      if (stderrPaused && stderrQueue.length <= this.queueLowWater) {
        stderrPaused = false;
        proc.stderr.resume();
      }
    };
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

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      getLogger().debug(`[bash-runner] stdout: ${text.slice(0, 100)}`);
      stdoutQueue.push(text);
      maybePauseStdout();
      notifyData();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      getLogger().debug(`[bash-runner] stderr: ${text.slice(0, 100)}`);
      stderrQueue.push(text);
      maybePauseStderr();
      notifyData();
    });

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
        // Drain queued chunks before waiting, so output is streamed
        // incrementally rather than batched at exit.
        while (stdoutQueue.length > 0) {
          yield { type: 'stdout', content: stdoutQueue.shift()! };
          maybeResumeStdout();
        }
        while (stderrQueue.length > 0) {
          yield { type: 'stderr', content: stderrQueue.shift()! };
          maybeResumeStderr();
        }

        if (completionResult === null) {
          // Wait for the next chunk OR process exit/error -- no fixed-interval
          // polling. Racing `completion` guarantees the loop wakes on exit even
          // when the command produces no output (e.g. `true`, `nohup &`), which
          // the previous setTimeout(100) poll only caught after a full tick.
          const nextData = new Promise<void>((resolve) => {
            dataWaiter = resolve;
          });
          await Promise.race([nextData, completion]);
          dataWaiter = null;
        }
      }

      // Drain any chunks that arrived between the last drain and exit. (Data
      // emitted after the exit yield is not delivered -- matching the prior
      // contract; the bridge accumulates output/stderr from pre-exit events.)
      while (stdoutQueue.length > 0) {
        yield { type: 'stdout', content: stdoutQueue.shift()! };
        maybeResumeStdout();
      }
      while (stderrQueue.length > 0) {
        yield { type: 'stderr', content: stderrQueue.shift()! };
        maybeResumeStderr();
      }

      const { code, signal } = completionResult;
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
   * P1-22: called by the process-level exit dispatcher on SIGINT/SIGTERM/exit.
   * Kills the whole process group (leader + background children) via
   * ProcessStopper, matching agent-runner cleanupOnExit semantics.
   */
  cleanupOnExit(): void {
    const proc = this.currentProcess;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      void this.stopper.stop(proc, { immediate: true });
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

    // Delegate to ProcessStopper for unified stop semantics
    await this.stopper.stop(proc, { immediate: opts?.immediate });

    this.currentProcess = null;
  }
}
