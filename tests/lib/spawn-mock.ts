/**
 * 共享 `vi.mock('.../platform/spawn.js')` 工厂。
 *
 * 20 个 codex/kimi 配置锚点手抄同一段 mock：
 *   spawnProcessSync: 返回 string/Buffer 视为成功 stdout，其余（抛错/对象）原样穿透
 *   spawnProcess: 一律抛错（锚点禁止真起异步进程）
 *
 * 用法（相对路径按测试文件位置调整）：
 *   const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));
 *   vi.mock('../../../src/platform/spawn.js', async () => ({
 *     ...(await import('../../lib/spawn-mock.js')).spawnModuleMock(mockSpawnSync),
 *   }));
 */
export function spawnModuleMock(mockSpawnSync: (...args: unknown[]) => unknown) {
  return {
    spawnProcessSync: (...args: unknown[]) => {
      const v = mockSpawnSync(...args);
      if (typeof v === 'string' || Buffer.isBuffer(v)) {
        return { status: 0, stdout: v, stderr: '' };
      }
      return v;
    },
    spawnProcess: () => {
      throw new Error('anchor test must not spawn async');
    },
  };
}
