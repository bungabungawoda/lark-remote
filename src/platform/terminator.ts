/**
 * 平台终止器 seam 的接口层（design.md §3.2 / §3.3）。
 *
 * Windows 没有可拦截的跨进程 SIGTERM、负 PID 无效，因此把「进程组 + 信号」
 * 换成「协议停止通道 + 进程树杀」。本文件只放接口与平台分发，实现见
 * terminator-posix.ts / terminator-win32.ts。
 */
import type { ChildProcess } from 'node:child_process';
import { getLogger } from '../logger/index.js';
import type { AgentStopperRegistry } from './agent-stopper.js';
import type { TerminateResult } from './types.js';
import { currentPlatform, isWin32 } from './select.js';
import { createPosixTerminator } from './terminator-posix.js';
import { createWin32Terminator } from './terminator-win32.js';

// 注册表实现在 agent-stopper.ts（避免与 terminator-win32.ts 循环依赖），
// 这里 re-export 以维持调用方的单一入口。
export { AgentStopperRegistry, agentStopperRegistry } from './agent-stopper.js';
export type { AgentStopper } from './agent-stopper.js';

/**
 * 进程终止器。
 *
 * `stop` 的 `immediate` 语义与原 `process-stopper` 的 `stop({immediate})` 对齐。
 * 设计文档声明返回 `Promise<void>`，这里收窄为 {@link TerminateResult}：降级
 * 必须可观测（优雅段被跳过、走了树杀、进程早已退出），否则 win32 上「等一个
 * 不会来的退出事件」这类退化无法被发现。
 */
export interface Terminator {
  stop(proc: ChildProcess, opts: { immediate: boolean }): Promise<TerminateResult>;
  /** 进程级退出清理：fire-and-forget 强杀 */
  cleanupOnExit(proc: ChildProcess): void;
}

export interface TerminatorDeps {
  /** 优雅等待窗口（毫秒）；win32 为协议停止后的等待，posix 为 SIGTERM→SIGKILL 的 grace */
  graceMs: number;
  /** 平台注入（测试用）；默认当前宿主平台 */
  platform?: NodeJS.Platform;
  /** 当前 run 所属 agent（win32 查协议通道用；posix 忽略） */
  agent?: string;
  /** 协议通道注册表注入（测试隔离）；默认进程级单例 */
  stoppers?: AgentStopperRegistry;
  /** 日志注入（测试用）；默认走 logger 单例 */
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}

/** 默认日志出口：seam 底层（terminator-win32/posix）不反向依赖 logger 单例，由这里接线。 */
function defaultTerminatorLog(level: 'debug' | 'info' | 'warn', message: string): void {
  const logger = getLogger();
  if (level === 'debug') logger.debug(message);
  else if (level === 'warn') logger.warn(message);
  else logger.info(message);
}

/**
 * 唯一的终止器选择入口：posix 走组杀，win32 走「协议通道 + taskkill 树杀」。
 * 其余模块一律拿这里的 Terminator，禁止散落平台 if（§2.2）。
 */
export function createTerminator(deps: TerminatorDeps): Terminator {
  const platform = deps.platform ?? currentPlatform;
  // 默认日志出口必须真的接上：win32 的「无协议通道 → 直接树杀」「协议通道抛错
  // → 转树杀」以及 posix 的 grace 超时都是设计要求的可观测降级信号（§3.2），
  // 缺省 undefined 会让这些信号全部静默消失。
  const log = deps.log ?? defaultTerminatorLog;
  if (isWin32(platform)) {
    return createWin32Terminator({
      graceMs: deps.graceMs,
      agent: deps.agent,
      stoppers: deps.stoppers,
      // win32 侧日志不带级别（无 debug 级输出），统一按 info 透传
      log: (message) => log('info', message),
    });
  }
  return createPosixTerminator({ graceMs: deps.graceMs, log });
}
