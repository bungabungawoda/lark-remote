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
 * Anchor (P3-1): resume.page 的 offset 数值化 + 页对齐，非法值不误导
 *
 * 验证什么行为：
 *   1. `resume.page` 回调里字符串/非法 offset（如 'abc'）必须按 0 数值化处理：
 *      不抛异常、原地更新卡片、卡片显示 `第 1/5 页 · 共 25 个会话`。当前实现
 *      直接把 'abc' 当 offset 传入 → slice(NaN) 空页 → 走文本兜底
 *      "当前目录没有 claude session 记录"（误导用户以为目录没会话）→ 红。
 *   2. 数值 offset 越界（25，total=25/pageSize=5）页对齐到末页起点 20，
 *      显示 `第 5/5 页 · 共 25 个会话`（不能出现 "第 6/5 页" 或错位内容）。
 *
 * 缺失/错误会导致什么：
 *   非法 offset 让用户看到"没有 session"的假空目录；offset 越界后分页栏页码
 *   与内容错位，用户翻页点到的不是期望的会话，且旧卡片无法原地刷新。
 *
 * 依据（review P3-1 / resume-pagination-plan §2.3）：
 *   "offset clamp 到页对齐的末页起点（pageSize 倍数）"；回调参数来自卡片
 *   payload（JSON value），必须是数值化后参与比较/切片，任何 NaN 值都不应
 *   产生误导性空页文案。
 */

// Stub connector that records updateCard calls (原地翻页路径).
function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  const updates: unknown[] = [];
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
    updateCard: async (_messageId: string, card: unknown) => {
      updates.push(card);
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

function writeSessionJsonl(projDir: string, sid: string, cwd: string, body: string): void {
  const initLine = `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${cwd}","model":"opus"}`;
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), `${initLine}\n${body}\n`);
}

describe('P3-1 resume.page offset 数值化 + 页对齐', () => {
  let tmpDir: string;
  let connector: ReturnType<typeof createStubConnector>;
  let router: CommandRouter;
  let ctx: { userId: string; chatId: string; messageId: string };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-page-offset-anchor-'));
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const canonicalCwd = fs.realpathSync(tmpDir);
    const projDir = path.join(projectsDir, encodedProjectDir(canonicalCwd));
    fs.mkdirSync(projDir, { recursive: true });

    // 25 claude sessions with distinct mtimes (mtime-desc ordering deterministic).
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
    connector = createStubConnector();
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
    router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      sessionReaderRegistry: registry,
    });

    sessionStore.setCwd('user1', canonicalCwd);
    ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_page_offset_normalized_and_page_aligned', async () => {
    // 1. String offset 'abc' must be treated as 0: no throw, card updated in
    //    place with the first page. Current: NaN slice → empty page →
    //    text fallback "当前目录没有 … session" and updateCard NOT called → RED.
    await router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 'abc', pageSize: 5 } as never,
      ctx,
    );
    expect(connector._updates).toHaveLength(1);
    expect(JSON.stringify(connector._updates[0])).toContain('第 1/5 页 · 共 25 个会话');

    // 2. Numeric offset 25 (total=25, pageSize=5) aligns to the last page
    //    start 20: page label must be 第 5/5 页 (never 第 6/5 页 or misaligned).
    await router.handleCardAction(
      { cmd: 'resume.page', agent: 'claude', offset: 25, pageSize: 5 },
      ctx,
    );
    expect(connector._updates).toHaveLength(2);
    expect(JSON.stringify(connector._updates[1])).toContain('第 5/5 页 · 共 25 个会话');
  });
});
