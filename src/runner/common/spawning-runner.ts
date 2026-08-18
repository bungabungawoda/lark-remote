import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { silentlyUnlink } from '../../common/fs.js';
import { getLogger } from '../../logger/index.js';
import { ProcessStopper } from './process-stopper.js';
import { SpawnHeartbeat } from './spawn-heartbeat.js';
import { createJSONLStream } from './jsonl-stream.js';
import { authErrorEvent, syntheticInitEvent } from './runner-utils.js';
import { DEFAULT_STOP_GRACE_MS } from '../../config/index.js';
import type { AgentEvent, SpawnOptions } from '../types.js';

/**
 * Magic-number constants (Clean Code P3-1, G25 Replace Magic Numbers with
 * Named Constants). Centralized here so the truncation budgets are visible
 * and adjustable in one place rather than scattered as raw literals.
 */
/** Max bytes of stderr retained for the result-event error message. */
const STDERR_TAIL_BYTES = 4000;
/** Max bytes of stderr surfaced in the non-zero-exit log line. */
const STDERR_LOG_TAIL = 500;
/** Error thrown by `spawnChild` when the child process fails to spawn. */
class SpawnChildError extends Error {}
/**
 * Timeout (ms) for awaiting the spawn 'error' event when proc.pid === undefined
 * (review P2-11). Node guarantees 'error' for ENOENT/EACCES, but some binaries
 * fail silently; the race keeps a silent failure from hanging run() forever.
 * Matches the 5s race kimi's override used before it was hoisted to the base.
 */
const SPAWN_ERROR_TIMEOUT_MS = 5000;

/**
 * 进程级退出监听单例分发（P1-1 修复，2026-08-02）。
 *
 * 背景：5 个 runner（claude/codex/opencode/pi/kimi）的 registerExitHandlers 曾是
 * 同构复制，每个实例 process.on('exit'|'SIGINT'|'SIGTERM') 注册 3 个永不移除的
 * 闭包（捕获整个 runner 实例 + sessionReader + pidFilePath）。Bridge 每次 run
 * 结束淘汰 (cwd, kind) 槽位、下次 run cache miss 新建实例再注册 → 约第 4 个 run
 * 起 MaxListenersExceededWarning 刷屏，历史实例被闭包永久持有，内存无界增长。
 *
 * 现在：进程级监听只注册一次，内部 Set<SpawningRunner> 管理注册实例；
 * registerExitHandlers() 只把实例加入集合（幂等），桥接层在淘汰槽位时调
 * unregisterExitHandlers() 移除实例，让 runner 可被 GC。SIGINT/SIGTERM 语义
 * 保持原样：cleanup 全部已注册实例后 exit 130/143。
 */
/**
 * Exit-cleanup contract: anything that spawns a child process group and wants
 * process-level cleanup (agent runners via SpawningRunner, and BashProcessRunner
 * for `!` commands, P1-22) registers with the singleton dispatcher.
 */
interface ExitCleanupHandler {
  cleanupOnExit(): void;
}

const registeredRunners = new Set<ExitCleanupHandler>();
let exitListenersInstalled = false;

function cleanupRegisteredRunners(): void {
  for (const runner of registeredRunners) {
    runner.cleanupOnExit();
  }
}

function installExitListenersOnce(): void {
  if (exitListenersInstalled) return;
  exitListenersInstalled = true;
  process.on('exit', cleanupRegisteredRunners);
  process.on('SIGINT', () => {
    cleanupRegisteredRunners();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanupRegisteredRunners();
    process.exit(143);
  });
}

/** Register a process-exit cleanup handler (installs listeners at most once). */
export function registerExitCleanup(handler: ExitCleanupHandler): void {
  installExitListenersOnce();
  registeredRunners.add(handler);
}

/** Remove a handler so it can be GC'd (agent slots / finished bash runs). */
export function unregisterExitCleanup(handler: ExitCleanupHandler): void {
  registeredRunners.delete(handler);
}

