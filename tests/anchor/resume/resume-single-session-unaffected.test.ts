/**
 * Round 8 regression guard (plan §4.3): `/resume <sessionId>` single-session
 * path must be untouched by the pagination work.
 *
 * 验证什么行为：
 *   25 个 claude session 的 fixture 下，`/resume session-24`（显式 sessionId）
 *   仍走原单会话路径：① 恢复卡片包含该 sessionId；② SessionStore 里
 *   user1 的 claude sessionId 被设为该 id；③ 卡片不含分页栏文案
 *   （`第 1/` 前缀）—— 分页只属于列表页，单会话页不能出现"第 x/y 页"。
 *
 * 缺失/错误会导致什么：
 *   分页重构若把 `/resume <id>` 误并入列表分支（例如把 sessionId 当 N 解析、
 *   或渲染分页栏/分页按钮），用户点击恢复会看到列表而不是会话内容，且
 *   sessionId 写错/不写，后续 `/active`、auto-resume 全部错乱；单会话卡片
 *   出现分页文案也会让用户误以为该页面可翻页（实际没有 resume.page 回调）。
 *
 * 依据（spec 原文）：
 *   docs/architecture/resume-pagination-plan.md §4.3："`/resume <sessionId>`
 *   单会话路径不变：设置 sessionId + 展示会话内容卡片，与分页列表互不影响"
 *   （红线 §9.1：`/resume <id>` 恢复会话并显示内容；分页栏仅列表页
 *   `total > pageSize` 时显示）。
 */
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
// Stub connector (same minimal shape as A3/A4 harness).
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
  behaviors?: Array<{ value?: { cmd?: string } }>;
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

describe('A8 /resume <sessionId> single-session path unaffected by pagination', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-single-session-anchor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_session_id_path_unaffected', async () => {
    // ── 25-session fixture (same as A3/A4/A6) ────────────────────────────
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const canonicalCwd = fs.realpathSync(tmpDir);
    const projDir = path.join(projectsDir, encodedProjectDir(canonicalCwd));
    fs.mkdirSync(projDir, { recursive: true });

    const baseSec = Math.floor(Date.now() / 1000) - 86400;
    for (let i = 0; i < 25; i++) {
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

    // ── Contract under test: /resume <existing sessionId> ───────────────
    const targetSessionId = 'session-24';
    await router.handle(`/resume ${targetSessionId}`, ctx);

    expect(connector._sent.length).toBeGreaterThanOrEqual(1);
    const card = (connector._sent[0].input as { card: Card }).card;
    const cardJson = JSON.stringify(card);

    // ① 卡片 body 有会话 header（含该 sessionId）
    expect(findDivWithText(flattenElements(card), `会话: **${targetSessionId}**`)).toBeDefined();
    expect(cardJson).toContain(targetSessionId);

    // ② sessionStore 中 user1 的（默认 claude）sessionId 被设为该 id
    expect(sessionStore.getSessionId('user1')).toBe(targetSessionId);

    // ③ 单会话卡片不含分页栏文案（`第 1/` 前缀）——分页只属于列表页
    expect(cardJson).not.toContain('第 1/');
  });
});
