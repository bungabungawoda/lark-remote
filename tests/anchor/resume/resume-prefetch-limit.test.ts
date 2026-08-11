import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
 * Anchor (P1-1): /resume 列表页内容预取有上限（≤5），且 5 行全部有标题
 *
 * 验证什么行为：
 *   1. `/resume` 列表页对 `readSessionContent`（全量 JSONL 扫描：usage/事件/
 *      title/recap）的预取调用数 ≤ 5 —— 页大小 5 时预取覆盖整页（每行一次
 *      全量读取），不允许超出页内行数做无谓扫描。
 *   2. 页大小语义：卡片含 5 个 `resume.use` 按钮。
 *   3. 行渲染不空：5 行全部有标题区内容，来自 displayTitle 预取。fixture
 *      让每行 summary 与 displayTitle 可区分（首个 user 消息 =
 *      summary-unique-NN，末个 user 消息 = display-unique-NN），断言卡片
 *      JSON 至少含 5 个不同的 display 文本——若预取上限/渲染缺失，行标题
 *      会从卡片消失 → 红。
 *
 * 缺失/错误会导致什么：
 *   超出页内行数做全量 JSONL 扫描，大 session（几百 KB）下 `/resume` 列表
 *   卡顿；若预取/渲染缺失，行没有标题，用户无法从列表辨认会话内容。
 *
 * 依据（review P1-1 / resume-pagination-plan §2.2）：
 *   plan §2.2 "只有返回页内的 session 才做全量解析"（codex 侧已按此实现）；
 *   claude 侧 `/resume` 列表应复用 listSessions 已算好的 summary 做行标题
 *   兜底，全量 readSessionContent 预取上限 ≤5（列表只需要足够渲染标题）。
 */

// Stub connector (minimal, matches tests/anchor/resume/resume-pagination.test.ts pattern)
function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  return {
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => '',
    _sent: sent,
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    updateCard: async () => {},
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

// Fake Claude session jsonl with an init line carrying the cwd (regression 2026-06-21).
// body has TWO user messages: first = summary source (listSessions),
// last = displayTitle source (readSessionContent) — makes the two sources
// distinguishable in the rendered card.
function writeSessionJsonl(projDir: string, sid: string, cwd: string, body: string): void {
  const initLine = `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${cwd}","model":"opus"}`;
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), `${initLine}\n${body}\n`);
}

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

describe('P1-1 /resume 列表页预取上限 + summary 兜底', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-prefetch-limit-anchor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_list_prefetch_capped_and_rows_rendered', async () => {
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const canonicalCwd = fs.realpathSync(tmpDir);
    const projDir = path.join(projectsDir, encodedProjectDir(canonicalCwd));
    fs.mkdirSync(projDir, { recursive: true });

    // 25 claude sessions with distinct mtimes (mtime-desc ordering deterministic).
    const baseSec = Math.floor(Date.now() / 1000) - 86400;
    for (let i = 0; i < 25; i++) {
      const sid = `session-${String(i).padStart(2, '0')}`;
      const summaryText = `summary-unique-${String(i).padStart(2, '0')}`;
      const displayText = `display-unique-${String(i).padStart(2, '0')}`;
      writeSessionJsonl(
        projDir,
        sid,
        canonicalCwd,
        [
          `{"type":"user","message":{"role":"user","content":"${summaryText}"}}`,
          `{"type":"user","message":{"role":"user","content":"${displayText}"}}`,
        ].join('\n'),
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

    // Real claude reader against the fixture; other agents stubbed (R2 shape).
    const registry = new SessionReaderRegistry();
    const reader = new ClaudeSessionReader({ projectsDir });
    registry.register('claude', reader);
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
    const cardOf = (index: number) =>
      (connector._sent[index].input as { card: { body?: { elements?: CardElement[] } } }).card;

    const spy = vi.spyOn(reader, 'readSessionContent');
    try {
      await router.handle('/resume', ctx);

      // 1. Prefetch is capped: at most 5 full readSessionContent calls
      //    (one per listed session on a 5-row page).
      expect(spy.mock.calls.length).toBeLessThanOrEqual(5);

      // 2. Page-size semantics: 5 resume.use buttons (page size 5).
      expect(countResumeButtons(cardOf(0))).toBe(5);

      // 3. All rows have title content: at least 5 distinct displayTitle
      //    texts must appear in the card (rows 24..20 are the newest 5).
      const cardJson = JSON.stringify(cardOf(0));
      const displayTokens = Array.from({ length: 5 }, (_, i) => {
        return `display-unique-${String(24 - i).padStart(2, '0')}`;
      });
      const present = displayTokens.filter((t) => cardJson.includes(t));
      expect(present.length).toBeGreaterThanOrEqual(5);
    } finally {
      spy.mockRestore();
    }
  });
});
