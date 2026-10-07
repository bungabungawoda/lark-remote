/**
 * vi.mock factory helper：短路 `spawnProcessSync`，避免用例真的拉起本机 agent CLI。
 *
 * 同步 CLI 通道（`codex debug models` / `opencode models --verbose` /
 * `kimi provider list --json` 等）只用于探测/诊断，配置层对失败已有 FALLBACK
 * 兜底。真起 CLI 会让用例依赖本机装没装这些工具，并带 2-7s 延迟，是跨平台
 * flaky 的来源（.probe 实测归因）。
 *
 * 用法（vi.mock 工厂体，注意路径按被测文件自身相对 `tests/lib` 与 `src` 填写）：
 *
 *   vi.mock('<rel>/src/platform/spawn.js', async (importOriginal) => {
 *     const actual = await importOriginal<typeof import('<rel>/src/platform/spawn.js')>();
 *     const { shortCircuitSpawn } = await import('<rel-lib>/spawn-shortcircuit.js');
 *     return shortCircuitSpawn(actual);
 *   });
 *
 * 用 `await import()` 而非顶层 import 引用本 helper，是因为 `vi.mock` 工厂会被
 * vitest 提升到模块顶部，直接引用顶层绑定会触发未初始化错误。
 */
import type * as spawnModule from '../../src/platform/spawn.js';

export interface ShortCircuitSpawnOptions {
  /** 进程退出码；null 表示未正常退出（配合 error 使用）。默认 1。 */
  status?: number | null;
  /** 命令未安装等错误对象；提供时写入 result.error。 */
  error?: Error;
}

/** 将 spawnProcessSync 换成恒定失败结果，其余导出保持真实。 */
export function shortCircuitSpawn(
  actual: typeof spawnModule,
  opts: ShortCircuitSpawnOptions = {},
): typeof spawnModule {
  const result: Record<string, unknown> = {
    pid: 0,
    output: [],
    stdout: '',
    stderr: '',
    status: opts.status ?? 1,
    signal: null,
  };
  if (opts.error) result.error = opts.error;
  return {
    ...actual,
    spawnProcessSync: (() => ({ ...result })) as unknown as typeof actual.spawnProcessSync,
  };
}

/** 变体：命令未安装（ENOENT），用于验证配置层降级路径。 */
export function shortCircuitSpawnEnoent(
  actual: typeof spawnModule,
  binary = 'opencode',
): typeof spawnModule {
  return shortCircuitSpawn(actual, {
    status: null,
    error: Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' }),
  });
}
