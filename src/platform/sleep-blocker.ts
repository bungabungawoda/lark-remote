/**
 * 阻止系统休眠（sleep-blocker）——bridge 的典型场景是「人不在电脑前，飞书远程
 * 连本机」，系统一旦休眠 WebSocket 即断，bridge 失效。
 *
 * - darwin：`caffeinate -i -w <pid>`（系统自带）。`-i` 只阻止系统空闲睡眠，不
 *   阻止显示器睡眠；`-w <pid>` 把 power assertion 绑定到 bridge 进程生命周期，
 *   bridge 退出/崩溃/被 kill -9 时 caffeinate 自动退出释放——零清理、无孤儿
 *   唤醒锁。已知局限：MacBook 合盖（clamshell）睡眠无法阻止。
 * - win32：Windows 没有自带命令行工具能持有 execution state（powercfg 是改全局
 *   电源计划；bun:ffi 在 Windows ARM64 被禁且 bin 入口会回退 node），因此 spawn
 *   一个长寿 powershell.exe 子进程 P/Invoke 调一次
 *   `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`，随后每 30s
 *   轮询父进程 pid，父进程消失即自行退出（对应 `caffeinate -w` 的自清理机制，
 *   防止 bridge 崩溃后留下孤儿永久阻止睡眠；最坏 30s 孤儿窗口只多挡一会儿空闲
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
 * 自己那份。每个 bridge 生命周期只 spawn 一次 helper，无任何周期性命令。
 *
 * best-effort：spawn 失败只记 warn，绝不阻断 bridge 启动。
 */
import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from './spawn.js';
import { getLogger } from '../logger/index.js';

export interface SleepBlocker {
  /** 防御性停止 helper（正常路径 helper 随 bridge 死亡自行退出）。 */
  stop(): void;
}

export interface SleepBlockerOptions {
  platform: NodeJS.Platform;
  pid: number;
  /** 测试注入点：默认走 platform/spawn.ts 的 cross-spawn 收口。 */
  spawnFn?: typeof spawnProcess;
}

/** ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)。 */
const ES_FLAGS = '0x80000001';

/**
 * PowerShell 托管脚本：声明 P/Invoke → 设置持续唤醒 → 轮询父 pid 直至父进程消失。
 * 单字符串经 `-Command` 传入（不经 shell，内嵌双引号安全）；父 pid 是 number，插值安全。
 */
export function win32SleepBlockerScript(parentPid: number): string {
  return [
    `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class SleepBlocker { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags); }'`,
    `[SleepBlocker]::SetThreadExecutionState(${ES_FLAGS}) | Out-Null`,
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
  // 杀软拦掉、Get-Process 权限失败；darwin 上 caffeinate 早退）。桥此时还活着，
  // 是唯一能留痕的时机——否则日志里只剩启动那句 "active"，误以为防休眠在生效。
  let stopping = false;
  proc.on('exit', (code, signal) => {
    if (stopping) return;
    logger.warn(
      `[sleep-blocker] ${command} exited unexpectedly (code=${code}, signal=${signal}), sleep prevention off`,
    );
  });
  // helper 不得阻止 bridge 自身退出；父进程死后 helper 走各自的自清理机制退出
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
