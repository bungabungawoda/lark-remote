/**
 * 测试用临时目录的统一创建与自动清理。
 *
 * 为什么需要它（2026-09-21 实测）：全仓 215 个测试文件各自
 * `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`，清理方式五花八门 ——
 *   - 有的**完全不删**（beforeEach 建、没有 afterEach），一次全量回归就往 %TEMP%
 *     漏 163 项；
 *   - 有的 `rmSync` 之后紧跟 `mkdirSync` 想「重置复用」目录，配上 beforeEach 的
 *     `mkdtempSync` 就成了**每跑一个用例漏一个**（比不删更隐蔽，看着像有清理）；
 *   - 有的裸 `rmSync` 在 Windows 上撞 EBUSY/EPERM 静默失败。
 * 结果是本仓自己往 %TEMP% 堆了 1775 个目录 / 约 1.7 GB。
 *
 * 用法（新写用例请优先用这个）：
 * ```ts
 * let tmpDir: string;
 * beforeEach(() => { tmpDir = makeTempDir('myfeature-'); });
 * // 不需要写 afterEach —— 文件跑完由 afterAll 统一删
 * ```
 *
 * 与 `tmp-cleanup.ts` 的分工：本模块管**主动登记**（精确，只删自己建的）；
 * `sweepProjectTempDirs()` 管**兜底扫描**（覆盖被强杀 / 超时跳过钩子的场景）。
 * 两者都用 `rmRf`，所以 Windows 句柄未释放时也会重试。
 */
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { rmRf } from './tmp-cleanup.js';

/** 本测试文件创建、待清理的临时目录。vitest 默认 per-file 模块注册表，天然隔离。 */
const tracked = new Set<string>();

/** 防重入：顶层 test 与 project 各配了一份 setupFiles 时只挂一次钩子。 */
let hookRegistered = false;

/** 创建临时目录并登记清理（等价 `fs.mkdtempSync(os.tmpdir()/prefix)`，但不会漏删）。 */
export function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), prefix));
  tracked.add(dir);
  return dir;
}

/** 删除已登记的临时目录；失败不抛（兜底扫描会再兜一次）。 */
export function cleanupTrackedTempDirs(): void {
  for (const dir of tracked) {
    try {
      rmRf(dir);
    } catch {
      // 尽力而为
    }
  }
  tracked.clear();
}

/**
 * 注册文件级清理钩子。由 `vitest-setup.ts` 在每个测试文件加载时调用一次，
 * 因此 afterAll 的作用域就是「当前测试文件」，不会跨文件误删。
 */
export function registerTempDirCleanup(): void {
  if (hookRegistered) return;
  hookRegistered = true;
  afterAll(() => {
    cleanupTrackedTempDirs();
  });
}
