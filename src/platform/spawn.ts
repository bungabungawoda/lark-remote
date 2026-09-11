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
import { currentPlatform } from './select.js';

/** cross-spawn 包装：posix 直通，win32 PATHEXT + 垫片 cmd.exe 受控执行。 */
export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return crossSpawn(command, [...args], options);
}

/** cross-spawn 同步版（一次性命令探测/目录查询用）。 */
export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  return crossSpawn.sync(command, [...args], options);
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
 * win32 command-not-found 行嗅探（§4.4）：命中即视为「命令缺失」失败而非
 * 普通非零退出。platform 注入使其在任意宿主可测。
 */
export function isWindowsCommandNotFoundLine(
  line: string,
  platform: NodeJS.Platform = currentPlatform,
): boolean {
  return platform === 'win32' && COMMAND_NOT_FOUND_PATTERN.test(line);
}
