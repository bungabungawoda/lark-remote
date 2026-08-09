/**
 * Anchor tests for cumulative cache display feature
 *
 * Spec: Run 卡片和 Resume 卡片的 token 统计中，Cached token 和 Cache create 行需要显示累计值。
 * - Cached token 累计需要显示命中率百分比
 * - Cache create 累计不需要百分比
 *
 * AC1: Cached token 行显示 "· 累计 XK (Y%)" 其中 Y 是累计命中率
 * AC2: Cache create 行显示 "· 累计 XK"（不需要 %）
 * AC3: 接口支持 cumulativeCacheReadTokens
 * AC4: 接口支持 cumulativeCacheCreationTokens
 */

import { describe, it, expect } from 'vitest';
import { formatUsageStats } from '../../../src/router/utils.js';

describe('formatUsageStats - cumulative cache display', () => {
  /**
   * AC1: Cached token 行显示累计 token 数和命中率百分比
   * 公式: 累计 cache% = 累计 cacheRead / (累计 input + 累计 cacheRead)
   */
  it('test_anchor_cached_token_cumulative_with_percentage', () => {
    const out = formatUsageStats({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 2000,
      cacheCreationTokens: 500,
      totalTokens: 3600,
      // 累计值：input=5000, cacheRead=10000
      // 命中率 = 10000 / (5000 + 10000) = 66.67% ≈ 67%
      cumulativeInputTokens: 5000,
      cumulativeOutputTokens: 800,
      cumulativeCacheReadTokens: 10000,
      cumulativeCacheCreationTokens: 2500,
    });

    // 本 run: 2000/(1000+2000) = 66.67% ≈ 67%
    expect(out).toContain('Cached token - 2K (67%)');

    // 累计: 10000/(5000+10000) = 66.67% ≈ 67%
    // token 数已格式化为 K 单位: 10000 -> 10K
    expect(out).toContain('累计 10K (67%)');
  });

  /**
   * AC2: Cache create 行显示累计 token 数，不需要百分比
   */
  it('test_anchor_cache_create_cumulative_without_percentage', () => {
    const out = formatUsageStats({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 2000,
      cacheCreationTokens: 500,
      totalTokens: 3600,
      cumulativeInputTokens: 5000,
      cumulativeOutputTokens: 800,
      cumulativeCacheReadTokens: 10000,
      cumulativeCacheCreationTokens: 2500,
    });

    // Cache create 累计不带 %，2500 -> 3K (round up)
    expect(out).toContain('Cache create - 500 · 累计 3K');
  });

  /**
   * AC3: 接口支持 cumulativeCacheReadTokens（无累计时不应 crash）
   */
  it('test_anchor_cumulative_cache_read_tokens_optional', () => {
    // 只有 cumulativeCacheReadTokens，没有 cumulativeInputTokens 时
    // 不显示 %，只显示 token 数
    const out = formatUsageStats({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 2000,
      cacheCreationTokens: 0,
      totalTokens: 3100,
      cumulativeCacheReadTokens: 5000,
    });

    // 应该显示累计值但不显示 %（因为缺少 cumulativeInputTokens）
    // 5000 -> 5K
    expect(out).toContain('累计 5K');
    expect(out).not.toMatch(/累计 \d+K \(\d+%\)/); // 不应有百分比的格式
  });

  /**
   * AC4: 接口支持 cumulativeCacheCreationTokens（无累计时不应 crash）
   */
  it('test_anchor_cumulative_cache_creation_tokens_optional', () => {
    const out = formatUsageStats({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 500,
      totalTokens: 1600,
      cumulativeCacheCreationTokens: 3000,
    });

    // Cache create 累计不带 %, 3000 -> 3K
    expect(out).toContain('Cache create - 500 · 累计 3K');
  });

  /**
   * Edge case: cache read 为 0 时累计也应为 0% 或不显示百分比
   */
  it('test_anchor_cached_token_zero_cache_read_cumulative', () => {
    const out = formatUsageStats({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 1100,
      cumulativeInputTokens: 5000,
      cumulativeOutputTokens: 800,
      cumulativeCacheReadTokens: 0,
    });

    // 本 run cache 为 0，不显示 %
    expect(out).toContain('Cached token - 0 (0%)');
    // 累计 cache 为 0 时，显示 0 (0%)
    expect(out).toContain('累计 0 (0%)');
  });

  /**
   * Integration: 完整验证用户对账场景
   * Total 累计 ≈ Input 累计 + Output 累计 + Cache 累计 + CacheCreate 累计
   */
  it('test_anchor_total_cumulative_reconcilable', () => {
    const out = formatUsageStats({
      inputTokens: 171000,
      outputTokens: 84,
      cacheReadTokens: 0,
      cacheCreationTokens: 100, // 需要非0才会显示 Cache create 行
      totalTokens: 171100,
      cumulativeInputTokens: 7350000,
      cumulativeOutputTokens: 44000,
      cumulativeTotalTokens: 24218000, // 累计 total
      cumulativeCacheReadTokens: 15000000,
      cumulativeCacheCreationTokens: 1824000,
    });

    // 验证各行显示（token 数已格式化为 K 单位）
    expect(out).toContain('Input token - 171K · 累计 7350K'); // 7350000/1000=7350K
    expect(out).toContain('Output token - 84 · 累计 44K'); // 44000/1000=44K
    expect(out).toContain('Cached token - 0 (0%) · 累计 15000K (67%)'); // 15000000/1000=15000K
    expect(out).toContain('Cache create - 100 · 累计 1824K'); // 1824000/1000=1824K
    expect(out).toContain('Total token - 171K · 累计 24218K'); // 7350+44+15000+1824=24218K

    // 验证 Total = Input + Output + CacheRead + CacheCreate
    // 7350K + 44K + 15000K + 1824K = 24218K ✓
    expect(out).toContain('累计 24218K');
  });
});
