/**
 * 可用性探测（design.md §4.3）。
 *
 * win32 替代 `spawn('which')`：resolveExecutable 纯 Node 查找（PATH + PATHEXT），
 * 不再依赖外部 `which` 进程（Windows 无原生 which）。
 */
import { resolveExecutable, type ResolveOptions } from './command.js';

export type ProbeOptions = ResolveOptions;

/** 可执行命令是否可用（含 win32 .cmd 垫片 → cmd.exe 兜底的高风险路径）。 */
export function isExecutableAvailable(name: string, opts?: ProbeOptions): boolean {
  return resolveExecutable(name, opts) !== null;
}
