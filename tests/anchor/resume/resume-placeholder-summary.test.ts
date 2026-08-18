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
 * Anchor (Review P2-1): summary 占位符不得以"最近输入"label 渲染
 *
 * 验证什么行为：
 *   1. `/resume` 列表首页（25 个 claude session、每页 5 条）：5 个
 *     `resume.use` 按钮，不含占位符文案。
 *   2. 翻到含无 user 消息 session（05/06/07，第 4 页 offset=15）的页面时，
 *     `'(无摘要)'` 占位符不得渲染进卡片：所有文本不含 `(无摘要)`，
 *     也不含 `🏷️ **最近输入**\n(无摘要)` 组合（displayTitle 缺失时整行
 *     不渲染标题区，而不是显示误导性占位符）。
 *   3. 正常行仍渲染标题：该页其余 session 的 displayTitle 出现，不产生空行。
 *
 * 缺失/错误会导致什么：
 *   无用户消息的 session 会显示 `🏷️ 最近输入\n(无摘要)` 这类占位符标题，
 *   用户误以为占位符是真实输入；claude/codex/kimi 的占位符文案各不相同
 *   （`(无摘要)`/`(no user message)`/`New Session`），都是 Review P2-1 所述
 *   "summary 兜底 + label 恒为最近输入"引入的可见 UX 回归（改动前每行都预取
 *   displayTitle，无 displayTitle 时整行不显示标题）。
 *
 * 依据（Review Round 2 P2-1 + design.md §9.22 列表行内容）：
 *   "非预取行 `titleText = s.summary`，label 恒为 `最近输入`。但各 reader 的
 *   summary 并不等于最近输入：claude 是 `'(无摘要)'`…卡片会显示
 *   `🏷️ 最近输入\n(无摘要)` 这种误导/占位符标题。建议：兜底前过滤占位符…
 *   并补一个『无用户消息 fixture 不渲染占位符标题』的 anchor。"
 */
type CardElement = {
  tag?: string;
  columns?: Array<{ elements?: CardElement[] }>;
  behaviors?: Array<{ value?: { cmd?: string } }>;
};

// CardKit 2.0: resume.use buttons live in column_set -> column -> elements with behaviors.
function countResumeButtons(card: { body?: { elements?: CardElement[] } }): number {
  const elements = card?.body?.elements ?? [];
  const buttons = elements.flatMap((e) => e.columns?.flatMap((c) => c.elements ?? []) ?? []);
  return buttons.filter((b) => b.behaviors?.[0]?.value?.cmd === 'resume.use').length;
}

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

describe('Review P2-1 非预取行占位符 summary 不得渲染为"最近输入"', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-placeholder-summary-anchor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_placeholder_summary_not_rendered_as_recent_input', async () => {
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const canonicalCwd = fs.realpathSync(tmpDir);
    const projDir = path.join(projectsDir, encodedProjectDir(canonicalCwd));
    fs.mkdirSync(projDir, { recursive: true });

    // 25 claude sessions with distinct mtimes (mtime-desc ordering deterministic:
    // session-24 is row 1 / newest, session-00 is row 25 / oldest).
    // Sessions 05/06/07 have NO user message → summary falls back to '(无摘要)'
    // (only init + assistant lines). They sit at rows 18-20 → page 4 (offset 15).
    const baseSec = Math.floor(Date.now() / 1000) - 86400;
    for (let i = 0; i < 25; i++) {
      const sid = `session-${String(i).padStart(2, '0')}`;
      const tag = String(i).padStart(2, '0');
      const body =
        i >= 5 && i <= 7
          ? `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello from ${sid}"}]}}`
          : [
              `{"type":"user","message":{"role":"user","content":"summary-unique-${tag}"}}`,
              `{"type":"user","message":{"role":"user","content":"display-unique-${tag}"}}`,
            ].join('\n');
      writeSessionJsonl(projDir, sid, canonicalCwd, body);
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

    // Real claude reader against the fixture; other agents stubbed (R2 shape).
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

    // 首页：5 个按钮，不含占位符文案（page 1 = sessions 24..20 全正常）。
    await router.handle('/resume', ctx);
    const card1 = (connector._sent[0].input as { card: object }).card;
    const strings1 = collectStrings(card1);
    expect(strings1.some((s) => s.includes('(无摘要)'))).toBe(false);
    expect(countResumeButtons(card1)).toBe(5);

    // 翻到第 4 页（offset=15，sessions 09..05，含 3 个占位符 session）。
    await router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 15, pageSize: 5 },
      ctx,
    );
    const card4 = connector._updates[0].card;
    const strings4 = collectStrings(card4);

    // 1. Placeholder must never appear anywhere on the card.
    expect(strings4.some((s) => s.includes('(无摘要)'))).toBe(false);

    // 2. Placeholder must never appear under the "最近输入" label.
    expect(strings4.some((s) => s.includes('🏷️ **最近输入**\n(无摘要)'))).toBe(false);

    // 3. Page-size semantics: 5 resume.use buttons per page.
    expect(countResumeButtons(card4)).toBe(5);

    // 4. Normal rows still render their title (displayTitle) — no empty rows:
    //    sessions 09/08 are normal, their display-unique text must appear.
    const displayTokens = ['display-unique-09', 'display-unique-08'];
    const present = displayTokens.filter((t) => strings4.some((s) => s.includes(t)));
    expect(present).toEqual(displayTokens);
  });
});
