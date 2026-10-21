/**
 * `/resume` 列表内容契约：预取上限、占位符 summary 不渲染、单会话路径不受分页影响。
 *
 * 合并自 resume-prefetch-limit / resume-placeholder-summary /
 * resume-single-session-unaffected，共用 buildResumeHarness。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { flattenElements, findDivWithText } from '../../lib/card-tree.js';
import type { Card } from '../../lib/card-tree.js';
import { buildResumeHarness, countResumeButtons } from '../../lib/resume-fixture.js';

// Collect every string leaf in the parsed card object so real newlines in
// lark_md content are compared as characters (JSON.stringify would escape them).
function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      collectStrings((value as Record<string, unknown>)[key], acc);
    }
  }
  return acc;
}

function bodyWithDisplay(i: number): string {
  const tag = String(i).padStart(2, '0');
  return [
    `{"type":"user","message":{"role":"user","content":"summary-unique-${tag}"}}`,
    `{"type":"user","message":{"role":"user","content":"display-unique-${tag}"}}`,
  ].join('\n');
}

describe('/resume list contents', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-list-anchor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_list_prefetch_capped_and_rows_rendered', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25, {
      bodyFor: bodyWithDisplay,
    });
    const reader = h.registry.get('claude');
    const spy = vi.spyOn(reader, 'readSessionContent');
    try {
      await h.router.handle('/resume', h.ctx);

      // 1. Prefetch is capped: at most 5 full readSessionContent calls
      //    (one per listed session on a 5-row page).
      expect(spy.mock.calls.length).toBeLessThanOrEqual(5);

      // 2. Page-size semantics: 5 resume.use buttons (page size 5).
      expect(countResumeButtons(h.cardOf(0))).toBe(5);

      // 3. All rows have title content: at least 5 distinct displayTitle texts.
      const cardJson = JSON.stringify(h.cardOf(0));
      const displayTokens = Array.from({ length: 5 }, (_, i) => {
        return `display-unique-${String(24 - i).padStart(2, '0')}`;
      });
      const present = displayTokens.filter((t) => cardJson.includes(t));
      expect(present.length).toBeGreaterThanOrEqual(5);
    } finally {
      spy.mockRestore();
    }
  });

  it('test_anchor_resume_placeholder_summary_not_rendered_as_recent_input', async () => {
    // Sessions 05/06/07 have NO user message → summary falls back to '(无摘要)'.
    // They sit at rows 18-20 → page 4 (offset 15).
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25, {
      bodyFor: (i) => {
        if (i >= 5 && i <= 7) {
          const sid = `session-${String(i).padStart(2, '0')}`;
          return `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello from ${sid}"}]}}`;
        }
        return bodyWithDisplay(i);
      },
    });

    // 首页：5 个按钮，不含占位符文案（page 1 = sessions 24..20 全正常）。
    await h.router.handle('/resume', h.ctx);
    const card1 = h.cardOf(0);
    const strings1 = collectStrings(card1);
    expect(strings1.some((s) => s.includes('(无摘要)'))).toBe(false);
    expect(countResumeButtons(card1)).toBe(5);

    // 翻到第 4 页（offset=15，sessions 09..05，含 3 个占位符 session）。
    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 15, pageSize: 5 },
      h.ctx,
    );
    const card4 = h.connector._updates[0].card;
    const strings4 = collectStrings(card4);

    // 1. Placeholder must never appear anywhere on the card.
    expect(strings4.some((s) => s.includes('(无摘要)'))).toBe(false);

    // 2. Placeholder must never appear under the "最近输入" label.
    expect(strings4.some((s) => s.includes('🏷️ **最近输入**\n(无摘要)'))).toBe(false);

    // 3. Page-size semantics: 5 resume.use buttons per page.
    expect(countResumeButtons(card4)).toBe(5);

    // 4. Normal rows still render their title (displayTitle) — no empty rows.
    const displayTokens = ['display-unique-09', 'display-unique-08'];
    const present = displayTokens.filter((t) => strings4.some((s) => s.includes(t)));
    expect(present).toEqual(displayTokens);
  });

  it('test_anchor_resume_session_id_path_unaffected', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    const targetSessionId = 'session-24';
    await h.router.handle(`/resume ${targetSessionId}`, h.ctx);

    expect(h.connector._sent.length).toBeGreaterThanOrEqual(1);
    const card = (h.connector._sent[0].input as { card: Card }).card;
    const cardJson = JSON.stringify(card);

    // ① 卡片 body 有会话 header（含该 sessionId）
    expect(findDivWithText(flattenElements(card), `会话: **${targetSessionId}**`)).toBeDefined();
    expect(cardJson).toContain(targetSessionId);

    // ② sessionStore 中 user1 的（默认 claude）sessionId 被设为该 id
    expect(h.sessionStore.getSessionId('user1')).toBe(targetSessionId);

    // ③ 单会话卡片不含分页栏文案（`第 1/` 前缀）——分页只属于列表页
    expect(cardJson).not.toContain('第 1/');
  });
});
