/**
 * 阻止系统休眠（sleep-blocker）——lark-remote 的典型场景是「人不在电脑前，飞书远程
 * 连本机」，系统一旦休眠 WebSocket 即断，lark-remote 失效。
 *
 * - darwin：`caffeinate -i -w <pid>`（系统自带）。`-i` 只阻止系统空闲睡眠，不
 *   阻止显示器睡眠；`-w <pid>` 把 power assertion 绑定到 lark-remote 进程生命周期，
 *   lark-remote 退出/崩溃/被 kill -9 时 caffeinate 自动退出释放——零清理、无孤儿
 *   唤醒锁。已知局限：MacBook 合盖（clamshell）睡眠无法阻止。
 * - win32：Windows 没有自带命令行工具能持有 execution state（powercfg 是改全局
 *   电源计划；bun:ffi 在 Windows ARM64 被禁且 bin 入口会回退 node），因此 spawn
 *   一个长寿 powershell.exe 子进程 P/Invoke 调一次
 *   `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` **（flags 必须以
 *   十进制插入脚本：十六进制写法会被 PowerShell 按 Int32 解析成负数，抛的是**非终止
 *   错误**——脚本不中断、API 静默不被调用，2026-09-22 真机踩过；详见下方常量注释）**，
 *   随后每 30s
 *   轮询父进程 pid，父进程消失即自行退出（对应 `caffeinate -w` 的自清理机制，
 *   防止 lark-remote 崩溃后留下孤儿永久阻止睡眠；最坏 30s 孤儿窗口只多挡一会儿空闲
 *   睡眠，无正确性影响）。
 *
 *   win32 的释放语义（MSDN「Mobile PC Power Management」明确）：execution state
 *   按**线程**跟踪、系统取所有线程请求的并集，线程消失（正常退出或被杀）即自动
 *   移除该线程的请求——因此**不需要**显式 `SetThreadExecutionState(ES_CONTINUOUS)`
 *   清除（那是同进程优雅退出的等价写法，这里由 helper 线程死亡等价完成）。同理，
 *   ES_SYSTEM_REQUIRED 只挡「空闲」睡眠，挡不住用户合盖/按电源键主动触发
 *   （MSDN 原文：cannot be used to prevent the user from putting the computer to
 *   sleep），与 darwin `-i` 的语义边界一致。
 * - 其他平台：no-op 返回 null。
 *
 * 两平台的 assertion / execution state 都是并集 + 引用计数语义：多实例（多
 * configDir）各起一个 helper 互不冲突，任一存活即阻止睡眠，单个实例退出只释放
 * 自己那份。每个 lark-remote 生命周期只 spawn 一次 helper，无任何周期性命令。
 *
 * best-effort：spawn 失败只记 warn，绝不阻断 lark-remote 启动。
 */
import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from './spawn.js';
import { getLogger } from '../logger/index.js';

export interface SleepBlocker {
  /** 防御性停止 helper（正常路径 helper 随 lark-remote 死亡自行退出）。 */
  stop(): void;
}

export interface SleepBlockerOptions {
  platform: NodeJS.Platform;
  pid: number;
  /** 测试注入点：默认走 platform/spawn.ts 的 cross-spawn 收口。 */
  spawnFn?: typeof spawnProcess;
}

/**
 * ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)。
 *
 * **必须按无符号 32 位取值**：`0x80000001` = 2147483649 超出 Int32 正数上界
 * （2147483647），而 PowerShell 的数字字面量按 Int32 解析 —— 十六进制写法一旦
 * 进了脚本就会被解析成 **-2147483647**，传给 P/Invoke 声明的 `uint` 形参时抛
 * `MethodArgumentConversionInvalidCastArgument`（2026-09-22 真机复现）。
 */
const ES_FLAGS_UINT32 = (0x80000000 | 0x00000001) >>> 0;

