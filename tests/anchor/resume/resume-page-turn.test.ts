import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { ClaudeSessionReader } from '../../../src/session/claude/index.js';

import { encodedProjectDir, writeSessionJsonl } from '../../lib/session-fixtures.js';
import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubRunner,
  createStubConnector,
} from '../../lib/bridge-stubs.js';
/**
 * Anchor (A6): `resume.page` 回调原地翻页 + offset clamp + 缺 agent 兜底 + 无 cwd 报错
 *
 * 验证：
 * 1. `/resume` 首页（`第 1/5 页 · 共 25 个会话`，5 个 resume.use 按钮）。
 * 2. `handleCardAction({cmd:'resume.page', agent:'claude', offset:5, pageSize:5})`
 *    原地更新同一张卡片（stub connector.updateCard 被调用，不发送新卡），
 *    卡片含 `第 2/5 页 · 共 25 个会话`，恰好 5 个 resume.use 按钮
 *    （mtime desc 下的 session-19..15，页面内仍按 mtime desc），
 *    恰好 1 个 resume.page 按钮
 *    （上一页，value offset=0）。
 * 3. 越界 offset=1000 clamp 到末页（offset 20）：不抛异常，卡片含 `第 5/5 页`，
 *    resume.use 按钮仍 5 个（不空页、不错位）。
 * 4. value 缺 agent 字段时按 defaultAgent='claude' 兜底：卡片含
 *    `第 1/5 页 · 共 25 个会话`（能翻回首页，不崩）。
 * 5. cwd 未设置时返回错误 toast 或文本（对齐 resume.use 的
 *    「请先 /cd 设置工作目录」），不抛异常。
 *
 * 缺失/错误会导致：分页按钮点击后没有 `resume.page` case 而走 default
 * 分支（发出「未知的卡片操作」），卡片不变、第 21+ 个会话不可达；
 * 越界 offset 不 clamp 会渲染空页/错位；缺 agent 直接崩或走错 reader。
 *
 * 依据（docs/architecture/resume-pagination-plan.md §2.3）：
 * "新增回调 resume.page，value {cmd:'resume.page', agent, offset, pageSize} →
 * handleResumePage → updateCardInPlace 原地刷新"；
 * "offset clamp 到 [0, max(0, total - pageSize)]，翻页期间新会话产生不崩溃不错位"；
 * 缺 agent/无 cwd 行为对齐既有 `resume.use` case（defaultAgent 兜底 +
 * 「请先 /cd 设置工作目录」）。
 */
type CardElement = {
  tag?: string;
  text?: { content?: string };
  columns?: Array<{ elements?: CardElement[] }>;
  behaviors?: Array<{
    value?: {
      cmd?: string;
      agent?: string;
      offset?: number;
      pageSize?: number;
      sessionId?: string;
    };
  }>;
};

type Card = { body?: { elements?: CardElement[] } };

// Flatten divs/buttons nested in body.elements and columns[].elements[].
function flattenElements(card: Card): CardElement[] {
  const out: CardElement[] = [];
  const walk = (els: CardElement[] | undefined) => {
    for (const el of els ?? []) {
      out.push(el);
      walk(el.columns?.flatMap((c) => c.elements ?? []));
    }
  };
  walk(card?.body?.elements);
  return out;
}

function findDivWithText(elements: CardElement[], needle: string): CardElement | undefined {
  return elements.find((el) => el.tag === 'div' && (el.text?.content ?? '').includes(needle));
}

function resumePageButtons(elements: CardElement[]): CardElement[] {
  return elements.filter((el) => el.behaviors?.[0]?.value?.cmd === 'resume.page');
}

function resumeUseButtons(elements: CardElement[]): CardElement[] {
  return elements.filter((el) => el.behaviors?.[0]?.value?.cmd === 'resume.use');
}

// Build a full router harness wired to a real ClaudeSessionReader over the
// given projectsDir, with sessionCount fixture sessions (distinct mtimes).
function buildHarness(tmpDir: string, projectsDir: string, sessionCount: number) {
  const canonicalCwd = fs.realpathSync(tmpDir);
  const projDir = path.join(projectsDir, encodedProjectDir(canonicalCwd));
  fs.mkdirSync(projDir, { recursive: true });

  const baseSec = Math.floor(Date.now() / 1000) - 86400;
  for (let i = 0; i < sessionCount; i++) {
    const sid = `session-${String(i).padStart(2, '0')}`;
    writeSessionJsonl(
      projDir,
      sid,
      canonicalCwd,
      `{"type":"user","message":{"role":"user","content":"task ${i}"}}`,
    );
    fs.utimesSync(path.join(projDir, `${sid}.jsonl`), baseSec + i, baseSec + i);
  }

  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const runner = createStubRunner({ mode: 'empty' });
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'claude',
  });

  const registry = new SessionReaderRegistry();
  registry.register('claude', new ClaudeSessionReader({ projectsDir }));
  const stubReader = {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [], reason: 'not_found' }),
    isSessionActive: () => false,
  };
  registry.register('codex', stubReader);
  registry.register('opencode', stubReader);
  registry.register('pi', stubReader);
  registry.register('kimi', stubReader);

  const bridge = new Bridge({
    runner,
    agentRegistry: createStubAgentRegistry(runner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    connector,
    sessionStore,
    config,
  });
  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    sessionReaderRegistry: registry,
  });

  sessionStore.setCwd('user1', canonicalCwd);
  const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
  const cardOf = (index: number) => (connector._sent[index].input as { card: Card }).card;
  return { router, ctx, connector, sessionStore, cardOf };
}

describe('A6 resume.page 原地翻页 + offset clamp + 缺 agent 兜底 + 无 cwd 报错', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-page-turn-anchor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_page_turns_page_in_place_with_clamp', async () => {
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

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
    // fixture mtime 随 i 递增（session-24 最新、session-00 最旧），
    // 列表按 mtime desc 排序 → 页面 2 = session-19..15，页面内仍按 mtime desc。
    expect(resumeUseButtons(page2Els).map((b) => b.behaviors![0].value?.sessionId ?? '')).toEqual([
      'session-19',
      'session-18',
      'session-17',
      'session-16',
      'session-15',
    ]);
    const page2Buttons = resumePageButtons(page2Els);
    // 25 条 / 每页 5 = 5 页：第 2 页有上一页（offset 0）和下一页（offset 10）。
    expect(page2Buttons).toHaveLength(2);
    expect(page2Buttons.map((b) => b.behaviors![0].value)).toEqual([
      { cmd: 'resume.page', agent: 'claude', offset: 0, pageSize: 5 },
      { cmd: 'resume.page', agent: 'claude', offset: 10, pageSize: 5 },
    ]);

    // 3. Out-of-range offset (1000) clamps to the last page (offset 20):
    // no throw, no empty/misaligned page
    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 1000, pageSize: 5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(2);
    const clampedEls = flattenElements(h.connector._updates[1].card as Card);
    expect(findDivWithText(clampedEls, '第 5/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(clampedEls)).toHaveLength(5);
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
});
