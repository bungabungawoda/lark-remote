/**
 * spawn 统一收口。
 *
 * 全部子进程拉起必须走本模块，禁止直接 child_process.spawn：
 * - cross-spawn 在 posix 是 child_process.spawn 直通（零行为差异）；win32 上
 *   做 PATHEXT 解析，.cmd/.bat 经 cmd.exe 以正确的引号转义执行——取代 v1 的
 *   手写垫片解析层；
 * - mergeProcessEnv：Windows env 键大小写不敏感，直接 `{...process.env, PATH:x}`
 *   在键为 `Path` 的机器上产生双键、子进程行为未定义——任何 env 覆盖注入点
 *   必须经它合并（先按不区分大小写删旧键再设新值）；
 * - isWindowsCommandNotFoundLine：win32 经 cmd 垫片启动失败不是 spawn 的
 *   error 事件 ENOENT，而是子进程往 stderr 打
 *   "'xxx' is not recognized as an internal or external command"（§4.4）。
 */
import crossSpawn from 'cross-spawn';
import type { ChildProcess, SpawnOptions, SpawnSyncOptions } from 'node:child_process';
import type { SpawnSyncReturns } from 'child_process';
import { currentPlatform, isWin32 } from './select.js';

/**
 * cross-spawn 包装：posix 直通，win32 PATHEXT + 垫片 cmd.exe 受控执行。
 *
 * 默认注入 `windowsHide: true`：win32 上 .cmd/.bat 垫片经 cmd.exe 执行时，
 * 不加该选项会闪控制台窗口（测试批量拉起 mock agent 时尤其明显）。该选项
 * 在 posix 上被 Node 直接忽略（Windows-only），因此默认值零跨平台影响；
 * 调用方显式传 `windowsHide: false` 仍可覆盖。
 */
export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return crossSpawn(command, [...args], { windowsHide: true, ...options });
}

/** cross-spawn 同步版（一次性命令探测/目录查询用）。默认注入同 {@link spawnProcess}。 */
export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  return crossSpawn.sync(command, [...args], { windowsHide: true, ...options });
}

/**
 * env 覆盖合并：先按不区分大小写删除 base 中的同名旧键，再设新值。
 * Windows env 键大小写不敏感，`{...process.env, PATH:x}` 会产生 `PATH`/`Path`
 * 双键（§8.3）。注意 posix 上并非普通 spread：base 中大小写不同名的键（如
 * `Path`）也会被删除，而非与 `PATH` 并存——可接受（posix 语义键为全大写
 * `PATH`，大小写变体本身就不是语义键），但语义与 spread 不同，勿混淆。
 */
export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete out[existing];
      }
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const COMMAND_NOT_FOUND_PATTERN =
  /is not recognized as an internal or external command|operable program or batch file/i;

/**
 * 是否需要为子进程建独立进程组（`spawn` 的 `detached: true`）。
 *
 * posix：Terminator 的组杀用负 PID（`kill(-pgid)`），子进程必须是组长，
 * 否则 kill 抛 ESRCH 被吞，停止/清理链路全失效。
 *
 * win32：组杀已由 terminator 的 `taskkill /PID <pid> /T /F` 树杀替代，不需要
 * 进程组；而 `detached: true` 会让 **`.cmd` 垫片丢掉父进程的 stdio 管道** ——
 * Windows 上 `DETACHED_PROCESS` 下 cmd.exe 另建控制台并重绑标准句柄，于是
 * 子进程（npm 安装的 agent 全是 `.cmd` 垫片）的 stdout/stderr 永不抵达父进程，
 * 表现为 agent 全程静默、turn 超时。实测 `windowsHide: true` 不能改善，
 * 因此 v1 §3.3「保留 detached + windowsHide」的假设据此修正为「win32 不
 * detached」。调用方应同时传 `windowsHide: true`，避免 cmd.exe 闪控制台窗口。
 */
export function useDetachedProcessGroup(platform: NodeJS.Platform = currentPlatform): boolean {
  return !isWin32(platform);
}

/**
 * win32 command-not-found 行嗅探（§4.4）：命中即视为「命令缺失」失败而非
 * 普通非零退出。platform 注入使其在任意宿主可测。
 */
export function isWindowsCommandNotFoundLine(
  line: string,
  platform: NodeJS.Platform = currentPlatform,
): boolean {
  return platform === 'win32' && COMMAND_NOT_FOUND_PATTERN.test(line);
}
