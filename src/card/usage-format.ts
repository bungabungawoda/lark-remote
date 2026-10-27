/**
 * Format session/run usage stats (context, compact count, tokens, cost) into
 * the display strings shown on cards. Pure — no Router state.
 *
 * 归属 card/：渲染层（run-renderer）与 router 都只消费它的展示字符串，此前
 * 住在 router/ 让它成为 card→router 的唯一理由。
 */

import type { UsageSnapshot } from '../session-contract.js';

// --- Utility ---

/** `formatUsageStats` 只读这几项：会话/进度卡片上的紧凑用量行。 */
export type SessionDisplayUsage = Pick<
  UsageSnapshot,
  'contextLength' | 'contextLimit' | 'compactCount' | 'cacheReadTokens' | 'cacheCreationTokens'
>;

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
  usage?: UsageSnapshot & {
    /** 实际生效模型（system.init 携带）。非空字符串才显示。 */
    model?: string;
    /** 本次 run 花费（USD）。存在才显示。 */
    costUsd?: number;
  },
  options?: {
    showResult?: boolean;
    result?: string;
    /**
     * 首行状态文案。默认 `✅ 已完成`；goal 仍 active 的收尾卡必须换掉它——
     * 本轮 turn 结束不等于任务结束。
     */
    completedLabel?: string;
  },
): string {
  const lines: string[] = [];

  // 1. Success 状态（通用格式，无具体结果值）
  lines.push(options?.completedLabel ?? '✅ 已完成');

  // 1.4. 实际生效模型（非空字符串才显示）
  if (usage?.model) {
    lines.push(`Model - ${usage.model}`);
  }

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

  // 一致性护栏：本 run ≤ 累计 是硬不变量（累计 = 所有 run 之和，必 ≥ 本 run）。
  // 违反说明来源 scope 混用（如 DeepSeek live result usage 是累积/超大 scope，
  // 大于 jsonl 去重聚合的 session 累计）。只标记不修正——数字保持原样便于排查，
  // 由数据源修复。两侧都有值时校验（避免旧数据/缺失字段误报）。
  // 两个分支（real input/output / 10% 估计）共用，保证"本 run > 累计"在任意
  // 路径都显式暴露。
  const withCumGuard = (totalTokens: number): string =>
    cumTotalSuffix +
    (usage?.cumulativeTotalTokens !== undefined && totalTokens > usage.cumulativeTotalTokens
      ? ' · ⚠️ 累计异常'
      : '');

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
    lines.push(`Total token - ${formatTokenK(totalTokens)}${withCumGuard(totalTokens)}`);
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
      lines.push(`Total token - ${formatTokenK(totalTokens)}${withCumGuard(totalTokens)}`);
    }
  }

  // 8. 本次 run 花费（USD）
  if (usage?.costUsd !== undefined) {
    lines.push(`Cost - $${usage.costUsd.toFixed(4)}`);
  }

  // 9. 推理 token（> 0 才显示，格式对齐既有 token 行）
  if (usage?.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
    lines.push(`Reasoning token - ${formatTokenK(usage.reasoningTokens)}`);
  }

  return lines.join('\n');
}