/**
 * 插入 PowerShell 脚本的 ES flags 字面量，**十进制**（`2147483649`）。
 *
 * 上面那个异常是**非终止错误**：PowerShell 不中断脚本，后面的看门循环照跑 ——
 * 于是 helper 进程一直活着、`SetThreadExecutionState` 却从未被调用，防休眠彻底
 * 失效，而「helper 退出」这条唯一的告警通道恰好不触发（日志里只剩一句 `active`，
 * 系统照记 Kernel-Power id=42 / System Idle 睡眠）。十进制字面量走
 * Int64 → UInt32 转换，可安全传递。
 */
const WIN32_ES_FLAGS_LITERAL = String(ES_FLAGS_UINT32);

/**
 * PowerShell 托管脚本：声明 P/Invoke → 设置持续唤醒 → 轮询父 pid 直至父进程消失。
 * 单字符串经 `-Command` 传入（不经 shell，内嵌双引号安全）；父 pid 是 number，插值安全。
 *
 * 首句 `$ErrorActionPreference = 'Stop'` 把非终止错误**升级为终止错误**：P/Invoke
 * 声明或调用一旦出问题，helper 立刻退出，从而走到 startSleepBlocker 的 `exit`
 * 告警路径。否则「进程活着但 execution state 没设置上」属于静默态，日志里查不出来。
 * 看门循环自带 `-ErrorAction SilentlyContinue`，不受该设置影响（父进程消失本就是
 * 正常结束路径）。
 */
export function win32SleepBlockerScript(parentPid: number): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class SleepBlocker { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags); }'`,
    `[SleepBlocker]::SetThreadExecutionState(${WIN32_ES_FLAGS_LITERAL}) | Out-Null`,
    `while (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`,
  ].join('; ');
}

export function startSleepBlocker(opts: SleepBlockerOptions): SleepBlocker | null {
  const { platform, pid } = opts;
  const spawnFn = opts.spawnFn ?? spawnProcess;
  const logger = getLogger();

  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'caffeinate';
    args = ['-i', '-w', String(pid)];
  } else if (platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-Command', win32SleepBlockerScript(pid)];
  } else {
    return null;
  }

  let proc: ChildProcess;
  try {
    proc = spawnFn(command, args, { stdio: 'ignore' });
  } catch (err) {
    logger.warn(`[sleep-blocker] failed to spawn ${command}:`, err);
    return null;
  }

  // spawn 二进制缺失早检 + error 事件兜底（同 runner 层纪律）
  if (proc.pid === undefined) {
    logger.warn(`[sleep-blocker] ${command} unavailable (spawn failed), sleep prevention off`);
    return null;
  }
  proc.on('error', (err) => {
    logger.warn(`[sleep-blocker] ${command} error:`, err);
  });
  // helper 意外死亡 = 防休眠静默失效（win32 上 Add-Type 动态编译被企业策略/
  // 杀软拦掉、P/Invoke 调用抛错——脚本首句已用 $ErrorActionPreference='Stop' 把
  // 非终止错误升级为终止错误，确保这类失败能落到这条分支；darwin 上 caffeinate
  // 早退）。桥此时还活着，是唯一能留痕的时机——否则日志里只剩启动那句 "active"，
  // 误以为防休眠在生效。
  let stopping = false;
  proc.on('exit', (code, signal) => {
    if (stopping) return;
    logger.warn(
      `[sleep-blocker] ${command} exited unexpectedly (code=${code}, signal=${signal}), sleep prevention off`,
    );
  });
  // helper 不得阻止 lark-remote 自身退出；父进程死后 helper 走各自的自清理机制退出
  proc.unref();

  logger.info(`[sleep-blocker] active via ${command} pid=${proc.pid}`);
  return {
    stop(): void {
      stopping = true;
      try {
        proc.kill();
      } catch {
        // helper 已死或不可杀——正常路径下它会自行退出，忽略
      }
    },
  };
}
