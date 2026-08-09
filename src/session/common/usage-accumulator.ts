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
