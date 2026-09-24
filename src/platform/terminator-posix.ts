/**
 * posix 终止器：`src/runner/common/process-stopper.ts` 的原样迁移（design.md §3.2）。
 *
 * 语义与迁移前逐条对齐：SIGTERM 打负 PID 进程组 → 等 graceMs → SIGKILL；
 * immediate 则两个信号连发。本次只新增两样东西：
 *   - 返回 {@link TerminateResult} 让终止途经可观测（与 win32 同构）；
 *   - `cleanupOnExit`（Terminator 接口要求的进程级退出清理）。
 *
 * `ProcessStopper` 保留为兼容壳：行为（含日志文案）零变化，既有调用方与
 * 测试无需改动；M2 调用点迁移时逐个换成 Terminator 后即可删除。
 */
import type { ChildProcess } from 'node:child_process';
import { getLogger } from '../logger/index.js';
import type { Terminator } from './terminator.js';
import type { TerminateResult } from './types.js';

export type LogLevel = 'debug' | 'info' | 'warn';
export type TerminatorLogger = (level: LogLevel, message: string) => void;

export interface PosixTerminatorDeps {
  /** 优雅等待窗口（毫秒），对应现状 stopGraceMs */
  graceMs: number;
  /** 日志注入（测试用）；默认 logger 单例 */
  log?: TerminatorLogger;
}

/** 默认日志出口：与迁移前同级别（debug 记信号，info 记 grace 超时）。 */
function defaultLog(level: LogLevel, message: string): void {
  const logger = getLogger();
  if (level === 'debug') logger.debug(message);
  else if (level === 'warn') logger.warn(message);
  else logger.info(message);
}

/** 退出判定统一口径（CLAUDE.md 红线）：exitCode !== null || signalCode !== null。 */
function isAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

/**
 * 向进程组发一个信号；返回失败原因，null 表示已送达或无需送达。
 *
 * ESRCH（进程组已经没了）与杀成功同等处置——这正是「停止」想要的结果；
 * 其余失败（EPERM 等）必须报出去，否则调用方拿到假成功，事后既不知也没得查。
 */
function signalGroup(pgid: number, signal: NodeJS.Signals): string | null {
  try {
    process.kill(pgid, signal);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return null;
    return `${signal} 未送达 pgid=${pgid}: ${code ?? (err as Error).message}`;
  }
}

async function stopPosix(
  proc: ChildProcess,
  opts: { graceMs: number; immediate: boolean },
  log: TerminatorLogger,
): Promise<TerminateResult> {
  if (!isAlive(proc)) {
    return { requested: false, via: 'already-exited' };
  }
  const pid = proc.pid;
  if (pid === undefined) {
    return { requested: false, via: 'already-exited' };
  }

  // 负 PID = 整个进程组：shell 包装层与孙进程一并带走
  const pgid = -pid;

  log('debug', `[process-stopper] sending SIGTERM to pgid=${pgid} immediate=${opts.immediate}`);
  const termErr = signalGroup(pgid, 'SIGTERM');
  if (termErr) {
    log('warn', `[process-stopper] ${termErr}`);
    return { requested: false, via: 'cooperative', error: termErr };
  }

  if (opts.immediate) {
    // 不等待：SIGKILL 紧随其后；进程已死时 kill 抛 ESRCH，忽略即可
    const killErr = signalGroup(pgid, 'SIGKILL');
    if (killErr) {
      log('warn', `[process-stopper] ${killErr}`);
      return { requested: false, via: 'taskkill', error: killErr };
    }
    return { requested: true, via: 'taskkill' };
  }

  // 与 exit 事件竞速等 grace；用 once 避免重复 stop() 累积监听器（P2-15）
  let graceTimer: NodeJS.Timeout | undefined;
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      if (!isAlive(proc)) return resolve(true);
      proc.once('exit', () => resolve(true));
    }),
    new Promise<boolean>((resolve) => {
      graceTimer = setTimeout(() => resolve(false), opts.graceMs);
    }),
  ]);
  if (graceTimer) clearTimeout(graceTimer);

  if (!exited) {
    log(
      'info',
      `[process-stopper] process group ${pgid} did not exit within grace period, sending SIGKILL`,
    );
    const killErr = signalGroup(pgid, 'SIGKILL');
    if (killErr) {
      log('warn', `[process-stopper] ${killErr}`);
      return { requested: false, via: 'taskkill', error: killErr };
    }
    return { requested: true, via: 'taskkill' };
  }
  return { requested: true, via: 'cooperative' };
}

export function createPosixTerminator(deps: PosixTerminatorDeps): Terminator {
  const log = deps.log ?? defaultLog;
  return {
    stop(proc, opts): Promise<TerminateResult> {
      return stopPosix(proc, { graceMs: deps.graceMs, immediate: opts.immediate }, log);
    },
    cleanupOnExit(proc): void {
      if (!isAlive(proc)) return;
      const pid = proc.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* process already gone */
      }
    },
  };
}

interface ProcessStopperOptions {
  graceMs: number;
}

interface StopOptions {
  immediate?: boolean;
}

/**
 * 迁移前的类名（兼容壳）：返回 void、接受 null proc。
 * 新代码请用 {@link createPosixTerminator} / `createTerminator`。
 */
export class ProcessStopper {
  private graceMs: number;

  constructor(opts: ProcessStopperOptions) {
    this.graceMs = opts.graceMs;
  }

  async stop(proc: ChildProcess | null, opts?: StopOptions): Promise<void> {
    if (!proc) return;
    await stopPosix(
      proc,
      { graceMs: this.graceMs, immediate: opts?.immediate === true },
      defaultLog,
    );
  }
}
