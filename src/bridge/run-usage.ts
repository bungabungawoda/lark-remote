import type { ResultEvent } from '../runner/types.js';
import { normalizeResultUsage } from '../runner/common/result-usage.js';
import type { FinalUsageSnapshot } from './final-usage.js';
import type { UsageSnapshot } from '../session-contract.js';

export type UsageAuthority = 'live' | 'jsonl';

/**
 * 一张 run 的用量记账：live 侧（result 事件 / compact_boundary）先收着，
 * run 结束时与 jsonl 快照按权威来源合成一份 `UsageSnapshot`。
 *
 * live 侧字段清单只有 `UsageSnapshot` 一份：此前这里是 19 个 `final*` 平铺
 * 字段逐字段搬运，加一个 usage 字段要改三处（§9.21 的一致性靠人记）。
 */
export class RunUsageCollector {
  /** live 侧观察值（jsonl 读不到时的兜底）。 */
  private contextLength?: number;
  private liveInput?: number;
  private liveOutput?: number;
  private liveContextLimit?: number;
  private liveCacheRead?: number;
  private liveCacheCreation?: number;
  private liveTotal?: number;
  private liveReasoningTokens?: number;
  /** finalize() 之后的最终口径；meta() 的唯一数据源。 */
  private resolved: UsageSnapshot = {};
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
    if (usage.cacheReadTokens !== undefined) this.liveCacheRead = usage.cacheReadTokens;
    if (usage.cacheCreationTokens !== undefined) {
      this.liveCacheCreation = usage.cacheCreationTokens;
    }
    if (usage.totalTokens !== undefined) this.liveTotal = usage.totalTokens;
    if (usage.reasoningTokens !== undefined) this.liveReasoningTokens = usage.reasoningTokens;
  }

  finalize(
    finalUsage: FinalUsageSnapshot | undefined,
    authority: UsageAuthority | undefined,
  ): void {
    const resolved: UsageSnapshot = {
      // 从 jsonl 快照整体展开，新增 UsageSnapshot 字段无需再改这里。
      ...finalUsage,
      contextLength: finalUsage?.contextLength ?? this.contextLength,
      contextLimit: finalUsage?.contextLimit ?? this.liveContextLimit,
      compactCount: finalUsage?.compactCount,
      // result 事件里的 cache/total 两条路径都要带：jsonl 读得到时被覆盖，
      // 读不到（或走 live flow scope）时它就是最终数字。
      cacheReadTokens: this.liveCacheRead,
      cacheCreationTokens: this.liveCacheCreation,
      totalTokens: this.liveTotal,
      reasoningTokens: this.liveReasoningTokens,
    };

    const useLiveFlowScope =
      authority !== 'jsonl' && this.liveInput !== undefined && this.liveOutput !== undefined;
    if (useLiveFlowScope) {
      resolved.inputTokens = this.liveInput;
      resolved.outputTokens = this.liveOutput;
      this.resolved = resolved;
      return;
    }

    resolved.inputTokens = finalUsage?.inputTokens ?? this.liveInput;
    resolved.outputTokens = finalUsage?.outputTokens ?? this.liveOutput;
    resolved.cacheReadTokens = finalUsage?.cacheReadTokens ?? this.liveCacheRead;
    resolved.cacheCreationTokens = finalUsage?.cacheCreationTokens ?? this.liveCacheCreation;
    resolved.totalTokens = finalUsage?.totalTokens ?? this.liveTotal;
    this.resolved = resolved;
  }

  meta(): UsageSnapshot {
    return this.resolved;
  }

  logSummary(runId: string): string {
    const meta = this.meta();
    return `[lark-remote] final usage runId=${runId} contextLength=${meta.contextLength} contextLimit=${meta.contextLimit ?? 'undefined'} compactCount=${meta.compactCount ?? 'undefined'} cacheRead=${meta.cacheReadTokens ?? 'undefined'} cacheCreate=${meta.cacheCreationTokens ?? 'undefined'}`;
  }
}
