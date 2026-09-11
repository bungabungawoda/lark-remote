import { expect } from 'vitest';

/**
 * Minimal structural view of a CardKit card for tests that inspect
 * body/header without pulling in the full card renderer types.
 *
 * Replaces `(card as any).body?.elements` patterns with a typed assertion.
 */
export interface CardElementView {
  tag?: string;
  elements?: CardElementView[];
  text?: { content?: string };
}

export interface CardView {
  body?: { elements?: CardElementView[] };
  header?: { title?: { content?: string } };
}

// ===========================================================================
// W3.8：200861 铁律断言单源化
// ===========================================================================

/** 200861 铁律正则的单源定义（测试直接断言正则时引用此处，勿再内联字面量）。 */
export const V1_ACTION_CONTAINER_PATTERN = /"tag"\s*:\s*"action"[^}]*"actions"/;

/**
 * CardKit 2.0 卡片断言：不得出现 CardKit 1.x 的 `tag:"action"` 容器（混用会
 * 触发飞书 200861 错误，整卡不可用）。任何新增/修改 CardKit 2.0 schema 卡片
 * 的测试必须调用本 helper（AGENTS.md 红线条款）。
 */
export function expectNoV1ActionContainer(card: unknown): void {
  const json = typeof card === 'string' ? card : JSON.stringify(card);
  expect(json, 'CardKit 1.x action container detected (Feishu 200861: 整卡不可用)').not.toMatch(
    V1_ACTION_CONTAINER_PATTERN,
  );
}