/**
 * Stateful translator contract for runners that need per-run translation state
 * (codex/opencode/pi/kimi). Subclasses return an instance from
 * `createTranslator(opts)`; the base `run()` loop calls `translate(raw)` per
 * event, then folds terminal state into `buildResultEvent(...)` at the end.
 *
 * `translate()` returns `AgentEvent | AgentEvent[] | null` (single event,
 * multiple events, or filtered-out). `isTerminal()` / `finish()` / `getTerminalError()`
 * / `hasAgentTerminalError()` are folded into the unified result event at the
 * end of `run()`.
 *
 * `getSessionId()` / `getLastUsage()` are optional because ClaudeRunner uses
 * the stateless `translate()` hook (no translator object) and reads neither.
 */
export interface RunnerTranslator {
  translate(raw: unknown): AgentEvent | AgentEvent[] | null;
  isTerminal(): boolean;
  finish(reason: 'failed' | 'interrupted' | 'timeout'): void;
  getTerminalError(): string | undefined;
  hasAgentTerminalError(): boolean;
  getSessionId?(): string | undefined;
  getLastUsage?(): Record<string, unknown> | undefined;
}

/**
 * Abstract base class for runners that spawn a child process per turn.
 *
 * Encapsulates the spawn + completion + cleanup orchestration shared by
 * Claude/Pi runners. Subclasses override:
 *   - buildArgv(opts)              → agent-specific CLI flags (required)
 *   - createTranslator(opts)       → stateful translator (pi)
 *     OR translate(raw, ctx)       → stateless passthrough (claude)
 *
 * Optional hooks (with sensible defaults):
 *   - getStdio()                   → stdio config (default ['ignore','pipe','pipe'])
 *   - createStreamReader(stdout)   → JSONL or readline parser (default createJSONLStream)
 *   - awaitSpawnError(proc)        → wait for spawn error (default once('error'))
 *
 * The base class always emits a unified result event at the end of `run()`
 * via `buildResultEvent(...)` — never throws on non-zero exit. This matches
 * the contract pinned by the agent subclass anchors and the bridge's
 * `runAgentStreamToEnd` error handling (which accepts both thrown errors and
 * yielded error-result events).
 */
export abstract class SpawningRunner {
  protected currentProcess: ChildProcess | null = null;
  protected readonly pidFilePath: string;
  protected readonly stopper: ProcessStopper;
  protected readonly spawnHeartbeat: SpawnHeartbeat;
  protected binary: string;
  protected stopGraceMs: number;
  /** Accumulated stderr tail for the current run (filled by spawnChild). */
  protected spawnStderr = '';
  /**
   * Log prefix used in all operational log lines emitted by this runner
   * (spawn, pid file, non-zero exit, stderr, killOrphan, stop cleanup) and
   * as the SpawnHeartbeat label. Subclasses pass their own tag (e.g.
   * 'claude-runner') so operators can grep agent-specific logs; the default
   * 'spawning-runner' keeps the base-class anchor tests' neutral identity.
   */
  protected readonly logTag: string;
  /**
   * The `message` argument from the most recent `run(message, opts)` call.
   * Set in `run()` before `buildArgv(opts)` is invoked so subclasses can
   * embed the message in their agent-specific argv (e.g. claude's `-p
   * <message>`). This avoids changing the `buildArgv(opts)` signature,
   * which would break existing anchor subclasses.
   */
  protected currentMessage: string = '';
  /**
   * Whether the current run was interrupted by user-initiated stop().
   * Set to true by stop() when a running process is being terminated;
   * reset to false at the top of run(). `resolveTranslatorError()` and
   * `buildResultEvent()` read this to decide result event subtype
   * (error vs success) and the error message precedence.
   */
  protected stoppedByUser: boolean = false;

