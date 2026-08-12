/**
 * Round 10 termination probes (plan §2.3/§4.1/§4.3): resume.page 翻页边界。
 *
 * Each `test_probe_*` is an independent assumption about behavior the spec
 * does not fully pin down; a fail here is a candidate RED for the
 * orchestrator to upgrade/drop, NOT a spec violation by itself.
 *
 * Focus areas:
 * - P10-1/P10-2: offset 越界被 clamp 后，分页栏按钮必须基于**实际展示页**
 *   （clamped pageOffset）计算，否则"上一页"按钮在 clamp 后永远指向同一页
 *   （本实现用原始 offset 计算按钮值，点击后重新 clamp 回同一页）。
 * - P10-3/P10-4: resume.page 的 pageSize 非法值（0/负数）经 handleResumePage
 *   传入 cmdResume 后应保持 N clamp [1,5] 语义，而不是把负数当 sessionId。
 * - P10-5: `/resume 20`（clamp 到 5）后下一页按钮可点（总 21 条时 offset=5）。
 * - P10-6: total 巨大（99999）时分页栏无 NaN/溢出，越界 clamp 到页对齐末页。
 * - P10-7: pageSize=5 满页卡片满足 28KB/200 elements 预算（§4.3）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../../src/session/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { Bridge } from '../../src/bridge/index.js';
import type { AppConfig } from '../../src/config/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';
import { ClaudeSessionReader } from '../../src/session/claude/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubRunner,
  createStubConnector,
} from '../lib/bridge-stubs.js';

function encodedProjectDir(cwd: string): string {
  return fs.realpathSync(cwd).replace(/\//g, '-').replace(/_/g, '-');
}

function writeSessionJsonl(projDir: string, sid: string, cwd: string, body: string): void {
  const initLine = `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${cwd}","model":"opus"}`;
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), `${initLine}\n${body}\n`);
}

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

function buildHarness(tmpDir: string, projectsDir: string, sessionCount: number, msgLen = 0) {
  const canonicalCwd = fs.realpathSync(tmpDir);
  const projDir = path.join(projectsDir, encodedProjectDir(canonicalCwd));
  fs.mkdirSync(projDir, { recursive: true });

  const baseSec = Math.floor(Date.now() / 1000) - 86400;
  const message = 'task ' + 'x'.repeat(Math.max(0, msgLen));
  for (let i = 0; i < sessionCount; i++) {
    const sid = `session-${String(i).padStart(2, '0')}`;
    writeSessionJsonl(
      projDir,
      sid,
      canonicalCwd,
      `{"type":"user","message":{"role":"user","content":"${message}"}}`,
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
  } as any;
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
  return { router, ctx, connector, sessionStore, cardOf, registry };
}

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
  } as any;
}

describe('Round 10 router probes: resume.page 边界', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'round10-router-probes-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_probe_resume_clamped_page_prev_button_targets_previous_page', async () => {
    // 假设：offset=1000 越界被 clamp 到末页起点 20 后（A6 已锚定的输入），
    // 渲染的"上一页"按钮 value.offset 必须基于实际展示页 pageOffset（20）
    // 计算为 15（指向第 4 页）——按钮语义是"从当前展示页回退一页"。
    // spec 依据：§2.3 "上一页/下一页" + "翻页期间新会话产生不崩溃不错位"；
    // clamp 后展示的是第 5/5 页，其上一页必须能到达第 4 页。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

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

  it('test_probe_resume_prev_click_after_clamp_reaches_previous_page', async () => {
    // 假设：clamp 后渲染出的"上一页"按钮被点击时，必须把用户带回第 4 页。
    // 这是上一 probe 的可观测后果：如果按钮 value 用原始 offset 计算
    // （980），点击后再次 clamp 回 20 → 卡片仍是 第 5/5 页 → 按钮"假死"。
    // spec 依据：§4.1 "上一页/下一页 原地翻页正确，内容不重复不遗漏"。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

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

  it('test_probe_resume_page_negative_page_size_clamps_to_min', async () => {
    // 假设：resume.page 的 pageSize 与 `/resume N` 是同一个页大小旋钮，
    // 负值必须按 cmdResume 的 N clamp [1,5] 语义处理（负数 → 1 →
    // 第 1/25 页 · 共 25 个会话），而不是被当成 sessionId 走"未找到"。
    // spec 依据：§2.3 "N 作为页大小覆盖，clamp 到 [1, 5]"。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 0, pageSize: -5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(els, '第 1/25 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(els)).toHaveLength(1);
  });

  it('test_probe_resume_page_zero_page_size_clamps_to_min', async () => {
    // 假设：pageSize=0 被 clamp 到 1（与 `/resume 0` 语义一致，
    // A3 anchor 已锁定 N=0 → 1），不崩溃、不空页。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 0, pageSize: 0 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(els, '第 1/25 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(els)).toHaveLength(1);
  });

  it('test_probe_resume_next_button_clickable', async () => {
    // 假设：21 个会话、`/resume 20`（clamp 到 5）后分页栏 `第 1/5 页`，
    // 下一页 offset=5 可点，点击后 `第 2/5 页` 且恰有 5 个会话。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 21);

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

  it('test_probe_resume_total_huge_pagination_no_nan', async () => {
    // 假设：total=99999 时 `第 1/20000 页 · 共 99999 个会话`（无 NaN/Infinity），
    // offset=99995 落在页对齐末页起点 → `第 20000/20000 页`，
    // 页面非空（4 条）、无下一页按钮。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);
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

  it('test_probe_resume_page5_card_within_budget', async () => {
    // 假设：pageSize=5 满页 + 每个会话 150 字标题时，卡片 JSON 字节数
    // < 28KB、body 顶层 elements < 200（§4.3 回归红线；spec §2.4 预算复核
    // "5 条 × 约 3 elements ≈ 15 elements；字节远低于 28KB"）。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 20, 150);

    await h.router.handle('/resume', h.ctx);
    const card = h.cardOf(0);
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf-8');
    const topLevel = (card.body?.elements ?? []).length;
    expect(bytes).toBeLessThan(28 * 1024);
    expect(topLevel).toBeLessThan(200);
    expect(resumeUseButtons(flattenElements(card))).toHaveLength(5);
  });
});
