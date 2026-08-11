/**
 * Round 8 termination probes (plan §4.1/§4.3): resume.page callback and
 * /resume [N] page-size override boundary attacks.
 *
 * Each `test_probe_*` is an independent assumption about behavior the spec
 * does not fully pin down (T6). Expected results recorded per probe in the
 * round report; a fail here is a candidate RED, not a spec violation by
 * itself — the orchestrator decides upgrade/discard.
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

import { createStubAgentRegistry, createStubSessionReaderRegistry } from '../lib/bridge-stubs.js';
// Stub connector: records sent messages AND in-place card updates.
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

// Stub runner.
function createStubRunner() {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {},
  };
}

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
    value?: { cmd?: string; agent?: string; offset?: number; pageSize?: number };
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

describe('Round 8 probes: resume.page boundary behaviors', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-page-probes-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_probe_resume_page_negative_offset_clamps_to_first_page', async () => {
    // 假设：负 offset 与正越界 offset 一样 clamp 到合法页首（router 层
    // offset < 0 → 0），显示第 1/5 页而不是空页/错位页/崩溃。
    // spec 缺口：plan §2.3 只写了 "offset clamp 到 [0, max(0, total - pageSize)]"，
    // 未显式点名负值；负 offset 属于该 clamp 区间的直接推论。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: -20, pageSize: 5 },
      h.ctx,
    );
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(els, '第 1/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(els)).toHaveLength(5);
  });

  it('test_probe_resume_page_non_default_agent_no_sessions_returns_error_toast', async () => {
    // P3-5 新语义（Round 13，2026-08-01）：resume.page 翻到空目录/无会话时
    // 只返回 error toast，不再 sendResult 文本 + success toast。
    // toast 文案带 agent 显示名（agentDisplayName('pi') = 'Pi'），
    // 非默认 agent（pi）没有任何会话时，handleResumePage 返回
    // `{ toast: { type: 'error', content: '当前目录没有 Pi 的 session 记录' } }`，
    // 不发新文本消息、不 updateCard。
    // spec 缺口：plan §2.3 未写非默认 agent 空目录的翻页行为，只有
    // "缺 agent 兜底 defaultAgent"；此处断言对齐裁决后的 error-toast 分支。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    const sentBefore = h.connector._sent.length;
    const resp = await h.router.handleCardAction(
      { cmd: 'resume.page', agent: 'pi', offset: 0, pageSize: 5 },
      h.ctx,
    );
    // 返回值即 error toast（handleCardAction 直通 connector 的 SDK 响应）。
    expect(resp?.toast?.type).toBe('error');
    expect(resp?.toast?.content).toBe('当前目录没有 Pi 的 session 记录');
    // 不再 sendResult 错误文本：_sent 不新增任何消息。
    expect(h.connector._sent).toHaveLength(sentBefore);
    // 无会话时不更新卡片。
    expect(h.connector._updates).toHaveLength(0);
  });

  it('test_probe_resume_page_missing_agent_small_page_size', async () => {
    // 假设：value 缺 agent 时按 defaultAgent（claude）兜底，且 pageSize=5
    // 生效 → 第 1/5 页 · 共 25 个会话（小页大小必须影响分页栏与翻页步长）。
    // spec 缺口：plan §2.3 覆盖"缺 agent 兜底"与"pageSize 覆盖"，但未组合
    // 断言两者同时出现时的一致性。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handleCardAction({ cmd: 'resume.page', offset: 0, pageSize: 5 }, h.ctx);
    expect(h.connector._updates).toHaveLength(1);
    const els = flattenElements(h.connector._updates[0].card as Card);
    expect(findDivWithText(els, '第 1/5 页 · 共 25 个会话')).toBeDefined();
    expect(resumeUseButtons(els)).toHaveLength(5);
  });

  it('test_probe_resume_n_override_affects_pagination_bar', async () => {
    // 假设：`/resume 3` 的 N=3 页大小覆盖必须同时作用于列表条数与分页栏
    // （ceil(25/3)=9 页 → `第 1/9 页 · 共 25 个会话`，下一页 offset=3）。
    // spec 缺口：plan §2.3 写 N "作为页大小覆盖"，A4 只锚了默认页
    // （第 1/5 页）；N 与 total 不成整除关系（25/3）时页数取整边界未显式锚定。
    const h = buildHarness(tmpDir, path.join(tmpDir, 'claude-projects'), 25);

    await h.router.handle('/resume 3', h.ctx);
    const els = flattenElements(h.cardOf(0));
    expect(findDivWithText(els, '第 1/9 页 · 共 25 个会话')).toBeDefined();
    expect(resumePageButtons(els).map((b) => b.behaviors![0].value)).toEqual([
      { cmd: 'resume.page', agent: 'claude', offset: 3, pageSize: 3 },
    ]);
  });
});
