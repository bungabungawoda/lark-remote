/**
 * win32 终止器：协议停止通道 → grace 等待 → taskkill 树杀（design.md §3.2）。
 *
 * 状态机：
 *   1. 进程已退出 → nothing（via='already-exited'）
 *   2. immediate  → taskkill /PID <pid> /T /F
 *   3. 优雅       → AgentStopperRegistry 查协议通道
 *      - 无通道：打日志显式跳过优雅段（不等一个不会来的退出事件）→ 直接树杀
 *      - 有通道：调用后与 exit 事件竞速等 graceMs，仍存活 → 树杀
 *
 * 依赖（spawn / 等待器 / 日志）全部构造注入，win32 语义可在任意宿主上单测。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Terminator } from './terminator.js';
import { AgentStopperRegistry, agentStopperRegistry } from './agent-stopper.js';
import type { TerminateResult } from './types.js';

export type SpawnLike = (file: string, args: string[], opts?: SpawnOptions) => ChildProcess;

/** 等待 graceMs 与 exit 事件竞速；返回 true 表示等待结束后进程仍存活。 */
export type WaitForExit = (proc: ChildProcess, ms: number) => Promise<boolean>;

export interface Win32TerminatorDeps {
  /** 协议停止后的优雅等待窗口（毫秒），对应 posix 的 stopGraceMs */
  graceMs: number;
  /** 当前 run 所属 agent：用于查协议停止通道；缺省视为无通道 */
  agent?: string;
  /** 协议通道注册表注入（测试隔离）；默认进程级单例 */
  stoppers?: AgentStopperRegistry;
  /** spawn 注入（测试用）；默认 node:child_process */
  spawn?: SpawnLike;
  /** grace 等待器注入（测试用）；默认与 exit 事件竞速 */
  waitForExit?: WaitForExit;
  /** 日志注入：本模块处于 seam 底层，不反向依赖 logger 单例 */
  log?: (message: string) => void;
}

/** 退出判定统一口径（CLAUDE.md 红线）：exitCode !== null || signalCode !== null。 */
function isAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

/** 默认等待器：exit 事件与定时器竞速，谁先到算谁。 */
async function defaultWaitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  if (!isAlive(proc)) return false;
  return new Promise((resolve) => {
    let settled = false;
    const onExit = (): void => finish(false);
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('exit', onExit);
      resolve(alive);
    };
    proc.on('exit', onExit);
    const timer = setTimeout(() => finish(isAlive(proc)), ms);
  });
}

export function createWin32Terminator(deps: Win32TerminatorDeps): Terminator {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const stoppers = deps.stoppers ?? agentStopperRegistry;
  const waitForExit = deps.waitForExit ?? defaultWaitForExit;
  const log = deps.log;

  /** 树杀：taskkill /PID <pid> /T /F —— posix 负 PID 组杀的等价物。 */
  function killTree(pid: number | undefined): void {
    if (pid === undefined) {
      log?.(`win32 树杀跳过：子进程没有 pid（spawn 未成功）`);
      return;
    }
    try {
      // fire-and-forget：不等 taskkill 自身返回，退出由 proc 的 exit 事件驱动
      const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer?.on?.('error', () => {
        // taskkill 拉起失败不致命：调用方仍可走 killOrphan / 陈旧锁自愈
      });
    } catch (error) {
      log?.(`win32 树杀失败：taskkill 拉起异常 ${String(error)}`);
    }
  }

  return {
    async stop(proc, opts): Promise<TerminateResult> {
      if (!isAlive(proc)) return { requested: false, via: 'already-exited' };
      if (proc.pid === undefined) {
        // 与 posix 同口径：拿不到 pid 就没有可请求的终止目标，不能谎报 requested
        log?.('win32 停止跳过：子进程没有 pid（spawn 未成功），按已退出处理');
        return { requested: false, via: 'already-exited' };
      }
      if (opts.immediate) {
        killTree(proc.pid);
        return { requested: true, via: 'taskkill' };
      }
      const agent = deps.agent;
      // 按 agent + pid 查：同一 agent 可能有多条长驻连接（每 workspace 一条），
      // 只有 pid 能把通道归属钉到手上这个 proc 上。
      const stopper = agent === undefined ? undefined : stoppers.get(agent, proc.pid);
      if (!stopper) {
        // 无通道是合法状态：显式记录后走树杀，不做无意义的优雅空转
        log?.(
          `win32 优雅停止跳过：agent=${agent ?? '(unknown)'} pid=${proc.pid} 无协议停止通道，直接树杀`,
        );
        killTree(proc.pid);
        return { requested: true, via: 'skipped-no-channel' };
      }
      try {
        await stopper(proc);
      } catch (error) {
        // 通道异常不能吞掉终止流程：记录后继续走树杀兜底
        log?.(`win32 协议停止通道异常，转入树杀：${String(error)}`);
      }
      if (!isAlive(proc)) return { requested: true, via: 'cooperative' };
      const stillAlive = await waitForExit(proc, deps.graceMs);
      if (!stillAlive) return { requested: true, via: 'cooperative' };
      killTree(proc.pid);
      return { requested: true, via: 'taskkill' };
    },

    cleanupOnExit(proc): void {
      // M0 真机验证项（§9.2 矩阵）：本方法在 process.on('exit') 里调用，而
      // killTree 依赖 libuv uv_spawn 在 exit handler 内同步发起 taskkill——
      // 大概率可用（uv_spawn 本身同步），但与 posix 路径（同步 process.kill）
      // 可靠性不等价；失败表现为 win32 上 lark-remote 退出后 agent 变孤儿。
      if (!isAlive(proc)) return;
      killTree(proc.pid);
    },
  };
}
