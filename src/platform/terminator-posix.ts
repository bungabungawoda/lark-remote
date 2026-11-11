/**
 * posix 终止器。
 *
 * 语义：SIGTERM 打负 PID 进程组 → 等 graceMs → SIGKILL；immediate 则两个信号
 * 连发。相对最初的进程终止器类多两样东西：
 *   - 返回 {@link TerminateResult} 让终止途经可观测（与 win32 同构）；
 *   - `cleanupOnExit`（Terminator 接口要求的进程级退出清理）。
 *
 * 早期另有一个 ProcessStopper 兼容壳，已随 transport / spawning-runner /
 * kimi acp 三个调用点迁完后删除。
 */
import type { ChildProcess } from 'node:child_process';
import { getLogger } from '../logger/index.js';
import type { Terminator } from './terminator.js';
import type { TerminateResult } from './types.js';

export type LogLevel = 'debug' | 'info' | 'warn';
type TerminatorLogger = (level: LogLevel, message: string) => void;

interface PosixTerminatorDeps {
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

/** 退出判定统一口径（红线）：exitCode !== null || signalCode !== null。 */
function isAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

/**
 * 向进程组发一个信号；返回失败原因，null 表示已送达或无需送达。
 *
 * ESRCH 有两种完全不同的语义：① 进程组随子进程退出而消失（真成功）；
 * ② 子进程压根没建独立进程组（未 detached，pgid ≠ pid），组信号从没命中过。
 * 把两者都当成功会让「非组长」的子进程静默残留，因此 ESRCH 时退回单 pid
 * 信号：能送达就杀掉，仍 ESRCH 才说明进程确实没了。正常路径零额外 kill 调用。
 */
function signalGroup(pgid: number, signal: NodeJS.Signals): string | null {
  try {
    process.kill(pgid, signal);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      return `${signal} 未送达 pgid=${pgid}: ${code ?? (err as Error).message}`;
    }
    const pid = -pgid;
    try {
      process.kill(pid, signal);
      return null;
    } catch (fallbackErr) {
      const fallbackCode = (fallbackErr as NodeJS.ErrnoException).code;
      if (fallbackCode === 'ESRCH') return null; // 进程确实已退出
      return `${signal} 未送达 pid=${pid}: ${fallbackCode ?? (fallbackErr as Error).message}`;
    }
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

  log('debug', `[terminator] sending SIGTERM to pgid=${pgid} immediate=${opts.immediate}`);
  const termErr = signalGroup(pgid, 'SIGTERM');
  if (termErr) {
    log('warn', `[terminator] ${termErr}`);
    return { requested: false, via: 'cooperative', error: termErr };
  }

  if (opts.immediate) {
    // 不等待：SIGKILL 紧随其后；进程已死时 kill 抛 ESRCH，忽略即可
    const killErr = signalGroup(pgid, 'SIGKILL');
    if (killErr) {
      log('warn', `[terminator] ${killErr}`);
      return { requested: false, via: 'taskkill', error: killErr };
    }
    return { requested: true, via: 'taskkill' };
  }

  // 与 exit 事件竞速等 grace；用 once 避免重复 stop() 累积监听器
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
      `[terminator] process group ${pgid} did not exit within grace period, sending SIGKILL`,
    );
    const killErr = signalGroup(pgid, 'SIGKILL');
    if (killErr) {
      log('warn', `[terminator] ${killErr}`);
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
        // 组不存在（子进程未 detached）时退回单 pid，别把活进程留下来
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* process already gone */
        }
      }
    },
  };
}
