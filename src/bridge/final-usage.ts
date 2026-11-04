/**
 * Final usage resolution extracted from Bridge (round-2
 * simplification): after a run finishes, re-read the session transcript via
 * the agent's session reader — live stream-json does not emit
 * compact_boundary, so the live contextLength (fallback to result.usage
 * input+output) is unreliable. The transcript jsonl is authoritative for
 * postTokens + compact event count.
 *
 * Bridge state is passed in explicitly (registry + default agent); the
 * function itself is stateless.
 */
import { getLogger } from '../logger/index.js';
import type { SessionReaderRegistry } from '../session/index.js';
import type { AgentKind } from '../agent-kinds.js';
import type { AgentSessionUsage } from '../session-contract.js';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * jsonl 侧的最终用量快照。就是 `AgentSessionUsage` 的可选形态：reader 保证
 * input/output/contextLength 有值，这里允许「读不到」，字段清单不再手抄第二份
 * （§9.21 的口径一致要求靠这个单源维持）。
 */
export type FinalUsageSnapshot = Partial<AgentSessionUsage>;

/**
 * Read final usage (contextLength + compactCount + cache tokens) from the
 * session jsonl. Called after a run finishes.
 */
export function resolveFinalUsage(
  registry: SessionReaderRegistry,
  defaultAgent: AgentKind,
  sessionId: string | undefined,
  cwd: string,
  agentKind: AgentKind = defaultAgent,
): FinalUsageSnapshot | undefined {
  if (!sessionId) return undefined;
  try {
    const content = registry.get(agentKind).readSessionContent(sessionId, cwd);
    if (!content.usage) {
      // jsonl 可能读不到 usage（如 EnterWorktree relocate 后 transcript 换了
      // 路径）。这里必须显式 warn：卡片会退回 per-run live 口径，静默的话
      // 数字变化无从排查。
      getLogger().warn(
        `[lark-remote] resolveFinalUsage: no usage from jsonl sessionId=${sessionId} cwd=${cwd} agent=${agentKind}, card falls back to per-run live usage`,
      );
    }
    return content.usage ? { ...content.usage } : undefined;
  } catch (err) {
    getLogger().warn(
      `[lark-remote] resolveFinalUsage failed sessionId=${sessionId}: ${errorMessage(err)}`,
    );
    return undefined;
  }
}
