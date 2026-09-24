/**
 * vitest globalSetup 入口：整轮 run 结束后兜底清扫本仓的临时目录残留。
 *
 * 为什么 afterAll 不够：用例被强杀、超时、worker 崩溃时钩子根本不会执行，
 * 这正是 `lark-kimi-runner-*`（308 个）这类残留的成因。globalSetup 的
 * teardown 在整个 run 收尾时跑一次，此时所有 worker 都已退出，扫描才安全。
 *
 * 只按本仓**专属前缀**扫（见 `tmp-cleanup.ts` 的 OUR_TEMP_PREFIXES），
 * 不碰其他程序的临时文件。
 */
import { sweepProjectTempDirs } from './tmp-cleanup.js';

export default function setup(): () => void {
  // globalSetup 在所有 worker 启动之前跑一次，所以这个时刻严格早于本轮创建的
  // 任何临时目录 —— 拿它当基线，兜底就只清上一轮的死残留，不会碰并行 worktree
  // 里正在跑的那一轮（详见 sweepProjectTempDirs 的注释）。
  const runStartedAt = Date.now();
  return function teardown(): void {
    const { removed, failed } = sweepProjectTempDirs(runStartedAt);
    if (removed > 0 || failed.length > 0) {
      const tail = failed.length > 0 ? `，失败 ${failed.length} 个` : '';
      console.log(`[temp-sweep] 兜底清理本仓临时目录残留 ${removed} 个${tail}`);
    }
  };
}
