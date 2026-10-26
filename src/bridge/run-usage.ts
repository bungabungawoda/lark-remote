import type { ResultEvent } from '../runner/types.js';
import { normalizeResultUsage } from '../runner/common/result-usage.js';
import type { FinalUsageSnapshot } from './final-usage.js';

export type UsageAuthority = 'live' | 'jsonl';

export class RunUsageCollector {
  private contextLength?: number;
  private finalContextLength?: number;
  private finalContextLimit?: number;
  private finalCompactCount?: number;
  private finalCacheReadTokens?: number;
  private finalCacheCreationTokens?: number;
  private finalTotalTokens?: number;
  private liveInput?: number;
  private liveOutput?: number;
  private liveContextLimit?: number;
  private finalInputTokens?: number;
  private finalOutputTokens?: number;
  private finalCumulativeTotalTokens?: number;
  private finalCumulativeInputTokens?: number;
  private finalCumulativeOutputTokens?: number;
  private finalCumulativeCacheReadTokens?: number;
  private finalCumulativeCacheCreationTokens?: number;
  private finalReasoningTokens?: number;
  resultNotSuccess = false;

  get liveInputTokens(): number | undefined {
    return this.liveInput;
  }

  get liveOutputTokens(): number | undefined {
    return this.liveOutput;
  }

  observeCompaction(postTokens: number): void {
    this.contextLength = postTokens;
  }

  observeResult(event: ResultEvent): void {
    this.resultNotSuccess = event.subtype !== 'success';
    if (!event.usage) return;

    const usage = normalizeResultUsage(event.usage);
    if (!this.contextLength) this.contextLength = usage.contextLength;
    this.liveInput = usage.inputTokens;
    this.liveOutput = usage.outputTokens;
    this.liveContextLimit = usage.contextLimit;
    if (usage.cacheReadTokens !== undefined) this.finalCacheReadTokens = usage.cacheReadTokens;
    if (usage.cacheCreationTokens !== undefined) {
      this.finalCacheCreationTokens = usage.cacheCreationTokens;
    }
    if (usage.totalTokens !== undefined) this.finalTotalTokens = usage.totalTokens;
    if (usage.reasoningTokens !== undefined) this.finalReasoningTokens = usage.reasoningTokens;
  }

  finalize(
    finalUsage: FinalUsageSnapshot | undefined,
    authority: UsageAuthority | undefined,
  ): void {
    this.finalContextLength = finalUsage?.contextLength ?? this.contextLength;
    this.finalContextLimit = finalUsage?.contextLimit ?? this.liveContextLimit;
    this.finalCompactCount = finalUsage?.compactCount;
    this.finalCumulativeTotalTokens = finalUsage?.cumulativeTotalTokens;
    this.finalCumulativeInputTokens = finalUsage?.cumulativeInputTokens;
    this.finalCumulativeOutputTokens = finalUsage?.cumulativeOutputTokens;
    this.finalCumulativeCacheReadTokens = finalUsage?.cumulativeCacheReadTokens;
    this.finalCumulativeCacheCreationTokens = finalUsage?.cumulativeCacheCreationTokens;

    const useLiveFlowScope =
      authority !== 'jsonl' && this.liveInput !== undefined && this.liveOutput !== undefined;
    if (useLiveFlowScope) {
      this.finalInputTokens = this.liveInput;
      this.finalOutputTokens = this.liveOutput;
      return;
    }

    this.finalInputTokens = finalUsage?.inputTokens ?? this.liveInput;
    this.finalOutputTokens = finalUsage?.outputTokens ?? this.liveOutput;
    this.finalCacheReadTokens = finalUsage?.cacheReadTokens ?? this.finalCacheReadTokens;
    this.finalCacheCreationTokens =
      finalUsage?.cacheCreationTokens ?? this.finalCacheCreationTokens;
    this.finalTotalTokens = finalUsage?.totalTokens ?? this.finalTotalTokens;
  }

  meta(): {
    contextLength?: number;
    contextLimit?: number;
    compactCount?: number;
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
    reasoningTokens?: number;
  } {
    return {
      contextLength: this.finalContextLength,
      contextLimit: this.finalContextLimit,
      compactCount: this.finalCompactCount,
      cacheReadTokens: this.finalCacheReadTokens,
      cacheCreationTokens: this.finalCacheCreationTokens,
      totalTokens: this.finalTotalTokens,
      inputTokens: this.finalInputTokens,
      outputTokens: this.finalOutputTokens,
      cumulativeTotalTokens: this.finalCumulativeTotalTokens,
      cumulativeInputTokens: this.finalCumulativeInputTokens,
      cumulativeOutputTokens: this.finalCumulativeOutputTokens,
      cumulativeCacheReadTokens: this.finalCumulativeCacheReadTokens,
      cumulativeCacheCreationTokens: this.finalCumulativeCacheCreationTokens,
      reasoningTokens: this.finalReasoningTokens,
    };
  }

  logSummary(runId: string): string {
    const meta = this.meta();
    return `[lark-remote] final usage runId=${runId} contextLength=${meta.contextLength} contextLimit=${meta.contextLimit ?? 'undefined'} compactCount=${meta.compactCount ?? 'undefined'} cacheRead=${meta.cacheReadTokens ?? 'undefined'} cacheCreate=${meta.cacheCreationTokens ?? 'undefined'}`;
  }
}
