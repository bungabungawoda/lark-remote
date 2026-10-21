/**
 * `/resume` 列表分页：默认页大小、N 覆盖、offset 数值化/越界/负数、
 * 原地翻页与分页栏边界。
 *
 * 合并自 resume-pagination / resume-page-offset-normalize / resume-pagination-bar /
 * resume-page-turn / resume-pagination-boundary / resume-page-boundary 六个探针，
 * 共用 buildResumeHarness（真实 ClaudeSessionReader + 25 个 fixture session）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CARD_BUDGET_BYTES } from '../../../src/card/text-truncate.js';
import { flattenElements, findDivWithText } from '../../lib/card-tree.js';
import type { Card } from '../../lib/card-tree.js';
import { expectNoV1ActionContainer } from '../../lib/card-view.js';
import {
  buildResumeHarness,
  countResumeButtons,
  resumePageButtons,
  resumeUseButtons,
} from '../../lib/resume-fixture.js';

/** Virtual reader: total=99999 sessions, pages computed on the fly. */
function hugeVirtualReader(total: number) {
  return {
    listSessions: (_cwd: string, opts?: { limit?: number; offset?: number }) => {
      const offset = Math.max(0, opts?.offset ?? 0);
      const limit = opts?.limit ?? 20;
      const start = Math.min(offset, total);
      const end = Math.min(start + limit, total);
      const sessions = [];
      for (let i = start; i < end; i++) {
        sessions.push({
          sessionId: `huge-${String(i).padStart(6, '0')}`,
          summary: `s${i}`,
          mtime: 1_700_000_000_000 + i,
        });
      }
      return { sessions, total };
    },
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [] }),
    isSessionActive: () => false,
  };
}

