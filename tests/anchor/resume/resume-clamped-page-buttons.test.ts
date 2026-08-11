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
} from '../../lib/bridge-stubs.js';
/**
 * Anchor (R11-1): offset 越界被 clamp 后，分页按钮必须基于实际展示页
 * （clamped pageOffset）计算，否则"上一页"按钮假死。
 *
 * 行为：`resume.page` 收到越界 offset=1000（pageSize=5、25 个会话）时，
 * cmdResume 把页起点 clamp 到 20 并展示 `第 5/5 页 · 共 25 个会话`；该卡片
 * 的"上一页"按钮 value.offset 必须基于实际展示页计算为 15；点击该按钮
 * （offset=15）必须一次翻回 `第 4/5 页 · 共 25 个会话`。
 *
 * 缺失后果：实现用原始 offset（1000）计算按钮值（offset - pageSize = 980），
 * 点击后再次被 clamp 回 20 → 卡片永远停在 `第 5/5 页`，"上一页"按钮假死，
 * 第 5/5 页之前的所有会话不可达。
 *
 * 依据（docs/architecture/resume-pagination-plan.md §2.3/§4.1）：
 * "offset clamp 到 [0, max(0, total - pageSize)]，翻页期间新会话产生不崩溃
 * 不错位"；"上一页/下一页 原地翻页正确，内容不重复不遗漏"——clamp 后展示的
 * 是第 5/5 页，其"上一页"必须能到达第 4/5 页。
 */

// Stub connector: records sent messages AND in-place card updates (A6 shape).
function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  const updates: { messageId: string; card: unknown }[] = [];
  return {
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => '',
    _sent: sent,
    _updates: updates,
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    updateCard: async (messageId: string, card: unknown) => {
      updates.push({ messageId, card });
    },
    start: async () => {},
    stop: async () => {},
  };
}

// Stub runner
function createStubRunner() {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {},
  };
}

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

// A6 harness: full router wired to a real ClaudeSessionReader over 25 fixture sessions.
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
  const runner = createStubRunner();
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

describe('R11-1 clamp 后分页按钮基于实际展示页（上一页不假死）', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-clamped-page-buttons-anchor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_clamped_page_prev_button_targets_previous_page', async () => {
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    // 1. /resume → home page (第 1/5 页)
    await h.router.handle('/resume', h.ctx);
    const homeEls = flattenElements(h.cardOf(0));
    expect(findDivWithText(homeEls, '第 1/5 页 · 共 25 个会话')).toBeDefined();

    // 2. Clamp: stale offset=1000 → page start 20 (第 5/5 页)
    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 1000, pageSize: 5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    const clampedEls = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(clampedEls, '第 5/5 页 · 共 25 个会话')).toBeDefined();

    // 3. 上一页 button must target the previous page start (15), not raw offset 980
    const pageButtons = resumePageButtons(clampedEls);
    expect(pageButtons).toHaveLength(1);
    expect(pageButtons[0].behaviors![0].value).toEqual({
      cmd: 'resume.page',
      agent: 'claude',
      offset: 15,
      pageSize: 5,
    });

    // 4. Clicking 上一页 (offset 15) must reach page 4 in a single click
    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 15, pageSize: 5 },
      h.ctx,
    );
    const afterPrevEls = flattenElements(h.connector._updates[1].card as Card);
    expect(findDivWithText(afterPrevEls, '第 4/5 页 · 共 25 个会话')).toBeDefined();
  });
});
