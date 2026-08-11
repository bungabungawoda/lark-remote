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
 * Anchor (A3): `/resume` 默认页大小 5，`/resume [N]` 的 N clamp 到 [1, 5]
 *
 * 验证：
 * 1. `/resume`（不带 N）在 cwd 有 25 个 session 时，首屏列出 **5** 个会话
 *    （每会话一个 `resume.use` 按钮 → 断言卡片含 5 个按钮）。
 * 2. `/resume 0`：N=0 clamp 到 1，仍列出 1 个会话（不允许空页）。
 * 3. `/resume 25`：N=25 clamp 到 5，最多列 5 个会话。
 *
 * 缺失/错误会导致：默认只列 3 条浪费卡片空间且与分页栏设计不符（plan
 * 明确"现状默认 3 取消，首页直接给满一页"）；N=0 得到空列表用户无会话可点；
 * N>20 时第 21 个之后的会话永远不可见，分页失去意义。
 *
 * 依据（docs/architecture/resume-pagination-plan.md §2.3）：
 * "新增 RESUME_PAGE_SIZE = 5 常量。`/resume [agent] [N]`：N 作为页大小覆盖，
 * clamp 到 `[1, 5]`；默认 5（2026-08-02 由 20 调为 5，首页直接给满一页）。"
 */

// Stub connector (minimal, matches resume-switch-default-agent.test.ts pattern)
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

// Same encoding as production `projectDirForCwd` (cwd -> dirName), canonicalized
// via realpath first (same as src/router/router.test.ts `encodedProjectDir`).
function encodedProjectDir(cwd: string): string {
  return fs.realpathSync(cwd).replace(/\//g, '-').replace(/_/g, '-');
}

// Write a fake Claude session jsonl with an init line carrying the cwd so the
// production reader can locate it via readCwdFromJsonl (regression 2026-06-21).
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

describe('A3 /resume 默认页大小 5 + N clamp [1,5]', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pagination-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_default_page_size_5_and_n_clamp', async () => {
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const canonicalCwd = fs.realpathSync(tmpDir);
    const projDir = path.join(projectsDir, encodedProjectDir(canonicalCwd));
    fs.mkdirSync(projDir, { recursive: true });

    // 25 claude sessions (session-00..session-24), each with distinct mtime so
    // the reader's mtime-desc ordering is deterministic.
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

    // Real claude reader against the fixture; other agents stubbed (R2 shape).
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
    const cardOf = (index: number) =>
      (connector._sent[index].input as { card: { body?: { elements?: CardElement[] } } }).card;

    // Default page size: /resume lists 5 sessions
    await router.handle('/resume', ctx);
    expect(countResumeButtons(cardOf(0))).toBe(5);

    // N=0 clamps up to 1: never an empty list
    await router.handle('/resume 0', ctx);
    expect(countResumeButtons(cardOf(1))).toBe(1);

    // N=25 clamps down to 5: page size never exceeds RESUME_PAGE_SIZE
    await router.handle('/resume 25', ctx);
    expect(countResumeButtons(cardOf(2))).toBe(5);
  });
});
