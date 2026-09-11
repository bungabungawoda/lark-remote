import { execFileSync, type ChildProcess } from 'node:child_process';
import {
  spawnProcess,
  isWindowsCommandNotFoundLine,
  useDetachedProcessGroup,
} from '../../platform/spawn.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { silentlyUnlink } from '../../common/fs.js';
import { getLogger } from '../../logger/index.js';
import { ProcessStopper } from './process-stopper.js';
import { SpawnHeartbeat } from './spawn-heartbeat.js';
import { createJSONLStream } from './jsonl-stream.js';
import { DEFAULT_STOP_GRACE_MS } from '../../config/index.js';
import type { SpawnOptions } from '../types.js';

/**
 * Magic-number constants (Clean Code P3-1, G25 Replace Magic Numbers with
 * Named Constants). Centralized here so the truncation budgets are visible
 * and adjustable in one place rather than scattered as raw literals.
 */
/** Max bytes of stderr retained for the result-event error message. */
const STDERR_TAIL_BYTES = 4000;
/** Error thrown by `spawnChild` when the child process fails to spawn. */
class SpawnChildError extends Error {}
/**
 * Timeout (ms) for awaiting the spawn 'error' event when proc.pid === undefined
 * (review P2-11). Node guarantees 'error' for ENOENT/EACCES, but some binaries
 * fail silently; the race keeps a silent failure from hanging the spawn lead-in
 * forever. Matches the 5s race kimi's override used before it was hoisted to
 * the base.
 */
const SPAWN_ERROR_TIMEOUT_MS = 5000;

/**
 * 进程级退出监听单例分发（P1-1 修复，2026-08-02）。
 *
 * 背景：各 agent runner 的 registerExitHandlers 曾是同构复制，每个实例
 * process.on('exit'|'SIGINT'|'SIGTERM') 注册 3 个永不移除的闭包（捕获整个
 * runner 实例 + sessionReader + pidFilePath）。Bridge 每次 run 结束淘汰
 * (cwd, kind) 槽位、下次 run cache miss 新建实例再注册 → 约第 4 个 run 起
 * MaxListenersExceededWarning 刷屏，历史实例被闭包永久持有，内存无界增长。
 *
 * 现在：进程级监听只注册一次，内部 Set 管理注册实例；registerExitHandlers()
 * 只把实例加入集合（幂等），桥接层在淘汰槽位时调 unregisterExitHandlers()
 * 移除实例，让 runner 可被 GC。SIGINT/SIGTERM 语义保持原样：cleanup 全部
 * 已注册实例后 exit 130/143。
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
 * Abstract base class encapsulating the spawn lifecycle shared by agent
 * runners: spawn lead-in (pid-undefined check, pid file write, heartbeat,
 * stderr tail accumulation), user-initiated stop, orphan kill with pid
 * identity verification, and process-exit cleanup registration.
 *
 * The sole production subclass is ClaudeSession (src/runner/claude/session.ts),
 * a long-lived interactive session that overrides `run()` with its own
 * per-turn consumption loop and reads `spawnStderr` / `stoppedByUser` /
 * `commandNotFoundSeen` to build its terminal result events.
 *
 * Subclasses override:
 *   - buildArgv(opts) → agent-specific CLI flags (required)
 *
 * Optional hooks (with sensible defaults):
 *   - getStdio()                 → stdio config (default ['ignore','pipe','pipe'])
 *   - createStreamReader(stdout) → JSONL or readline parser (default createJSONLStream)
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
   * 'claude-runner') so operators can grep agent-specific logs.
   */
  protected readonly logTag: string;
  /**
   * Whether the current run was interrupted by user-initiated stop().
   * Set to true by stop() when a running process is being terminated;
   * subclasses reset it at the start of a turn and read it when building
   * the terminal result event (interrupted vs error precedence).
   */
  protected stoppedByUser: boolean = false;
  /**
   * §4.4 win32 command-not-found 嗅探嫌疑标记：stderr 命中特征行时置位，
   * 但**不**立即杀进程——agent 正常输出可能引用该错误文本（调试 Windows
   * 报错场景），见行即杀会误杀 run。定性走双条件：子类收尾时「标记在 +
   * 非零退出」才判 command-not-found；真挂起由既有 grace/超时兜底。
   */
  protected commandNotFoundSeen = false;

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
   * stdio config for spawn. Default: stdin ignored (agents pass the prompt
   * via argv).
   */
  protected getStdio(): ('ignore' | 'pipe')[] {
    return ['ignore', 'pipe', 'pipe'];
  }

  /**
   * Create an async iterator over the child's stdout. Default: createJSONLStream
   * with P1-4 backpressure enabled (pauseThreshold=100).
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
   * Await the spawn 'error' event when proc.pid === undefined. Races a
   * finite timeout (review P2-11) against the 'error' event: Node guarantees
   * 'error' for ENOENT/EACCES, but some binaries fail silently without ever
   * emitting it. Without the race, the spawn lead-in hangs forever → the
   * workspace serial queue never settles → permanent deadlock, and /stop
   * can't recover (ProcessStopper returns early when pid === undefined).
   * The timeout keeps the deadlock bounded.
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
   * On success returns the spawned child.
   */
  protected async spawnChild(opts: SpawnOptions): Promise<ChildProcess> {
    const proc = spawnProcess(this.binary, this.buildArgv(opts), {
      cwd: opts.cwd,
      stdio: this.getStdio(),
      env: process.env,
      // posix 建新进程组以便负 PID 组杀（壳包装/子进程一并终止）；win32 不
      // detached —— `.cmd` 垫片在 DETACHED_PROCESS 下丢 stdio（见
      // useDetachedProcessGroup），树杀由 taskkill /T 负责。
      detached: useDetachedProcessGroup(),
      windowsHide: true,
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
        // §4.4 win32 command-not-found 嗅探：经 cmd 垫片启动失败不是 spawn 的
        // ENOENT，而是 stderr 的 "is not recognized..." 行。命中只记嫌疑标记
        // （双条件之一），不立即杀——定性由子类收尾的「标记 + 非零退出」
        // 双条件完成；子进程真挂起由既有 grace/超时看门狗兜底。
        if (isWindowsCommandNotFoundLine(text)) {
          this.commandNotFoundSeen = true;
          getLogger().error(`[${this.logTag}] command not found suspected (win32 shim): ${text}`);
        }
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
   * Stop the current process if one is running. Delegates the actual
   * SIGTERM → grace → SIGKILL sequence to `this.stopper.stop(proc, opts)`
   * (see `src/runner/common/process-stopper.ts`), forwarding the `immediate`
   * flag verbatim so all subclasses inherit identical stop semantics.
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
   * registered runner; previously duplicated verbatim in the runner
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

  protected abstract buildArgv(opts: SpawnOptions): string[];
}
