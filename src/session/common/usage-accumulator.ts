/**
 * Token usage accumulator for session readers.
 *
 * Aggregates per-turn token component records into cumulative totals
 * and exposes the last record for "current turn" semantics.
 * All public getters return deep copies to prevent accidental mutation.
 */

/** Components of a single usage record. Optional fields default to 0. */
interface TokenComponents {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning?: number;
  /** Agent-declared total; when absent, total is the sum of the four required fields. */
  total?: number;
}

function emptyTotals(): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
  total: number;
} {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 0 };
}

function cloneTotals(t: {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
  total: number;
}): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
  total: number;
} {
  return {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheCreation: t.cacheCreation,
    reasoning: t.reasoning,
    total: t.total,
  };
}

export class UsageAccumulator {
  private readonly _totals = emptyTotals();
  private _count = 0;
  private _last: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    reasoning: number;
    total: number;
  } | null = null;
  private _compactCount = 0;

  /** Number of records added. */
  get count(): number {
    return this._count;
  }

  /** Number of compact/compaction events observed. */
  get compactCount(): number {
    return this._compactCount;
  }

  /** Cumulative totals across all added records (deep copy). */
  get totals(): {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    reasoning: number;
    total: number;
  } {
    return cloneTotals(this._totals);
  }

  /** Last added record (deep copy), or null if none. */
  get last(): {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    reasoning: number;
    total: number;
  } | null {
    return this._last ? cloneTotals(this._last) : null;
  }

  /**
   * Add a usage record. Optional fields default to 0.
   * The `total` field is **not** summed — the caller decides how to
   * derive it (cumulative sum of parts vs. last-declared vs. max).
   * Here we simply store the per-record total (overwriting previous).
   */
  add(record: TokenComponents): void {
    const input = record.input;
    const output = record.output;
    const cacheRead = record.cacheRead;
    const cacheCreation = record.cacheCreation;
    const reasoning = record.reasoning ?? 0;
    const total = record.total ?? 0;

    this._totals.input += input;
    this._totals.output += output;
    this._totals.cacheRead += cacheRead;
    this._totals.cacheCreation += cacheCreation;
    this._totals.reasoning += reasoning;
    this._totals.total += total;

    this._last = { input, output, cacheRead, cacheCreation, reasoning, total };
    this._count++;
  }

  /**
   * Record a compact/compaction event.
   * Call once per compact_boundary / compaction line encountered.
   */
  bumpCompact(): void {
    this._compactCount++;
  }
}

/** P2-8 统一契约：上下文窗口占用 = 末轮 input + cacheRead + cacheCreation（不含 output/reasoning）。 */
export function contextWindowOccupancy(l: {
  input: number;
  cacheRead: number;
  cacheCreation: number;
}): number {
  return l.input + l.cacheRead + l.cacheCreation;
}

/** P2-8 统一契约：session 全量累计字段组装（4 个 reader 共用：claude/dsh/kimi/pi；
 * codex 走 last_token_usage 口径、opencode 保留自己的条件赋值，原为逐字段复制的 4 连拷贝）。 */
export function cumulativeUsageFields(t: {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}): Pick<
  import('../../runner/types.js').AgentSessionUsage,
  | 'cumulativeTotalTokens'
  | 'cumulativeInputTokens'
  | 'cumulativeOutputTokens'
  | 'cumulativeCacheReadTokens'
  | 'cumulativeCacheCreationTokens'
> {
  return {
    cumulativeTotalTokens: t.input + t.output + t.cacheRead + t.cacheCreation,
    cumulativeInputTokens: t.input,
    cumulativeOutputTokens: t.output,
    cumulativeCacheReadTokens: t.cacheRead,
    cumulativeCacheCreationTokens: t.cacheCreation,
  };
}
