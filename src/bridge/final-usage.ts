/**
 * Final usage resolution extracted from Bridge (2026-09 round-2
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
import type { AgentKind } from '../runner/index.js';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type FinalUsageSnapshot = {
  contextLength?: number;
  contextLimit?: number;
  compactCount?: number;
  compactPreContextLength?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cumulativeTotalTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeCacheReadTokens?: number;
  cumulativeCacheCreationTokens?: number;
};

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
      // EnterWorktree relocate (2026-08-04): jsonl read silently returned no
      // usage (e.g. transcript moved mid-session). Surface it so token-stat
      // fallback to per-run live usage is visible in logs, not silent.
      getLogger().warn(
        `[lark-remote] resolveFinalUsage: no usage from jsonl sessionId=${sessionId} cwd=${cwd} agent=${agentKind}, card falls back to per-run live usage`,
      );
    }
    return content.usage
      ? {
          contextLength: content.usage.contextLength,
          contextLimit: content.usage.contextLimit,
          compactCount: content.usage.compactCount,
          compactPreContextLength: content.usage.compactPreContextLength,
          cacheReadTokens: content.usage.cacheReadTokens,
          cacheCreationTokens: content.usage.cacheCreationTokens,
          totalTokens: content.usage.totalTokens,
          inputTokens: content.usage.inputTokens,
          outputTokens: content.usage.outputTokens,
          cumulativeTotalTokens: content.usage.cumulativeTotalTokens,
          cumulativeInputTokens: content.usage.cumulativeInputTokens,
          cumulativeOutputTokens: content.usage.cumulativeOutputTokens,
          cumulativeCacheReadTokens: content.usage.cumulativeCacheReadTokens,
          cumulativeCacheCreationTokens: content.usage.cumulativeCacheCreationTokens,
        }
      : undefined;
  } catch (err) {
    getLogger().warn(
      `[lark-remote] resolveFinalUsage failed sessionId=${sessionId}: ${errorMessage(err)}`,
    );
    return undefined;
  }
}