describe('/resume pagination', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pagination-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 默认页大小 / N clamp ─────────────────────────────────────────────
  it('test_anchor_resume_default_page_size_5_and_n_clamp', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    // Default page size: /resume lists 5 sessions
    await h.router.handle('/resume', h.ctx);
    expect(countResumeButtons(h.cardOf(0))).toBe(5);

    // N=0 clamps up to 1: never an empty list
    await h.router.handle('/resume 0', h.ctx);
    expect(countResumeButtons(h.cardOf(1))).toBe(1);

    // N=25 clamps down to 5: page size never exceeds RESUME_PAGE_SIZE
    await h.router.handle('/resume 25', h.ctx);
    expect(countResumeButtons(h.cardOf(2))).toBe(5);
  });

  // ── offset 数值化 + 页对齐 ──────────────────────────────────────────
  it('test_anchor_resume_page_offset_normalized_and_page_aligned', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    // 1. String offset 'abc' must be treated as 0: no throw, card updated in
    //    place with the first page. NaN slice would produce an empty page and
    //    a text fallback instead of the card.
    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 'abc', pageSize: 5 } as never,
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    expect(JSON.stringify(h.connector._updates[0])).toContain('第 1/5 页 · 共 25 个会话');

    // 2. Numeric offset 25 (total=25, pageSize=5) aligns to the last page
    //    start 20: page label must be 第 5/5 页 (never 第 6/5 页 or misaligned).
    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 25, pageSize: 5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(2);
    expect(JSON.stringify(h.connector._updates[1])).toContain('第 5/5 页 · 共 25 个会话');
  });

  // ── 分页栏 + 真实总数 + 删假提示 ────────────────────────────────────
  it('test_anchor_resume_pagination_bar_shows_real_total', async () => {
    const d25 = path.join(tmpDir, 'd25');
    const d5 = path.join(tmpDir, 'd5');
    fs.mkdirSync(d25, { recursive: true });
    fs.mkdirSync(d5, { recursive: true });
    const h25 = buildResumeHarness(d25, path.join(d25, 'claude-projects'), 25);

    // 25 sessions / default pageSize 5 → 5 pages, real total 25
    await h25.router.handle('/resume', h25.ctx);
    const card1 = h25.cardOf(0);
    const els1 = flattenElements(card1);
    expect(findDivWithText(els1, '第 1/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumePageButtons(els1).map((b) => b.behaviors![0].value)).toEqual([
      { cmd: 'resume.page', agent: 'claude', offset: 5, pageSize: 5 },
    ]);
    expect(resumePageButtons(els1).some((b) => b.behaviors![0].value?.offset === 0)).toBe(false);
    expectNoV1ActionContainer(card1);
    expect(JSON.stringify(card1)).not.toContain('输入 /resume');

    // /resume 3 → page size override 3: 9 pages, next offset=3
    await h25.router.handle('/resume 3', h25.ctx);
    const card2 = h25.cardOf(1);
    const els2 = flattenElements(card2);
    expect(findDivWithText(els2, '第 1/9 页 · 共 25 个会话')).toBeDefined();
    expect(resumePageButtons(els2).map((b) => b.behaviors![0].value)).toEqual([
      { cmd: 'resume.page', agent: 'claude', offset: 3, pageSize: 3 },
    ]);

    // 5 sessions <= pageSize 5 → no pagination bar at all
    const h5 = buildResumeHarness(d5, path.join(d5, 'claude-projects'), 5);
    await h5.router.handle('/resume', h5.ctx);
    const els3 = flattenElements(h5.cardOf(0));
    expect(resumePageButtons(els3)).toHaveLength(0);
  });

  // ── 原地翻页 + clamp + 缺 agent 兜底 + 无 cwd ────────────────────────
  it('test_anchor_resume_page_turns_page_in_place_with_clamp', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    // 1. /resume → home page with pagination bar (5 per page)
    await h.router.handle('/resume', h.ctx);
    const homeEls = flattenElements(h.cardOf(0));
    expect(findDivWithText(homeEls, '第 1/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(homeEls)).toHaveLength(5);

    // 2. Click 下一页 (offset 5): updateCardInPlace, same message bubble
    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 5, pageSize: 5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    const page2Els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(page2Els, '第 2/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(page2Els).map((b) => b.behaviors![0].value?.sessionId ?? '')).toEqual([
      'session-19',
      'session-18',
      'session-17',
      'session-16',
      'session-15',
    ]);
    const page2Buttons = resumePageButtons(page2Els);
    expect(page2Buttons).toHaveLength(2);
    expect(page2Buttons.map((b) => b.behaviors![0].value)).toEqual([
      { cmd: 'resume.page', agent: 'claude', offset: 0, pageSize: 5 },
      { cmd: 'resume.page', agent: 'claude', offset: 10, pageSize: 5 },
    ]);

    // 3. Out-of-range offset (1000) clamps to the last page (offset 20)
    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 1000, pageSize: 5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(2);
    const clampedEls = flattenElements(h.connector._updates[1].card as Card);
    expect(findDivWithText(clampedEls, '第 5/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(clampedEls).map((b) => b.behaviors![0].value?.sessionId ?? '')).toEqual(
      ['session-04', 'session-03', 'session-02', 'session-01', 'session-00'],
    );

    // 4. Missing agent field → defaultAgent ('claude') fallback, flips back to page 1
    await h.router.handleCardAction({ cmd: 'resume.page', offset: 0, pageSize: 5 }, h.ctx);
    expect(h.connector._updates).toHaveLength(3);
    const homeAgainEls = flattenElements(h.connector._updates[2].card as Card);
    expect(findDivWithText(homeAgainEls, '第 1/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(homeAgainEls)).toHaveLength(5);

    // 5. No cwd → error toast or text aligned with resume.use, no throw
    h.sessionStore.delete('user1');
    const sentBefore = h.connector._sent.length;
    const resp = await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 0, pageSize: 5 },
      h.ctx,
    );
    const toastText = (resp as { toast?: { content?: string } } | undefined)?.toast?.content ?? '';
    const sentTexts = h.connector._sent
      .slice(sentBefore)
      .map((s) => (s.input as { text?: string }).text ?? '')
      .join('\n');
    expect(`${toastText}\n${sentTexts}`).toContain('请先 /cd 设置工作目录');
  });

  // ── 边界：负 offset / 非默认 agent / 缺 agent / N 覆盖 ──────────────
  it('test_anchor_resume_page_negative_offset_clamps_to_first_page', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: -20, pageSize: 5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(els, '第 1/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(els)).toHaveLength(5);
  });

  it('test_anchor_resume_page_non_default_agent_no_sessions_returns_error_toast', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    const sentBefore = h.connector._sent.length;
    const resp = await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'pi', offset: 0, pageSize: 5 },
      h.ctx,
    );
    expect(resp?.toast?.type).toBe('error');
    expect(resp?.toast?.content).toBe('当前目录没有 Pi 的 session 记录');
    expect(h.connector._sent).toHaveLength(sentBefore);
    expect(h.connector._updates).toHaveLength(0);
  });

  it('test_anchor_resume_page_missing_agent_small_page_size', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction({ cmd: 'resume.page', offset: 0, pageSize: 5 }, h.ctx);
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(els, '第 1/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(els)).toHaveLength(5);
  });

  it('test_anchor_resume_n_override_affects_pagination_bar', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handle('/resume 3', h.ctx);
    const els = flattenElements(h.cardOf(0));
    expect(findDivWithText(els, '第 1/9 页 · 共 25 个会话')).toBeDefined();
    expect(resumePageButtons(els).map((b) => b.behaviors![0].value)).toEqual([
      { cmd: 'resume.page', agent: 'claude', offset: 3, pageSize: 3 },
    ]);
  });

  // ── 页边界：clamp 后按钮目标 / 非法 pageSize / 大总数 / 卡片预算 ─────
  it('test_anchor_resume_clamped_page_prev_button_targets_previous_page', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 1000, pageSize: 5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(els, '第 5/5 页 · 共 25 个会话')).toBeDefined();
    const pageButtons = resumePageButtons(els);
    expect(pageButtons).toHaveLength(1);
    expect(pageButtons[0].behaviors![0].value).toEqual({
      cmd: 'resume.page',
      agent: 'claude',
      offset: 15,
      pageSize: 5,
    });
  });

  it('test_anchor_resume_prev_click_after_clamp_reaches_previous_page', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 1000, pageSize: 5 },
      h.ctx,
    );
    const els = flattenElements(h.connector._updates[0].card as Card);
    const prev = resumePageButtons(els)[0];
    const prevValue = prev.behaviors![0].value!;

    await h.router.handleCardAction(
      {
        cmd: 'resume.page',
        agent: 'claude',
        offset: prevValue.offset,
        pageSize: prevValue.pageSize,
      },
      h.ctx,
    );
    const afterEls = flattenElements(h.connector._updates[1].card as Card);
    expect(findDivWithText(afterEls, '第 4/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(afterEls)).toHaveLength(5);
  });

  it('test_anchor_resume_page_negative_page_size_clamps_to_min', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 0, pageSize: -5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(els, '第 1/25 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(els)).toHaveLength(1);
  });

  it('test_anchor_resume_page_zero_page_size_clamps_to_min', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 0, pageSize: 0 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(els, '第 1/25 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(els)).toHaveLength(1);
  });

  it('test_anchor_resume_next_button_clickable', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 21);

    await h.router.handle('/resume 20', h.ctx);
    const els = flattenElements(h.cardOf(0));
    expect(findDivWithText(els, '第 1/5 页 · 共 21 个会话')).toBeDefined();
    const next = resumePageButtons(els)[0];
    expect(next.behaviors![0].value).toEqual({
      cmd: 'resume.page',
      agent: 'claude',
      offset: 5,
      pageSize: 5,
    });

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 5, pageSize: 5 },
      h.ctx,
    );
    const page2Els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(page2Els, '第 2/5 页 · 共 21 个会话')).toBeDefined();
    expect(resumeUseButtons(page2Els)).toHaveLength(5);
  });

  it('test_anchor_resume_total_huge_pagination_no_nan', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);
    h.registry.register('codex', hugeVirtualReader(99999));

    await h.router.handle('/resume codex', h.ctx);
    const els = flattenElements(h.cardOf(0));
    expect(findDivWithText(els, '第 1/20000 页 · 共 99999 个会话')).toBeDefined();
    expect(JSON.stringify(h.cardOf(0))).not.toMatch(/NaN|Infinity/);
    const next = resumePageButtons(els)[0];
    expect(next.behaviors![0].value).toEqual({
      cmd: 'resume.page',
      agent: 'codex',
      offset: 5,
      pageSize: 5,
    });

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'codex', offset: 99995, pageSize: 5 },
      h.ctx,
    );
    const lastEls = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(lastEls, '第 20000/20000 页 · 共 99999 个会话')).toBeDefined();
    expect(resumeUseButtons(lastEls)).toHaveLength(4);
    expect(resumePageButtons(lastEls)).toHaveLength(1); // 只有上一页
    expect(JSON.stringify(h.connector._updates[0].card)).not.toMatch(/NaN|Infinity/);
  });

  it('test_anchor_resume_page5_card_within_budget', async () => {
    const h = buildResumeHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 20, {
      msgLen: 150,
    });

    await h.router.handle('/resume', h.ctx);
    const card = h.cardOf(0);
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf-8');
    const topLevel = (card.body?.elements ?? []).length;
    expect(bytes).toBeLessThan(CARD_BUDGET_BYTES);
    expect(topLevel).toBeLessThan(200);
    expect(resumeUseButtons(flattenElements(card))).toHaveLength(5);
  });
});
