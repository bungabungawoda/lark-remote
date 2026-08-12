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

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubRunner,
  createStubConnector,
} from '../../lib/bridge-stubs.js';
/**
 * Anchor (A4): `/resume` 分页栏显示真实总数 + `resume.page` 按钮 + 假提示已删
 *
 * 验证：
 * 1. 25 个 session、默认 pageSize=5 时，卡片显示 `第 1/5 页 · 共 25 个会话`，
 *    且恰有 1 个 resume.page 按钮（下一页，value `{cmd:'resume.page', agent:'claude',
 *    offset:5, pageSize:5}`），首页无 offset=0 的上一页按钮。
 * 2. `/resume 3` 页大小覆盖为 3 时，显示 `第 1/9 页 · 共 25 个会话`，
 *    下一页 value offset=3 / pageSize=3（N 来自 reader 真实总数，不是截断长度）。
 * 3. 卡片 JSON 不含 `"tag":"action"`（CardKit 2.0 200861 守卫，新按钮必须走 behaviors）。
 * 4. 卡片不含 `输入 /resume` 假提示（已被分页栏取代）。
 * 5. total(5) <= pageSize(5) 时无 resume.page 按钮（分页栏仅 total > pageSize 显示）。
 *
 * 缺失/错误会导致：第 21+ 个会话永远不可达（无翻页按钮）；卡片显示的
 * "共 N 个会话"是截断后长度而非真实总数（假提示）；按钮包 action 容器触发
 * 飞书 200861 整卡不可用。
 *
 * 依据（docs/architecture/resume-pagination-plan.md §2.3/§4.2）：
 * "分页栏照搬 cmdLs 结构：`第 x/y 页 · 共 N 个会话` + `上一页`/`下一页` 按钮，
 * 仅 `total > pageSize` 时显示；N 为 reader 返回的真实总数。"
 * "新增回调 resume.page，value {cmd:'resume.page', agent, offset, pageSize}。"
 * "删除 `共 ${allSessions.length} 个会话…输入 /resume N 查看全部` 假提示。"
 * "新按钮必须走 behaviors，禁 action 容器（200861 正则断言）。"
 */

// Stub connector (same minimal shape as tests/anchor/resume/resume-pagination.test.ts)

// Stub runner

// Same encoding as production `projectDirForCwd`, canonicalized via realpath first.
function encodedProjectDir(cwd: string): string {
  return fs.realpathSync(cwd).replace(/\//g, '-').replace(/_/g, '-');
}

// Fake Claude session jsonl with init line carrying the cwd (regression 2026-06-21).
function writeSessionJsonl(projDir: string, sid: string, cwd: string, body: string): void {
  const initLine = `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${cwd}","model":"opus"}`;
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), `${initLine}\n${body}\n`);
}

type CardElement = {
  tag?: string;
  text?: { content?: string };
  columns?: Array<{ elements?: CardElement[] }>;
  behaviors?: Array<{
    value?: { cmd?: string; agent?: string; offset?: number; pageSize?: number };
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
  return { router, ctx, cardOf };
}

describe('A4 /resume 分页栏 + 真实总数 + 删假提示', () => {
  let tmpDir25: string;
  let tmpDir5: string;

  beforeEach(() => {
    tmpDir25 = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pagination-bar-25-'));
    tmpDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pagination-bar-5-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir25, { recursive: true, force: true });
    fs.rmSync(tmpDir5, { recursive: true, force: true });
  });

  it('test_anchor_resume_pagination_bar_shows_real_total', async () => {
    const h25 = buildHarness(tmpDir25, path.join(tmpDir25, 'claude-projects'), 25);

    // 25 sessions / default pageSize 5 → 5 pages, real total 25
    await h25.router.handle('/resume', h25.ctx);
    const card1 = h25.cardOf(0);
    const els1 = flattenElements(card1);
    expect(findDivWithText(els1, '第 1/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumePageButtons(els1).map((b) => b.behaviors![0].value)).toEqual([
      { cmd: 'resume.page', agent: 'claude', offset: 5, pageSize: 5 },
    ]);
    expect(resumePageButtons(els1).some((b) => b.behaviors![0].value?.offset === 0)).toBe(false);
    expect(JSON.stringify(card1)).not.toContain('"tag":"action"');
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
    const h5 = buildHarness(tmpDir5, path.join(tmpDir5, 'claude-projects'), 5);
    await h5.router.handle('/resume', h5.ctx);
    const els3 = flattenElements(h5.cardOf(0));
    expect(resumePageButtons(els3)).toHaveLength(0);
  });
});
