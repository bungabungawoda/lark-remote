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
 * Anchor (R11-2): resume.page 的非法 pageSize（负数）必须走 N clamp [1,5]
 * 语义（clamp 到 1），不能被当成 sessionId 处理。
 *
 * 行为：`handleCardAction({cmd:'resume.page', agent:'claude', offset:0,
 * pageSize:-5})` 原地刷新卡片（connector.updateCard 被调用），卡片显示
 * `第 1/25 页 · 共 25 个会话` 且恰有 1 个 resume.use 按钮（pageSize clamp 到 1）。
 *
 * 缺失后果：当前实现把 pageSize 直接 `String()` 喂给 cmdResume 文本参数解析，
 * `-5` 不匹配 `/^\d+$/` → 被当成 sessionId → 返回"未找到 session -5"文本，
 * 卡片不刷新、分页旋钮失效；负数页大小本应 clamp 到 1（与 `/resume 0` → 1
 * 同一语义，A3 已锚定）。
 *
 * 依据（docs/architecture/resume-pagination-plan.md §2.3）：
 * "`/resume [agent] [N]`：N 作为页大小覆盖，clamp 到 `[1, 5]`"；
 * resume.page 的 pageSize 是同一旋钮（§4.2 "value {cmd:'resume.page', agent,
 * offset, pageSize}"），必须复用同一 clamp。
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

function resumeUseButtons(elements: CardElement[]): CardElement[] {
  return elements.filter((el) => el.behaviors?.[0]?.value?.cmd === 'resume.use');
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

describe('R11-2 resume.page 非法 pageSize clamp 到 1', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-page-invalid-pagesize-anchor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_page_invalid_page_size_clamps_to_1', async () => {
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 0, pageSize: -5 },
      h.ctx,
    );

    // Must refresh the card in place, not fall back to a text reply.
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    // pageSize clamps to 1 → 25 pages of 1 session each.
    expect(findDivWithText(els, '第 1/25 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(els)).toHaveLength(1);

    // And no "未找到 session" text was sent as a replacement.
    const sentTexts = h.connector._sent
      .map((s) => (s.input as { text?: string }).text ?? '')
      .join('\n');
    expect(sentTexts).not.toContain('未找到 session');
  });
});
