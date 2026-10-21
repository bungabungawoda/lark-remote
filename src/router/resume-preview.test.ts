/**
 * /resume 列表卡的「会话预览」渲染。
 *
 * 背景（2026-10-21 反馈）：DSH 的列表卡过去只有 session id 和时间——reader 把
 * `session/list` 里现成的 `title` / `turnOutline` 丢了。修复分两层：
 * 1. reader 把预览字段（title / lastUserMessage / lastAssistantMessage）搬到行上；
 * 2. 列表卡在同一个 div 里多渲染两行，且**不再**为这些行做全量内容预取
 *    （DSH 一次列表原本要 15 次 curl，其中 5 次拉上万条事件）。
 *
 * 这里用最小的 fake reader 驱动 CommandRouter，只断言卡片文本与读取次数，
 * 不碰任何真实 DSH 进程。
 */

import { afterEach, describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { CommandRouter } from './index.js';
import { SessionStore, SessionReaderRegistry } from '../session/index.js';
import { AppConfigSchema } from '../config/index.js';
import { createMockBridge } from '../../tests/lib/bridge-stubs.js';
import { expectNoV1ActionContainer } from '../../tests/lib/card-view.js';
import type { AgentSession, AgentSessionReader } from '../runner/index.js';

const CWD = '/home/user/project';
const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

/** 递归收集卡片里所有 markdown 文本（含 nested column_set）。 */
function collectTexts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectTexts(item, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  const text = record.text as { content?: unknown } | undefined;
  if (typeof text?.content === 'string') out.push(text.content);
  for (const value of Object.values(record)) collectTexts(value, out);
  return out;
}

interface Harness {
  router: CommandRouter;
  /** 被调用 readSessionContent 的次数（全量内容读取 = 昂贵路径）。 */
  contentReads: () => number;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeHarness(rows: AgentSession[]): Harness {
  let contentReads = 0;
  const reader: AgentSessionReader = {
    listSessions: () => ({ sessions: rows, total: rows.length }),
    getNewestSession: () => null,
    readSessionContent: () => {
      contentReads += 1;
      return { events: [] };
    },
    isSessionActive: () => false,
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-preview-'));
  tempDirs.push(tmp);
  const config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'dsh',
  });
  const registry = new SessionReaderRegistry();
  registry.register('dsh', reader);
  const bridge = createMockBridge();
  const sessionStore = new SessionStore();
  sessionStore.setCwd(ctx.userId, CWD);

  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath: path.join(tmp, 'config.yaml'),
    workspacePath: path.join(tmp, 'workspace.json'),
    sessionReaderRegistry: registry,
  });
  return { router, contentReads: () => contentReads };
}

/** 捕获 /resume 发出的卡片，返回其中所有 markdown 文本。 */
async function resumeCardTexts(router: CommandRouter): Promise<string[]> {
  const bridge = (router as unknown as { bridge: { sendResult: { mock: { calls: unknown[][] } } } })
    .bridge;
  await router.handle('/resume', ctx);
  const sent = bridge.sendResult.mock.calls.at(-1)?.[0] as { card?: unknown } | undefined;
  expect(sent?.card).toBeDefined();
  // 200861 铁律：改过 /resume 列表卡就必须断言没有 v1 action 容器。
  expectNoV1ActionContainer(sent?.card);
  return collectTexts(sent?.card);
}

describe('/resume 列表卡：会话预览', () => {
  it('行级预览字段渲染为 标题 / 最近输入 / 最后输出', async () => {
    const { router } = makeHarness([
      {
        sessionId: 'session-0749de27',
        summary: '梳理待办与依赖',
        mtime: 1792541886753,
        title: '梳理待办与依赖',
        lastUserMessage: '修复，还有你的历史 run log 是在哪个文件里面看的？',
        lastAssistantMessage: '修复已经完成并进入代码库，共 2 个提交',
      },
    ]);

    const texts = (await resumeCardTexts(router)).join('\n');
    expect(texts).toContain('**标题**');
    expect(texts).toContain('梳理待办与依赖');
    expect(texts).toContain('**最近输入**');
    expect(texts).toContain('修复，还有你的历史 run log 是在哪个文件里面看的？');
    expect(texts).toContain('**最后输出**');
    expect(texts).toContain('修复已经完成并进入代码库，共 2 个提交');
  });

  it('行级已带预览时不触发全量内容读取（DSH 零额外请求）', async () => {
    const { router, contentReads } = makeHarness([
      {
        sessionId: 'session-with-preview',
        summary: '梳理待办与依赖',
        mtime: 1792541886753,
        title: '梳理待办与依赖',
        lastUserMessage: '最新一问',
        lastAssistantMessage: '最新一答',
      },
    ]);

    await resumeCardTexts(router);
    expect(contentReads()).toBe(0);
  });

  it('只有 summary 的旧 reader 仍按「会话摘要」渲染（无回归）', async () => {
    const { router } = makeHarness([
      { sessionId: 'claude-like', summary: '首条用户消息', mtime: 1792541886753 },
    ]);

    const texts = (await resumeCardTexts(router)).join('\n');
    expect(texts).toContain('**会话摘要**');
    expect(texts).toContain('首条用户消息');
    expect(texts).not.toContain('最后输出');
    expect(texts).not.toContain('最近输入');
  });

  it('无预览且 summary 为空时不渲染空的标题块', async () => {
    const { router } = makeHarness([
      { sessionId: 'blank-dsh-session', summary: '', mtime: 1792541886753 },
    ]);

    const texts = (await resumeCardTexts(router)).join('\n');
    expect(texts).toContain('blank-dsh-session');
    expect(texts).not.toContain('**标题**');
    expect(texts).not.toContain('**最后输出**');
    expect(texts).not.toContain('**最近输入**');
  });

  it('服务端标题是占位符时按无标题处理（不泄漏 New Session）', async () => {
    const { router } = makeHarness([
      {
        sessionId: 'placeholder-title',
        summary: 'New Session',
        mtime: 1792541886753,
        title: 'New Session',
        lastUserMessage: '真实输入',
      },
    ]);

    const texts = (await resumeCardTexts(router)).join('\n');
    expect(texts).not.toContain('New Session');
    expect(texts).not.toContain('**标题**');
    expect(texts).toContain('**最近输入**');
    expect(texts).toContain('真实输入');
  });
});
