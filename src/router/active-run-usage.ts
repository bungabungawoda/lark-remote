import type { ActiveRunSnapshot } from '../bridge/index.js';
import type { SessionDisplayUsage } from '../card/usage-format.js';

/** 从 bridge 的活跃 run 快照提取会话卡需要的用量字段。 */
export function activeRunUsage(
  activeRun: ActiveRunSnapshot | undefined,
): SessionDisplayUsage | undefined {
  if (!activeRun || activeRun.contextLength === undefined) return undefined;
  return {
    contextLength: activeRun.contextLength,
    compactCount: activeRun.compactCount,
    cacheReadTokens: activeRun.cacheReadTokens,
    cacheCreationTokens: activeRun.cacheCreationTokens,
  };
}
