/**
 * 平台选择的唯一入口（design.md §2.2 纪律）。
 *
 * `process.platform` 的读取只允许发生在本文件；其余模块一律导入
 * `currentPlatform` / `isWin32`，或接受显式 platform 参数（便于在任意
 * 宿主上单测 win32 语义）。
 */
export const currentPlatform: NodeJS.Platform = process.platform;

export function isWin32(platform: NodeJS.Platform = currentPlatform): boolean {
  return platform === 'win32';
}
