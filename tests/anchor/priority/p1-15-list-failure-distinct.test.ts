import { createMockBridge } from '../../lib/bridge-stubs.js';
/**
 * P1-15 残余 anchors：opencode session list 失败必须与「真空」可区分
 *
 * review.md §P1-15 建议项：「session list 失败（exit≠0/ENOBUFS）与『真空』区分
 * —— error 级日志 + 向上抛出让 router 显示『读取失败』」。当前 fetchSessionList
 * catch 后返回 []，用户看到「当前目录没有 session 记录」（误导），且与真空不可区分。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OpencodeSessionReader } from '../../../src/session/opencode/sessions.js';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore, SessionReaderRegistry } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentSessionReader } from '../../../src/runner/index.js';
import { prependPath, restorePath, writeMockBin } from '../../lib/path-mock.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

function buildConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'claude',
    claude: { model: 'opus', stopGraceMs: 5000 },
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
}

describe('P1-15 list failure vs empty', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_opencode_list_failure_throws_not_silent_empty', () => {
    // ① 验证什么行为：opencode CLI 失败（exit≠0）时 listSessions 必须上抛可
    //    诊断错误，而不是静默返回空列表。
    // ② 缺失/错误会导致什么：失败被 catch 吞成 [] → 用户看到「当前目录没有
    //    session 记录」，与真空不可区分；自动 resume 判定（getNewestSession）
    //    也会基于错误空集继续。
    // ③ 依据：review.md §P1-15「失败（exit≠0/ENOBUFS）与『真空』区分 ——
    //    error 级日志 + 向上抛出让 router 显示『读取失败』」。
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-15-fail-'));
    const saved = prependPath(tmpDir);
    writeMockBin(tmpDir, 'opencode', '#!/bin/sh\necho "boom" >&2\nexit 1\n');

    try {
      const reader = new OpencodeSessionReader();
      expect(() => reader.listSessions(tmpDir)).toThrow();
    } finally {
      restorePath(saved);
    }
  });

  it('test_anchor_resume_shows_read_failure_not_empty_hint', async () => {
    // ① 验证什么行为：/resume 列表页遇到 reader 读取失败时必须给用户可见的
    //    「读取失败」反馈，而不是误导性的「当前目录没有 session 记录」。
    // ② 缺失/错误会导致什么：当前 router 无兜底，抛错会沿队列 .catch 静默吞掉
    //    （只记日志），用户点击/输入 /resume 无任何反馈。
    // ③ 依据：review.md §P1-15 建议项（router 显示「读取失败」）。
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-15-router-'));
    const sessionStore = new SessionStore();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    const bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });

    const failingReader: AgentSessionReader = {
      listSessions: () => {
        throw new Error('opencode session list failed: mock boom');
      },
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', failingReader);

    const router = new CommandRouter({
      sessionStore,
      bridge: bridge as never,
      config: buildConfig(),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: registry,
    });

    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
    await router.handle('/resume', ctx);

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    const texts = sendResultMock.mock.calls
      .map((c) => (c[0] as { text?: string }).text ?? '')
      .filter(Boolean);
    expect(texts.some((t) => t.includes('列表失败'))).toBe(true);
    expect(texts.some((t) => t.includes('当前目录没有'))).toBe(false);
  });
});
