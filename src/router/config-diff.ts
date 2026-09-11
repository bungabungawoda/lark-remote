/**
 * Config diff / nested-value helpers extracted from CommandRouter
 * (2026-09 round-2 simplification). Pure functions — no router state —
 * previously inlined as methods (collectDiff recursed only into itself).
 */
import { mapAgentKey, walkNestedContainer, assertSafeKeyPart } from '../config/index.js';
import type { AppConfig } from '../config/index.js';

/** 对比原始 config 与 pendingConfig，返回变化的 key→string 映射 */
export function diffConfig(
  original: AppConfig,
  pending: AppConfig,
): Record<string, string | undefined> {
  const updates: Record<string, string | undefined> = {};
  collectDiff('', original, pending, updates);
  return updates;
}

/** 递归收集差异 */
function collectDiff(
  prefix: string,
  original: unknown,
  pending: unknown,
  result: Record<string, string | undefined>,
): void {
  if (original === pending) return;
  // 如果 pending 是对象（非 null）但 original 不是对象，
  // 把 original 当作空对象递归进入 pending 内部，
  // 避免把整个对象转成 "[object Object]" 字符串
  if (
    typeof pending === 'object' &&
    pending !== null &&
    (typeof original !== 'object' || original === null)
  ) {
    const pendObj = pending as Record<string, unknown>;
    for (const k of Object.keys(pendObj)) {
      const newKey = prefix ? `${prefix}.${k}` : k;
      collectDiff(newKey, undefined, pendObj[k], result);
    }
    return;
  }
  if (
    typeof original !== 'object' ||
    typeof pending !== 'object' ||
    original === null ||
    pending === null
  ) {
    // 叶子节点，记录差异
    const key = prefix || 'root';
    // pending 为 undefined 表示键被删除，必须保留 undefined 语义，
    // 不能 String(pending) 成 "undefined"
    result[key] = pending === undefined ? undefined : String(pending);
    return;
  }
  // 两者都是对象，递归比较
  const origObj = original as Record<string, unknown>;
  const pendObj = pending as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(origObj), ...Object.keys(pendObj)]);
  for (const k of allKeys) {
    const newKey = prefix ? `${prefix}.${k}` : k;
    collectDiff(newKey, origObj[k], pendObj[k], result);
  }
}

export function setNestedValue(target: AppConfig, key: string, value: unknown): void {
  // Path mapping 共用 config 模块的 mapAgentKey（G11 Inconsistency 修复）：
  // pi.xxx/codex.xxx/opencode.xxx → agents.xxx，claude.xxx 保持顶层
  const mappedKey = mapAgentKey(key);
  const parts = mappedKey.split('.');
  // 复用 config 模块的 walkNestedContainer（含 __proto__/prototype/constructor
  // 守卫与中间段补 {}），router 只保留 value=undefined → delete 分支。
  const container = walkNestedContainer(target, parts, true);
  const lastPart = parts[parts.length - 1];
  assertSafeKeyPart(lastPart);
  if (value === undefined) {
    // value=undefined 表示"删除键"（如清空 reasoningEffort），
    // 不能写成 undefined 值——diffConfig 会把 undefined 转成字面量 "undefined"
    // 写入 config.yaml 并透传给 codex（ReasoningEffort::Custom("undefined")）。
    delete container![lastPart];
  } else {
    container![lastPart] = value;
  }
}
