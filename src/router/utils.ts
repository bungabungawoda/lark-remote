/**
 * Pure utility functions extracted from router/index.ts.
 * Path-safety helpers, display formatting, and validation — no Router state.
 */

import type { ActiveRunSnapshot } from '../bridge/index.js';

// --- Utility ---

export interface SessionDisplayUsage {
  contextLength?: number;
  /** 当前模型 context window 上限（仅 codex 提供）；用于渲染 "Context - X (Y%)"。 */
  contextLimit?: number;
  compactCount?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

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

// --- Extracted helpers for refactoring ---

/** Clamp `v` into [min, max]. */
export function clampInt(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * Format number to human-readable unit string.
 * - >= 1M: one decimal, M suffix (e.g., 1200000 → 1.2M, 25000000 → 25M)
 * - >= 1K: rounded to nearest integer K (e.g., 1500 → 2K, 120000 → 120K)
 * - < 1K: as-is (e.g., 500 → "500")
 */
function formatTokenK(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    const rounded = Math.round(m * 10) / 10;
    // Drop unnecessary ".0" for whole numbers (2.0M → 2M)
    return rounded === Math.floor(rounded) ? `${Math.floor(rounded)}M` : `${rounded}M`;
  }
  if (n >= 1000) {
    const k = Math.round(n / 1000);
    return `${k}K`;
  }
  return n.toString();
}

/**
 * Format usage stats (context length, compact count, cache tokens) into a display string.
 * Each stat on its own line with blank lines between sections.
 * @param usage - Usage stats object
 * @param options - Optional display options (showResult adds result line)
 */
export function formatUsageStats(
  usage?: {
    contextLength?: number;
    contextLimit?: number;
    compactCount?: number;
    /** 压缩前上下文水位；与 contextLength（压缩后）成对出现在 Compact 卡上。 */
    compactPreContextLength?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    /** Agent-declared total; when present the display uses max(total, sum of parts). */
    totalTokens?: number;
    /** Real input tokens from the agent's result event. When present, used
     *  directly for the "Input token" line instead of contextLength+cache. */
    inputTokens?: number;
    /** Real output tokens from the agent's result event. When present, used
     *  directly instead of the 10% estimate. */
    outputTokens?: number;
    /** Session-cumulative total/input/output (all runs), from session jsonl. When
     *  present, appended as "· 累计 X" on the Total/Input/Output lines. */
    cumulativeTotalTokens?: number;
    cumulativeInputTokens?: number;
    cumulativeOutputTokens?: number;
    /** Session-cumulative cache read tokens (all runs). */
    cumulativeCacheReadTokens?: number;
    /** Session-cumulative cache creation tokens (all runs). */
    cumulativeCacheCreationTokens?: number;
  },
  options?: { showResult?: boolean; result?: string },
): string {
  const lines: string[] = [];

  // 1. Success 状态（通用格式，无具体结果值）
  lines.push('✅ 已完成');

  // 1.5. 可选的结果行（showResult 为 true 时显示）
  if (options?.showResult && options?.result) {
    lines.push(`结果 - ${options.result}`);
  }

  // 2. Context 长度（compact 卡同时展示压缩前水位）
  if (usage?.contextLength !== undefined) {
    const ctxLimit = usage.contextLimit;
    const ctxPercent =
      ctxLimit !== undefined && ctxLimit > 0
        ? ` (${Math.round((usage.contextLength / ctxLimit) * 100)}%)`
        : '';
    const preCompact =
      usage.compactPreContextLength !== undefined
        ? `（压缩前 ${formatTokenK(usage.compactPreContextLength)}）`
        : '';
    lines.push(`Context - ${formatTokenK(usage.contextLength)}${ctxPercent}${preCompact}`);
  }

  // 3. Compact 次数
  if (usage?.compactCount) {
    lines.push(`Compact - ${usage.compactCount}次`);
  }

  // 4-7. Token 统计
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheCreation = usage?.cacheCreationTokens ?? 0;
  const realInput = usage?.inputTokens;
  const realOutput = usage?.outputTokens;
  // Cumulative suffix (session-wide totals), appended to Input/Output lines.
  const cumInputSuffix =
    usage?.cumulativeInputTokens !== undefined
      ? ` · 累计 ${formatTokenK(usage.cumulativeInputTokens)}`
      : '';
  const cumOutputSuffix =
    usage?.cumulativeOutputTokens !== undefined
      ? ` · 累计 ${formatTokenK(usage.cumulativeOutputTokens)}`
      : '';
  const cumTotalSuffix =
    usage?.cumulativeTotalTokens !== undefined
      ? ` · 累计 ${formatTokenK(usage.cumulativeTotalTokens)}`
      : '';

  // 计算累计 cache 命中率
  const cumInput = usage?.cumulativeInputTokens;
  const cumCacheRead = usage?.cumulativeCacheReadTokens;
  const cumCachePercent =
    cumInput !== undefined && cumCacheRead !== undefined && cumInput + cumCacheRead > 0
      ? Math.round((cumCacheRead / (cumInput + cumCacheRead)) * 100)
      : null;

  // 构建累计 suffix
  const cumCacheReadSuffix =
    cumCacheRead !== undefined
      ? ` · 累计 ${formatTokenK(cumCacheRead)}` +
        (cumCachePercent !== null ? ` (${cumCachePercent}%)` : '')
      : '';
  const cumCacheCreateSuffix =
    usage?.cumulativeCacheCreationTokens !== undefined
      ? ` · 累计 ${formatTokenK(usage.cumulativeCacheCreationTokens)}`
      : '';

  if (realInput !== undefined && realOutput !== undefined) {
    // Unified ccusage-aligned formula:
    //   total = max(total_tokens, input + output + cacheRead + cacheCreation)
    //   cache% = cacheRead / (input + cacheRead)
    // cacheRead/cacheCreation are never double-counted; total_tokens folds in any
    // extra (e.g. opencode reasoning, which is separate from output) via max().
    const promptTokens = realInput + cacheRead;
    const cachePercent = promptTokens > 0 ? Math.round((cacheRead / promptTokens) * 100) : 0;
    const sumParts = realInput + realOutput + cacheRead + cacheCreation;
    const totalTokens =
      usage?.totalTokens != null ? Math.max(usage.totalTokens, sumParts) : sumParts;

    lines.push(`Input token - ${formatTokenK(realInput)}${cumInputSuffix}`);
    lines.push(`Output token - ${formatTokenK(realOutput)}${cumOutputSuffix}`);
    if (cacheCreation > 0) {
      lines.push(`Cache create - ${formatTokenK(cacheCreation)}${cumCacheCreateSuffix}`);
    }
    lines.push(`Cached token - ${formatTokenK(cacheRead)} (${cachePercent}%)${cumCacheReadSuffix}`);
    lines.push(`Total token - ${formatTokenK(totalTokens)}${cumTotalSuffix}`);
  } else {
    // Estimate path: when real input/output are absent,
    // fall back to the 10% estimate based on contextLength.
    const inputRef = usage?.contextLength ?? cacheRead;
    if (inputRef > 0 || cacheRead > 0 || cacheCreation > 0) {
      const totalInput = inputRef + cacheRead;
      const outputEst = inputRef > 0 ? Math.round(inputRef * 0.1) : 0;
      const cachePercent = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0;
      const totalTokens = totalInput + outputEst + cacheCreation;

      lines.push(`Input token - ${formatTokenK(totalInput)}${cumInputSuffix}`);
      lines.push(`Output token - ${formatTokenK(outputEst)}${cumOutputSuffix}`);
      if (cacheCreation > 0) {
        lines.push(`Cache create - ${formatTokenK(cacheCreation)}${cumCacheCreateSuffix}`);
      }
      lines.push(
        `Cached token - ${formatTokenK(cacheRead)} (${cachePercent}%)${cumCacheReadSuffix}`,
      );
      lines.push(`Total token - ${formatTokenK(totalTokens)}${cumTotalSuffix}`);
    }
  }

  return lines.join('\n');
}
