/**
 * Pure-formatting unit tests extracted from router.test.ts (2026-08-29
 * cleanup): formatTimestamp / formatUsageStats have no router wiring.
 */
import { describe, it, expect } from 'vitest';
import { formatUsageStats } from './utils.js';
import { formatTimestamp } from '../card/time.js';

describe('formatTimestamp', () => {
  it('formats JSONL UTC timestamp in local time', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      expect(formatTimestamp('2026-06-20T15:30:01.000Z')).toBe('2026-06-20 23:30');
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });
});

describe('formatUsageStats', () => {
  it('test_anchor_format_usage_stats_context_percent_when_limit_present', () => {
    // 验证：contextLimit 存在时 Context 行追加百分比 "Context - X (Y%)"；
    // contextLimit 缺失（其他 agent / 旧数据 / 运行中）时不得渲染任何 "%"，
    // 保持现状只显示绝对量。
    // 缺失/错误会导致：有上限的 codex 会话无法在卡片上看到水位；无上限的
    // agent 被错误地塞进一个编造的百分比。
    // 依据：spec 摘要第 2、3 条；百分比 = contextLength / contextLimit * 100 四舍五入。
    const out = formatUsageStats({ contextLength: 5000, contextLimit: 200000 });
    expect(out).toContain('Context - 5K (3%)');

    const withoutLimit = formatUsageStats({ contextLength: 5000 });
    expect(withoutLimit).toContain('Context - 5K');
    // Cache 行本身会渲染 "Cached token - 0 (0%)"，因此只断言 Context 行不追加百分比。
    expect(withoutLimit).not.toContain('Context - 5K (');
  });

  it('renders context length + compact count when present', () => {
    const out = formatUsageStats({ contextLength: 5000, compactCount: 2 });
    expect(out).toContain('✅ 已完成');
    expect(out).toContain('Context - 5K');
    expect(out).toContain('Compact - 2次');
  });

  it('renders context length in K units (e.g., 120K instead of 120,000)', () => {
    const out = formatUsageStats({ contextLength: 120000, compactCount: 3 });
    expect(out).toContain('120K');
    expect(out).not.toContain('120,000');
  });

  it('renders Token stats in K units', () => {
    const out = formatUsageStats({
      contextLength: 150000,
      compactCount: 2,
      cacheReadTokens: 90000,
      cacheCreationTokens: 30000,
    });
    // Input = contextLength + cacheRead = 150K + 90K = 240K
    expect(out).toContain('Input token - 240K');
    // Output estimation = 10% of input = 15K
    expect(out).toContain('Output token - 15K');
    // Cache percentage: 90000 / (150000 + 90000) = 37.5% ≈ 38%
    expect(out).toContain('Cached token - 90K (38%)');
  });

  it('omits compact when compactCount is 0 or missing (regression: run/resume card footer)', () => {
    // compactCount=0 是 falsy — 不应渲染 "compact 0 次"。无 compact 的普通会话
    // 不能显示误导性的 "compact 0 次"。
    expect(formatUsageStats({ contextLength: 100, compactCount: 0 })).not.toContain('Compact');
    expect(formatUsageStats({ contextLength: 100 })).not.toContain('Compact');
  });

  it('omits context length and compact when usage is undefined', () => {
    expect(formatUsageStats(undefined)).toBe('✅ 已完成');
  });

  it('renders unified ccusage-aligned totals (pi/codex/opencode)', () => {
    // Unified formula (ccusage-aligned):
    //   total = max(total_tokens, input + output + cacheRead + cacheCreation)
    //   cache% = cacheRead / (input + cacheRead)
    //   "Cache create" line only when cacheCreation > 0
    // cacheRead/cacheCreation are NEVER double-counted; total_tokens folds in
    // any extra (e.g. opencode reasoning) via the max().

    // Pi (real shape): input uncached; totalTokens == sum of 4.
    const pi = formatUsageStats({
      inputTokens: 500,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheCreationTokens: 30,
      totalTokens: 650,
    });
    expect(pi).toContain('Input token - 500');
    expect(pi).toContain('Output token - 20');
    expect(pi).toContain('Cached token - 100 (17%)'); // 100/(500+100)=16.7%≈17%
    expect(pi).toContain('Cache create - 30');
    expect(pi).toContain('Total token - 650'); // not 620 (must include cacheCreation)

    // Codex (ccusage display): uncached input = raw - cached.
    const codex = formatUsageStats({
      inputTokens: 30,
      outputTokens: 8,
      cacheReadTokens: 90,
      cacheCreationTokens: 0,
      totalTokens: 128,
    });
    expect(codex).toContain('Input token - 30');
    expect(codex).toContain('Output token - 8');
    expect(codex).toContain('Cached token - 90 (75%)'); // 90/(30+90)
    expect(codex).not.toContain('Cache create');
    expect(codex).toContain('Total token - 128'); // max(128, 30+8+90)

    // OpenCode (real shape): totalTokens includes reasoning (separate from
    // output); the max() captures it so Total != bare sum of 4 (393, not 343).
    const oc = formatUsageStats({
      inputTokens: 240,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 100,
      totalTokens: 393,
    });
    expect(oc).toContain('Cache create - 100');
    expect(oc).toContain('Total token - 393'); // not 343 (must fold reasoning via totalTokens)
  });

  it('appends cumulative input/output when present', () => {
    const out = formatUsageStats({
      inputTokens: 677,
      outputTokens: 376,
      cacheReadTokens: 30182,
      cacheCreationTokens: 0,
      totalTokens: 31235,
      contextLength: 31235,
      cumulativeInputTokens: 46630,
      cumulativeOutputTokens: 3319,
    });
    // Per-turn lines unchanged.
    expect(out).toContain('Input token - 677');
    expect(out).toContain('Output token - 376');
    // Cumulative appended on the input/output lines.
    expect(out).toContain('累计 47K'); // 46630 rounds to 47K
    expect(out).toContain('累计 3K');
    // Cache/Total lines must NOT carry a cumulative suffix.
    expect(out).not.toMatch(/Cached token.*累计/);
    expect(out).not.toMatch(/Total token.*累计/);
  });

  it('supports optional result line when showResult is true', () => {
    const out = formatUsageStats({ contextLength: 5000 }, { showResult: true, result: 'error' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('✅ 已完成');
    expect(lines[1]).toBe('结果 - error');
    // No result line when showResult is false or undefined.
    expect(formatUsageStats({ contextLength: 5000 })).not.toContain('结果 -');
  });

  it('uses real input/output tokens when provided (no 10% estimate)', () => {
    // Codex regression: real output_tokens=101 must render, not the 10%
    // estimate of contextLength (15107 → 1511 → "2K"); real input renders
    // as-is, not contextLength+cacheRead (which double-counts for codex).
    const out = formatUsageStats({
      contextLength: 15107,
      inputTokens: 15006,
      outputTokens: 101,
      cacheReadTokens: 6400,
    });
    expect(out).toContain('Output token - 101');
    expect(out).not.toMatch(/Output token - \d+K/);
    expect(out).toContain('Input token - 15K');
  });

  it('falls back to 10% output estimate when outputTokens absent', () => {
    const out = formatUsageStats({ contextLength: 120000, compactCount: 2 });
    expect(out).toContain('Output token - 12K');
  });

  it('formats tokens >= 1M with M unit (e.g., 1200000 → 1.2M, not 1200K)', () => {
    // Context length over 1M
    const out = formatUsageStats({
      contextLength: 1200000,
      inputTokens: 800000,
      outputTokens: 400000,
      cacheReadTokens: 600000,
      cacheCreationTokens: 200000,
      totalTokens: 2000000,
      cumulativeTotalTokens: 25000000,
      cumulativeInputTokens: 10000000,
      cumulativeOutputTokens: 5000000,
    });
    expect(out).toContain('Context - 1.2M');
    expect(out).toContain('Input token - 800K');
    expect(out).toContain('Output token - 400K');
    expect(out).toContain('Cached token - 600K');
    expect(out).toContain('Cache create - 200K');
    expect(out).toContain('Total token - 2M');
    // Cumulative over 1M uses M unit
    expect(out).toContain('累计 25M'); // 25000000 → 25M
    expect(out).toContain('累计 10M'); // 10000000 → 10M
    expect(out).toContain('累计 5M'); // 5000000 → 5M
    // Must NOT render as "1200K" or "25000K"
    expect(out).not.toContain('1200K');
    expect(out).not.toContain('25000K');
  });

  it('formats exactly 1M as 1M (not 1000K)', () => {
    const out = formatUsageStats({
      contextLength: 1000000,
    });
    expect(out).toContain('Context - 1M');
    expect(out).not.toContain('1000K');
  });

  it('preserves one decimal for M when not a whole number (e.g., 1500000 → 1.5M)', () => {
    const out = formatUsageStats({
      contextLength: 1500000,
      inputTokens: 1500000,
      outputTokens: 1500000,
      cacheReadTokens: 1500000,
      totalTokens: 4500000,
      cumulativeTotalTokens: 12345678,
    });
    expect(out).toContain('Context - 1.5M');
    expect(out).toContain('Input token - 1.5M');
    expect(out).toContain('Output token - 1.5M');
    expect(out).toContain('Cached token - 1.5M');
    expect(out).toContain('Total token - 4.5M');
    expect(out).toContain('累计 12.3M'); // 12345678 → 12.3M
  });

  it('一致性护栏：本 run > 累计 时 Total 行追加 ⚠️ 累计异常', () => {
    // 回归：会话完成卡"本 run 23.1M > 累计 663K"——DeepSeek live
    // result usage 是累积/超大 scope，大于 jsonl 去重聚合的 session 累计。
    // 护栏只标记不修正（数字保持原样便于排查），Total 行追加告警。
    const out = formatUsageStats({
      contextLength: 15926,
      inputTokens: 796000,
      outputTokens: 128000,
      cacheReadTokens: 22191744,
      totalTokens: 23115744,
      cumulativeTotalTokens: 663195,
    });
    expect(out).toContain('Total token - 23.1M · 累计 663K · ⚠️ 累计异常');
  });

  it('一致性护栏：本 run ≤ 累计 时不加告警', () => {
    const out = formatUsageStats({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      totalTokens: 1850,
      cumulativeTotalTokens: 50000,
    });
    expect(out).toContain('Total token - 2K · 累计 50K');
    expect(out).not.toContain('⚠️ 累计异常');
  });

  it('一致性护栏：累计缺失（如旧数据/error 路径）不加告警', () => {
    const out = formatUsageStats({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      totalTokens: 1850,
    });
    expect(out).toContain('Total token - 2K');
    expect(out).not.toContain('⚠️ 累计异常');
  });

  it('一致性护栏：estimate 路径（无 real input/output）同样暴露异常', () => {
    // 10% 估计路径：total = (contextLength + cacheRead) + 10% + cacheCreation。
    // 无 real input/output，同样可能本 run > 累计（如 jsonl 兜底时 contextLength
    // 是末轮窗口而累计更小）——护栏需在两个分支都生效。
    const out = formatUsageStats({
      contextLength: 1000,
      cacheReadTokens: 900,
      totalTokens: 2000,
      cumulativeTotalTokens: 1500,
    });
    // 估计 total = 1000 + 900 + 100 = 2000 → 2K；2000 > 1500 → 告警
    expect(out).toContain('Total token - 2K · 累计 2K · ⚠️ 累计异常');
    // 正常：估计 total ≤ 累计 → 无告警
    const ok = formatUsageStats({
      contextLength: 1000,
      cacheReadTokens: 900,
      cumulativeTotalTokens: 5000,
    });
    expect(ok).toContain('Total token - 2K · 累计 5K');
    expect(ok).not.toContain('⚠️ 累计异常');
  });
});
