/**
 * Format session/run usage stats (context, compact count, tokens) into the
 * display strings shown on cards. Pure — no Router state.
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
 * - >= 999_500: M with at most one decimal (e.g., 999_600 → 1M, 1200000 → 1.2M,
 *   25000000 → 25M)
 * - >= 1K: rounded to nearest integer K (e.g., 1500 → 2K, 120000 → 120K)
 * - < 1K: as-is (e.g., 500 → "500")
 *
 * 千位边界取 M 档：999_500 起按 K 四舍五入会得到 "1000K"，直接按 M 档展示。
 * 此前 run-renderer 另有一份 formatTokens 只在这边带此边界护栏，两处已收敛
 * 到本函数（run-renderer 的状态行 `📊 N` 也走这里）。
 */
export function formatTokenK(n: number): string {
  if (n >= 999_500) {
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

interface UsageStatsInput extends UsageSnapshot {
  /** 实际生效模型（system.init 携带）。非空字符串才显示。 */
  model?: string;
}

interface UsageDisplayOptions {
  showResult?: boolean;
  result?: string;
  /**
   * 首行状态文案。默认 `✅ 已完成`；goal 仍 active 的收尾卡必须换掉它——
   * 本轮 turn 结束不等于任务结束。
   */
  completedLabel?: string;
}

interface CumulativeParts {
  input: string;
  output: string;
  cacheRead: string;
  cacheCreate: string;
}

function cumulativeField(value: number | undefined): string {
  return value !== undefined ? ` · 累计 ${formatTokenK(value)}` : '';
}

function cumulativeCachePercent(usage: UsageStatsInput | undefined): number | null {
  const cumInput = usage?.cumulativeInputTokens;
  const cumCacheRead = usage?.cumulativeCacheReadTokens;
  return cumInput !== undefined && cumCacheRead !== undefined && cumInput + cumCacheRead > 0
    ? Math.round((cumCacheRead / (cumInput + cumCacheRead)) * 100)
    : null;
}

function cumulativeParts(usage: UsageStatsInput | undefined): CumulativeParts {
  const cumCacheRead = usage?.cumulativeCacheReadTokens;
  const percent = cumulativeCachePercent(usage);
  const cacheRead =
    cumCacheRead !== undefined
      ? cumulativeField(cumCacheRead) + (percent !== null ? ` (${percent}%)` : '')
      : '';
  return {
    input: cumulativeField(usage?.cumulativeInputTokens),
    output: cumulativeField(usage?.cumulativeOutputTokens),
    cacheRead,
    cacheCreate: cumulativeField(usage?.cumulativeCacheCreationTokens),
  };
}

/**
 * 一致性护栏：本 run ≤ 累计 是硬不变量（累计 = 所有 run 之和，必 ≥ 本 run）。
 * 违反说明来源 scope 混用（如 DeepSeek live result usage 是累积/超大 scope，
 * 大于 jsonl 去重聚合的 session 累计）。只标记不修正——数字保持原样便于排查，
 * 由数据源修复。两侧都有值时校验（避免旧数据/缺失字段误报）。
 * 两个分支（real input/output / 10% 估计）共用，保证"本 run > 累计"在任意
 * 路径都显式暴露。
 */
function cumulativeTotalSuffix(usage: UsageStatsInput | undefined, totalTokens: number): string {
  const cum = usage?.cumulativeTotalTokens;
  if (cum === undefined) return '';
  const guard = totalTokens > cum ? ' · ⚠️ 累计异常' : '';
  return cumulativeField(cum) + guard;
}

function contextLine(length: number, usage: UsageStatsInput): string {
  const ctxLimit = usage.contextLimit;
  const ctxPercent =
    ctxLimit !== undefined && ctxLimit > 0 ? ` (${Math.round((length / ctxLimit) * 100)}%)` : '';
  const preCompact =
    usage.compactPreContextLength !== undefined
      ? `（压缩前 ${formatTokenK(usage.compactPreContextLength)}）`
      : '';
  return `Context - ${formatTokenK(length)}${ctxPercent}${preCompact}`;
}

function headerLines(
  usage: UsageStatsInput | undefined,
  options: UsageDisplayOptions | undefined,
): string[] {
  const lines: string[] = [];
  lines.push(options?.completedLabel ?? '✅ 已完成');
  if (usage?.model) lines.push(`Model - ${usage.model}`);
  if (options?.showResult && options?.result) {
    lines.push(`结果 - ${options.result}`);
  }
  if (usage?.contextLength !== undefined) lines.push(contextLine(usage.contextLength, usage));
  if (usage?.compactCount) lines.push(`Compact - ${usage.compactCount}次`);
  return lines;
}

/** 命中率分母由调用方给：real 分支是 input+cacheRead，estimate 分支是 totalInput。 */
function makeTokenLines(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  totalTokens: number,
  cachePercent: number,
  parts: CumulativeParts,
  usage: UsageStatsInput | undefined,
): string[] {
  const lines = [
    `Input token - ${formatTokenK(input)}${parts.input}`,
    `Output token - ${formatTokenK(output)}${parts.output}`,
  ];
  if (cacheCreation > 0) {
    lines.push(`Cache create - ${formatTokenK(cacheCreation)}${parts.cacheCreate}`);
  }
  lines.push(`Cached token - ${formatTokenK(cacheRead)} (${cachePercent}%)${parts.cacheRead}`);
  lines.push(
    `Total token - ${formatTokenK(totalTokens)}${cumulativeTotalSuffix(usage, totalTokens)}`,
  );
  return lines;
}

function realTokenLines(
  usage: UsageStatsInput,
  realInput: number,
  realOutput: number,
  parts: CumulativeParts,
): string[] {
  // Unified ccusage-aligned formula:
  //   total = max(total_tokens, input + output + cacheRead + cacheCreation)
  //   cache% = cacheRead / (input + cacheRead)
  // cacheRead/cacheCreation are never double-counted; total_tokens folds in any
  // extra (e.g. opencode reasoning, which is separate from output) via max().
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  const sumParts = realInput + realOutput + cacheRead + cacheCreation;
  const totalTokens = usage.totalTokens != null ? Math.max(usage.totalTokens, sumParts) : sumParts;
  const promptTokens = realInput + cacheRead;
  const cachePercent = promptTokens > 0 ? Math.round((cacheRead / promptTokens) * 100) : 0;
  return makeTokenLines(
    realInput,
    realOutput,
    cacheRead,
    cacheCreation,
    totalTokens,
    cachePercent,
    parts,
    usage,
  );
}

function estimateTokenLines(usage: UsageStatsInput | undefined, parts: CumulativeParts): string[] {
  // Estimate path: when real input/output are absent,
  // fall back to the 10% estimate based on contextLength.
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheCreation = usage?.cacheCreationTokens ?? 0;
  const inputRef = usage?.contextLength ?? cacheRead;
  if (inputRef <= 0 && cacheRead <= 0 && cacheCreation <= 0) return [];
  const totalInput = inputRef + cacheRead;
  const outputEst = inputRef > 0 ? Math.round(inputRef * 0.1) : 0;
  const cachePercent = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0;
  const totalTokens = totalInput + outputEst + cacheCreation;
  return makeTokenLines(
    totalInput,
    outputEst,
    cacheRead,
    cacheCreation,
    totalTokens,
    cachePercent,
    parts,
    usage,
  );
}

function tokenLines(usage: UsageStatsInput | undefined, parts: CumulativeParts): string[] {
  const realInput = usage?.inputTokens;
  const realOutput = usage?.outputTokens;
  if (realInput !== undefined && realOutput !== undefined) {
    return realTokenLines(usage as UsageStatsInput, realInput, realOutput, parts);
  }
  return estimateTokenLines(usage, parts);
}

/**
 * Format usage stats (context length, compact count, cache tokens) into a display string.
 * Each stat on its own line with blank lines between sections.
 * @param usage - Usage stats object
 * @param options - Optional display options (showResult adds result line)
 */
export function formatUsageStats(usage?: UsageStatsInput, options?: UsageDisplayOptions): string {
  const parts = cumulativeParts(usage);
  return [...headerLines(usage, options), ...tokenLines(usage, parts)].join('\n');
}
