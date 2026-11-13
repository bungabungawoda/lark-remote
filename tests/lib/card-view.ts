import { expect } from 'vitest';
import { unescapeMarkdown } from '../../src/card/collapsible.js';

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
// 200861 铁律断言单源化
// ===========================================================================

/** 200861 铁律正则的单源定义（测试直接断言正则时引用此处，勿再内联字面量）。 */
export const V1_ACTION_CONTAINER_PATTERN = /"tag"\s*:\s*"action"[^}]*"actions"/;

/**
 * CardKit 2.0 卡片断言：不得出现 CardKit 1.x 的 `tag:"action"` 容器（混用会
 * 触发飞书 200861 错误，整卡不可用）。任何新增/修改 CardKit 2.0 schema 卡片
 * 的测试必须调用本 helper。
 */
export function expectNoV1ActionContainer(card: unknown): void {
  const json = typeof card === 'string' ? card : JSON.stringify(card);
  expect(json, 'CardKit 1.x action container detected (Feishu 200861: 整卡不可用)').not.toMatch(
    V1_ACTION_CONTAINER_PATTERN,
  );
}

/**
 * 收集卡片里所有 callback 的 `value.cmd`（递归整棵 JSON 树，不假设容器形状）。
 *
 * 用途：断言「这到底是哪张卡」。回调 cmd 是各卡片独有的标识——卡片文案改一个
 * 字不该让测试红，但命令接错（`/h` 渲染出 `/config` 卡）必须红，这正是
 * `expect(card).toBeDefined()` 给不了的区分能力。
 */
export function collectCallbackCmds(card: unknown): string[] {
  const cmds: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const obj = v as Record<string, unknown>;
    const behaviors = obj['behaviors'];
    if (Array.isArray(behaviors)) {
      for (const behavior of behaviors) {
        const value = (behavior as { value?: unknown })?.value;
        if (!value || typeof value !== 'object') continue;
        const cmd = (value as Record<string, unknown>)['cmd'];
        if (typeof cmd === 'string') cmds.push(cmd);
      }
    }
    for (const inner of Object.values(obj)) visit(inner);
  };
  visit(card);
  return cmds;
}

/** 内容经 `markdownDiv` 做反斜杠转义的文本组件 tag。 */
const ESCAPED_MARKDOWN_TAGS = new Set(['lark_md']);

/** 所有文本组件 tag（header 标题、面板标题、div 文本）。 */
const TEXT_TAGS = new Set(['lark_md', 'plain_text', 'markdown']);

/**
 * 递归收集卡片里所有文本组件的内容（header 标题 + body 任意嵌套层级）。
 *
 * `lark_md` 内容由 `markdownDiv` 做反斜杠转义（`\` → `\\`），这里还原后再返回，
 * 让断言比对的是「用户看到的原文」。Windows 路径天然含 `\`，不还原时任何
 * `toContain(<路径>)` 断言都只在 ci-windows 假红——macOS/Linux 路径无反斜杠，
 * 永远绿。`plain_text`（header 标题、按钮文案）与 `markdown`（面板标题）未经
 * 转义，原样返回：对它们还原会吃掉合法的 `\\` 字面量。
 */
export function collectCardTexts(card: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const obj = v as Record<string, unknown>;
    const { tag, content } = obj;
    if (typeof tag === 'string' && TEXT_TAGS.has(tag) && typeof content === 'string') {
      out.push(ESCAPED_MARKDOWN_TAGS.has(tag) ? unescapeMarkdown(content) : content);
      return;
    }
    for (const inner of Object.values(obj)) visit(inner);
  };
  visit(card);
  return out;
}