  constructor(opts: {
    pidDir?: string;
    workspace: string;
    stopGraceMs?: number;
    spawnHeartbeatMs?: number;
    /**
     * Filename prefix for the pid file. Defaults to 'spawning'. Each
     * subclass should pass its own prefix (e.g. 'claude', 'codex') so
     * multiple runners sharing the same pidDir do not clobber each
     * other's pid files.
     */
    pidFilePrefix?: string;
    /**
     * Log prefix for operational log lines and the SpawnHeartbeat label.
     * Defaults to 'spawning-runner'. Subclasses pass their own tag (e.g.
     * 'claude-runner') so operators can grep agent-specific logs and the
     * spawn-stage-stalled WARN identifies the right agent.
     */
    logTag?: string;
  }) {
    // Subclasses set this.binary after super()
    this.binary = '';
    this.stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.logTag = opts.logTag ?? 'spawning-runner';
    const pidDir = opts.pidDir ?? path.join(os.homedir(), '.lark-remote');
    const workspaceSuffix = `-${opts.workspace.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const pidFilePrefix = opts.pidFilePrefix ?? 'spawning';
    this.pidFilePath = path.join(pidDir, `${pidFilePrefix}${workspaceSuffix}.pid`);
    this.stopper = new ProcessStopper({ graceMs: this.stopGraceMs });
    this.spawnHeartbeat = new SpawnHeartbeat(opts.spawnHeartbeatMs ?? 30_000, this.logTag);
  }

  get isRunning(): boolean {
    return (
      this.currentProcess !== null &&
      this.currentProcess.exitCode === null &&
      this.currentProcess.signalCode === null
    );
  }

  // --- Hooks (subclasses override as needed) ---

  /**
   * stdio config for spawn. Default: stdin ignored (claude/kimi/pi pass the
   * prompt via argv).
   */
  protected getStdio(): ('ignore' | 'pipe')[] {
    return ['ignore', 'pipe', 'pipe'];
  }

  /**
   * Create an async iterator over the child's stdout. Default: createJSONLStream
   * (claude/kimi/pi) with P1-4 backpressure enabled (pauseThreshold=100).
   */
  protected createStreamReader(stdout: Readable): AsyncGenerator<unknown> {
    return createJSONLStream(stdout, {
      onParseError: (line) => {
        getLogger().warn(`[jsonl-stream] failed to parse JSONL: ${line.slice(0, 100)}`);
      },
      pauseThreshold: 100,
      resumeThreshold: 50,
    }) as AsyncGenerator<unknown>;
  }

  /**
   * Create a stateful translator for this run. Default: null (uses the
   * stateless passthrough). pi overrides to return its translator instance.
   */
  protected createTranslator(_opts: SpawnOptions): RunnerTranslator | null {
    return null;
  }

  /**
   * Await the spawn 'error' event when proc.pid === undefined. Races a
   * finite timeout (review P2-11) against the 'error' event: Node guarantees
   * 'error' for ENOENT/EACCES, but some binaries fail silently without ever
   * emitting it (kimi's CLI is documented to do so). Without the race, run()
   * hangs forever → the workspace serial queue never settles → permanent
   * deadlock, and /stop can't recover (ProcessStopper returns early when
   * pid === undefined). The timeout keeps the deadlock bounded.
   */
  protected awaitSpawnError(proc: ChildProcess): Promise<Error | undefined> {
    return Promise.race([
      new Promise<Error>((resolve) => {
        proc.once('error', (err: Error) => resolve(err));
      }),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), SPAWN_ERROR_TIMEOUT_MS),
      ),
    ]);
  }

  /**
   * Spawn the agent binary with the subclass's argv and run the shared spawn
   * lead-in: pid-undefined check, pid-file write, heartbeat start, and stderr
   * accumulation (tail-capped).
   *
   * Throws a `SpawnChildError` (carrying the user-facing spawn failure
   * message) when the process fails to spawn (binary missing / pid undefined).
   * On success returns the spawned child plus the accumulated stderr tail.
   *
   * Shared by the base `run()` (yields an authErrorEvent on failure) and
   * ClaudeSession's `doStartProcess` (returns the error message), which would
   * otherwise duplicate ~60 lines of spawn lead-in with two copies of the
   * STDERR_TAIL_BYTES cap.
   */
  protected async spawnChild(opts: SpawnOptions): Promise<ChildProcess> {
    const proc = spawn(this.binary, this.buildArgv(opts), {
      cwd: opts.cwd,
      stdio: this.getStdio(),
      env: process.env,
      // Spawn in a new process group so we can kill the entire group
      // when stopping. This ensures child processes (shell wrappers,
      // sub-processes) are also terminated.
      detached: true,
    });
    this.currentProcess = proc;

    getLogger().info(
      `[${this.logTag}] spawn pid=${proc.pid ?? '(none)'} binary=${this.binary} ` +
        `cwd=${opts.cwd} sessionId=${opts.sessionId ?? '(none)'}`,
    );

    if (proc.pid === undefined) {
      const spawnErr = await this.awaitSpawnError(proc);
      if (spawnErr) {
        getLogger().error(
          `[${this.logTag}] spawn failed: ${spawnErr.message} binary=${this.binary} cwd=${opts.cwd}`,
        );
      } else {
        getLogger().error(`[${this.logTag}] spawn failed: timeout waiting for error event`);
      }
      this.currentProcess = null;
      this.spawnHeartbeat.clear();
      // P2-13: surface the real spawn error cause instead of a fixed "binary
      // not found" message. ENOENT (binary missing) keeps the friendly hint,
      // but EMFILE/EACCES/ENOMEM/bad-cwd failures must name the actual reason
      // so the user is not misdiagnosed into reinstalling the binary.
      const baseMsg = `${this.binary} 命令不可用（未找到或不可执行），请检查是否已安装或在 PATH 中`;
      const msg = spawnErr ? `${baseMsg}：${spawnErr.message}` : baseMsg;
      throw new SpawnChildError(msg);
    }

    const pidDir = path.dirname(this.pidFilePath);
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(this.pidFilePath, String(proc.pid), 'utf-8');
    getLogger().info(`[${this.logTag}] wrote pid file ${this.pidFilePath}=${proc.pid}`);
    this.spawnHeartbeat.start({ pid: proc.pid, binary: this.binary, cwd: opts.cwd });

    proc.stdout?.once('data', () => {
      this.spawnHeartbeat.notifyStdout();
    });

    this.spawnStderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) {
        this.spawnStderr = (this.spawnStderr + '\n' + text).trim().slice(-STDERR_TAIL_BYTES);
        // P2-16: most agent CLIs emit progress/warnings/deprecation notices on
        // stderr, not real errors. Logging each chunk at error level drowns out
        // genuine errors. Downgrade to warn — the accumulated stderr is already
        // surfaced at error level in the non-zero-exit result path.
        getLogger().warn(`[${this.logTag} stderr] ${text}`);
      }
    });

    return proc;
  }

  /**
   * Spawn the agent binary with argv built by buildArgv(opts), iterate its
   * stdout stream, and yield translated events. Always emits a unified
   * result event at the end via `buildResultEvent(...)` — never throws on
   * non-zero exit (the bridge accepts both thrown errors and yielded
   * error-result events, and the latter carries richer diagnostic info).
   *
   * Spawn failures (binary missing, pid undefined) yield an `authErrorEvent`
   * instead of throwing, so the user sees a friendly error card.
   */
  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (this.isRunning) {
      getLogger().warn(`[${this.logTag}] run() called while already running, refusing`);
      throw new Error(`${this.binary} process already running`);
    }
    this.stoppedByUser = false;
    this.currentMessage = message;

    let proc: ChildProcess;
    try {
      proc = await this.spawnChild(opts);
    } catch (err) {
      // §9.22: yield synthetic init before the error result so bridge/run-state
      // guards don't silently drop it.
      yield syntheticInitEvent(opts.sessionId);
      yield authErrorEvent((err as Error).message);
      return;
    }

    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        proc.once('error', (err) => {
          this.spawnHeartbeat.clear();
          getLogger().error(
            `[${this.logTag}] spawn failed: ${err.message} binary=${this.binary} cwd=${opts.cwd}`,
          );
          // Resolve (not reject) so the unified result event is emitted
          // via buildResultEvent instead of throwing past the finally
          // into the bridge's catch (which would leak the pid file).
          // P2-12: a post-spawn 'error' (e.g. kill failure, broken pipe)
          // MUST surface as an error result, not success. Previously
          // {code:null,signal:null} was classified as success by
          // buildResultEvent; code=1 forces the error branch so the
          // failure is never silently swallowed as a successful run.
          resolve({ code: 1, signal: null });
        });
        proc.once('close', (code, signal) => {
          this.spawnHeartbeat.clear();
          resolve({ code, signal });
        });
      },
    );

    // Create translator (per-run state) — null for stateless passthrough
    const translator = this.createTranslator(opts);

    // Create stream reader (jsonl or readline)
    const stream = this.createStreamReader(proc.stdout!);

    try {
      // Stream loop wrapped in try/catch so a stream error (e.g. stdout
      // 'error' event propagated through the async generator) does not
      // bypass the completion await and result event emission. Matches
      // kimi's long-standing behavior; safe for all runners because the
      // completion promise still resolves via proc 'close'.
      try {
        for await (const rawEvent of stream) {
          let translated: AgentEvent | AgentEvent[] | null;
          if (translator) {
            // Per-event error isolation: a translator throw must not kill
            // the stream (pi's accumulator could throw on malformed input).
            try {
              translated = translator.translate(rawEvent);
            } catch (err) {
              getLogger().warn(
                `[${this.logTag}] translator error: ${(err as Error).message}, raw: ${JSON.stringify(rawEvent).slice(0, 100)}`,
              );
              continue;
            }
          } else {
            translated = this.translate(rawEvent, { message, opts });
          }
          if (translated === null) continue;
          if (Array.isArray(translated)) {
            for (const e of translated) yield e;
          } else {
            yield translated;
          }
        }
      } catch (error) {
        getLogger().error(`[${this.logTag}] stream error: ${error}`);
      }

      const { code, signal } = await completion;

      // If the stream ended before a terminal event, let the translator
      // record its terminal state (e.g. codex `finish('failed')` stashes
      // "stream ended before a terminal event"). The runner folds this
      // into buildResultEvent below.
      if (translator && !translator.isTerminal()) {
        const reason = this.stoppedByUser ? 'interrupted' : 'failed';
        translator.finish(reason);
      }

      // Resolve translatorError precedence (most-specific first):
      //   - agent-reported terminal error always wins
      //   - stream-ended-early symptom only surfaces with no external cause
      let translatorError: string | undefined;
      if (translator) {
        const agentError = translator.hasAgentTerminalError();
        const hasExternalCause =
          this.stoppedByUser || signal !== null || (code !== null && code !== 0);
        translatorError =
          agentError || !hasExternalCause ? translator.getTerminalError() : undefined;
      }

      const nonUserError =
        !this.stoppedByUser && ((code !== null && code !== 0) || signal !== null);

      yield this.buildResultEvent({
        code,
        signal,
        stderr: this.spawnStderr,
        sessionId: translator?.getSessionId?.() ?? '',
        usage: translator?.getLastUsage?.(),
        translatorError,
      });

      if (nonUserError) {
        getLogger().error(
          `[${this.logTag}] non-zero exit code=${code} signal=${signal} stderr=${this.spawnStderr.slice(-STDERR_LOG_TAIL)}`,
        );
      }
    } finally {
      this.spawnHeartbeat.clear();
      // P1-11: 消费者提前关闭生成器（for-await 循环体抛错/break 触发的 .return()）
      // 会跳过 completion await 直接进 finally——此时子进程可能仍在运行。若不杀，
      // 它会成为 stop()（currentProcess 已置 null）、killOrphan()（pid 文件已删）、
      // exit handler（同一字段）都够不到的孤儿黑洞，且 stdout 管道背压会把它永久
      // 阻塞。正常完成路径进程已退出，stop 是 no-op，零成本。
      const proc = this.currentProcess;
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        try {
          await this.stopper.stop(proc, { immediate: true });
        } catch {
          /* ignore */
        }
      }
      this.currentProcess = null;
      silentlyUnlink(this.pidFilePath);
    }
  }

  /**
   * Stop the current process if one is running. Delegates the actual
   * SIGTERM → grace → SIGKILL sequence to `this.stopper.stop(proc, opts)`
   * (see `src/runner/common/process-stopper.ts`), forwarding the `immediate`
   * flag verbatim so all 5 subclasses inherit identical stop semantics.
   */
  async stop(opts?: { immediate?: boolean }): Promise<void> {
    const proc = this.currentProcess;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      this.spawnHeartbeat.clear();
      this.currentProcess = null;
      return;
    }
    this.stoppedByUser = true;
    await this.stopper.stop(proc, { immediate: opts?.immediate });

    this.currentProcess = null;
    silentlyUnlink(this.pidFilePath);
    getLogger().debug(`[${this.logTag}] cleaned pid file ${this.pidFilePath}`);
  }

  killOrphan(): void {
    if (!fs.existsSync(this.pidFilePath)) return;
    try {
      const pidStr = fs.readFileSync(this.pidFilePath, 'utf-8').trim();
      const pid = Number(pidStr);
      if (isNaN(pid) || pid <= 0) {
        silentlyUnlink(this.pidFilePath);
        return;
      }

      // P1-10: pid 复用防护。pid 文件里的 pid 可能是 bridge 崩溃后系统回收复用
      // 给了无关进程——kill(pid, 0) 存活探测无法区分，必须先验证进程身份。
      const match = this.matchPidToBinary(pid);
      if (match !== 'match') {
        // 'gone'：ps 查不到/报错 → 进程已消失，陈旧追踪物自愈清除（不杀）。
        // 'mismatch'：身份不匹配 → pid 已被无关进程占用，绝不能杀；文件是
        // 陈旧垃圾，一并清除。
        // 统一原则：只有身份匹配才杀；验证失败一律不杀。
        getLogger().warn(
          `[${this.logTag}] killOrphan: pid ${pid} not confirmed as ${this.binary} ` +
            `(${match}), skipping kill`,
        );
        silentlyUnlink(this.pidFilePath);
        return;
      }

      // 身份匹配：杀整个进程组（detached:true 下 agent 是组长），与
      // ProcessStopper 的 kill(-pid) 语义对齐，子进程不会孤儿化（P1-12）。
      getLogger().info(`[${this.logTag}] killing orphan process group ${-pid}`);
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // process may have exited
      }
      silentlyUnlink(this.pidFilePath);
    } catch {
      // ignore
    }
  }

  /**
   * P1-10: verify the process behind a stale pid file is actually ours before
   * sending any signal. `ps -o command=` (not `comm=`) is used because agent
   * binaries may be bash-wrapped scripts whose comm is the interpreter name
   * (`/bin/bash`); the full command line contains the binary path/basename.
   *
   * Returns:
   *   'match'    — ps succeeded and the command line contains this.binary
   *                (absolute path) or its basename (PATH lookup).
   *   'mismatch' — ps succeeded but the command line is clearly a different
   *                process (pid was recycled to an unrelated process).
   *   'unknown'  — ps failed / process gone / output unreadable: cannot tell.
   */
  private matchPidToBinary(pid: number): 'match' | 'mismatch' | 'gone' {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf-8',
      }).trim();
      if (!out || out.includes('<defunct>')) return 'gone';
      const binary = this.binary;
      if (!binary) return 'gone';
      const needle = binary.includes('/') ? binary : path.basename(binary);
      return out.includes(needle) ? 'match' : 'mismatch';
    } catch {
      // ps 失败（进程不存在/权限）→ 视作 gone：不杀，让陈旧文件自愈
      return 'gone';
    }
  }

  /**
   * Register this runner with the process-level exit dispatcher (singleton).
   * Process listeners are installed at most once; subsequent calls only add
   * the instance to the internal Set (idempotent — no listener accumulation).
   * Bridge evicts the (cwd, kind) slot after each run; call
   * `unregisterExitHandlers()` there so the instance can be GC'd.
   */
  registerExitHandlers(): void {
    registerExitCleanup(this);
  }

  /**
   * Remove this runner from the process-level exit dispatcher. Called when
   * the bridge evicts the runner cache slot (finalizeRun / interruptCurrentRun
   * / clearRunners) so the instance is no longer retained by the dispatcher.
   */
  unregisterExitHandlers(): void {
    unregisterExitCleanup(this);
  }

  /**
   * Current number of runners registered with the process-level exit
   * dispatcher. Diagnostics / test-support introspection (P1-1 anchor asserts
   * the count returns to baseline after bridge eviction).
   */
  static getRegisteredExitHandlerCount(): number {
    return registeredRunners.size;
  }

  /**
   * Shared process-exit cleanup: SIGTERM the still-running child process and
   * remove the pid file. Called by the singleton dispatcher for every
   * registered runner; previously duplicated verbatim in all 5 runner
   * subclasses.
   */
  cleanupOnExit(): void {
    if (this.currentProcess && this.currentProcess.exitCode === null) {
      try {
        // P1-12: 只杀组长会让组内子进程（工具调用起的后台进程）reparent 成孤儿。
        // 复用 ProcessStopper 的 immediate 组杀（SIGTERM+SIGKILL 同步发出，
        // 进程退出路径 fire-and-forget 足够；正常进程退出时是 no-op）。
        void this.stopper.stop(this.currentProcess, { immediate: true });
      } catch {}
    }
    silentlyUnlink(this.pidFilePath);
  }

  /**
   * Build a unified result event from process exit state. Centralizes the
   * result-event semantics specified in Candidate 2:
   *   - stoppedByUser → error ("interrupted by user")
   *   - translatorError set → error (translator-supplied message, e.g. codex
   *     `turn.failed` or "stream ended before a terminal event")
   *   - code !== 0 && code !== null → error (exit code + stderr tail)
   *   - signal !== null → error (killed by signal)
   *   - otherwise → success (with optional usage)
   *
   * Error message precedence (most-specific first):
   *   - stoppedByUser:  "{binary} interrupted by user"
   *   - translatorError: verbatim translator-supplied message
   *   - signal:         "{binary} killed by signal {signal}{stderr tail}"
   *   - non-zero code:  "{binary} exited code={code}{stderr tail}"
   *
   * @param opts.code            - Process exit code (null if killed by signal)
   * @param opts.signal          - Process signal code (null if exited normally)
   * @param opts.stderr          - Accumulated stderr (tail included in code/signal errors)
   * @param opts.sessionId       - Session ID to include in the result event
   * @param opts.usage           - Token usage to include on success
   * @param opts.translatorError - Agent-specific terminal error message (e.g.
   *                                codex turn.failed, or "stream ended early")
   * @returns AgentEvent with type='result'
   */
  protected buildResultEvent(opts: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr?: string;
    sessionId?: string;
    usage?: Record<string, unknown>;
    translatorError?: string;
  }): AgentEvent {
    const isError =
      this.stoppedByUser ||
      opts.translatorError !== undefined ||
      (opts.code !== null && opts.code !== 0) ||
      opts.signal !== null;

    const sessionId = opts.sessionId ?? '';

    if (isError) {
      let errorMessage: string;
      const stderrTail = opts.stderr ? opts.stderr.slice(-STDERR_LOG_TAIL) : '';

      if (this.stoppedByUser) {
        errorMessage = `${this.binary} interrupted by user`;
      } else if (opts.translatorError !== undefined) {
        errorMessage = opts.translatorError;
      } else if (opts.signal !== null) {
        errorMessage = `${this.binary} killed by signal ${opts.signal}${stderrTail ? `: ${stderrTail}` : ''}`;
      } else {
        errorMessage = `${this.binary} exited code=${opts.code}${stderrTail ? `: ${stderrTail}` : ''}`;
      }

      return {
        type: 'result',
        subtype: 'error',
        session_id: sessionId,
        errorMessage,
      } as AgentEvent;
    }

    return {
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      ...(opts.usage ? { usage: opts.usage } : {}),
    } as AgentEvent;
  }

  protected abstract buildArgv(opts: SpawnOptions): string[];

  /**
   * Stateless passthrough translator hook. Used by ClaudeRunner
   * which does not need per-run translation state. Subclasses that return
   * a translator from `createTranslator(opts)` leave this as the default
   * no-op — the base `run()` loop only calls `translate()` when
   * `createTranslator()` returns null.
   */
  protected translate(_rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
    return null;
  }
}
