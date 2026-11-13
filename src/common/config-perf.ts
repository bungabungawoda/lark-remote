/**
 * /config 卡片与模型目录的可观测性埋点（单行 key=value，便于 grep/awk 统计）。
 *
 * 为什么单独收口：三处优化（回调响应体直出、目录 SWR、/c 打开去阻塞）都以
 * 「耗时」为验收指标，日志必须能直接算出 p50/p95，而不是靠人读散文。所有事件
 * 共用 `[perf][config]` 前缀 + `event=<name>`，字段一律 `t_*_ms`（毫秒整数）。
 *
 * 关键可验证字段：
 * - `event=callback` 的 `t_total_ms`：从**收到事件**到回包的总耗时（含
 *   `t_flush_ms` 与 `t_router_ms`，即飞书 3 秒预算真正约束的数字）。
 * - `event=apply` 的 `patches_in_callback=0`：回调链内没有网络写（刀 1）。
 * - `event=catalog` 的 `sync_spawn`：只允许在 `hit=cold`（冷启动唯一的一次同步
 *   加载）为 true；其它 hit 值出现 true 即刀 2 回归。
 * - `event=render` 的 `merged`：连点被合并的渲染次数（刀 1）。
 * - `event=open` 的 `prefetch_deferred`：/c 是否等满了目录预取（刀 3）。
 * - `event=flush`：仅会话变更动作（钉单列，不进 callback 重复计数）。
 */
import { getLogger } from '../logger/index.js';

export type ConfigPerfEvent = 'callback' | 'apply' | 'render' | 'catalog' | 'open' | 'flush';

export type ConfigPerfField = string | number | boolean | undefined;

/** 一律 INFO：默认日志级别就能采到，不需要额外开关才能验证优化效果。 */
export function logConfigPerf(
  event: ConfigPerfEvent,
  fields: Record<string, ConfigPerfField>,
): void {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${value}`);
  }
  getLogger().info(`[perf][config] event=${event} ${parts.join(' ')}`);
}

/** 分段计时：segment() 记相邻两段之间的耗时，fields() 附总耗时。 */
export class ConfigPerfSpan {
  private readonly startedAt = Date.now();
  private lastAt = this.startedAt;
  private readonly segments: Record<string, number> = {};

  segment(name: string): void {
    const now = Date.now();
    this.segments[`t_${name}_ms`] = now - this.lastAt;
    this.lastAt = now;
  }

  totalMs(): number {
    return Date.now() - this.startedAt;
  }

  fields(): Record<string, number> {
    return { ...this.segments, t_total_ms: this.totalMs() };
  }
}
