/**
 * DSH preset 变更 / /resume preset 一致性校验的 router 级测试。
 *
 * 覆盖 §4.3 / §6 风险 1：preset 在 session 创建时固定，中途切换会被服务端拒绝
 * （agent-preset-conflict）。因此：
 * - /config 保存 agentPreset 变更 → 旧 session 停到 previousSessions + 清空 sessionId，
 *   下次 run 新建 session；
 * - /resume 一个 preset 与当前配置不一致的 dsh session → 明确提示，不静默复用。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { CommandRouter } from './index.js';
import { SessionStore, SessionReaderRegistry } from '../session/index.js';
import { AppConfigSchema, type AppConfig } from '../config/index.js';
import { createMockBridge } from '../../tests/lib/bridge-stubs.js';
import type { AgentSessionReader, AgentSession } from '../runner/index.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-test-'));
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
const SID_OLD = 'aaaaaaaa-1111-2222-3333-444444444444';

/** 构造可注入 dsh session 列表的 reader（sessions 带 agentPreset）。 */
function dshReader(rows: Array<Partial<AgentSession> & { sessionId: string }>): AgentSessionReader {
  return {
    listSessions: () => ({
      sessions: rows.map((r) => ({
        sessionId: r.sessionId,
        summary: r.summary ?? '',
        mtime: r.mtime ?? 1700000000000,
        ...(r.agentPreset ? { agentPreset: r.agentPreset } : {}),
      })),
      total: rows.length,
    }),
    getNewestSession: () => null,
    readSessionContent: () => ({
      events: [{ type: 'user', content: 'placeholder', timestamp: '2026-01-01T00:00:00.000Z' }],
    }),
    isSessionActive: () => false,
  };
}

function makeConfig(dsh?: Record<string, unknown>): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'dsh',
    ...(dsh ? { agents: { dsh } } : {}),
  });
}

/** 构造 CommandRouter，dsh reader 用给定 rows。 */
function makeRouter(
  rows: Array<Partial<AgentSession> & { sessionId: string }>,
  dsh?: Record<string, unknown>,
) {
  const sessionStore = new SessionStore();
  const config = makeConfig(dsh);
  const readerRegistry = new SessionReaderRegistry();
  readerRegistry.register('dsh', dshReader(rows));
  const router = new CommandRouter({
    sessionStore,
    bridge: createMockBridge(),
    config,
    configPath: path.join(TMP, `config-${Math.random().toString(36).slice(2)}.yaml`),
    workspacePath: path.join(TMP, `ws-${Math.random().toString(36).slice(2)}.json`),
    sessionReaderRegistry: readerRegistry,
  });
  return { router, sessionStore };
}

beforeEach(() => {});

describe('DSH preset 变更 session 语义', () => {
  it('preset 变更时把旧 sessionId 停到 previousSessions 并清空当前 sessionId', async () => {
    const { router, sessionStore } = makeRouter([], { agentPreset: 'minimal' });
    // 先有当前 dsh session
    sessionStore.set(ctx.userId, {
      cwd: '/home/user/project',
      sessions: new Map([['dsh', SID_OLD]]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
    });

    // 改 preset（走 config.save 卡片路径）
    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.dsh.agentPreset', option: 'code' },
      ctx,
    );
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 旧 session 停在 previousSessions，当前清空
    expect(sessionStore.getPreviousSessionId(ctx.userId, 'dsh')).toBe(SID_OLD);
    expect(sessionStore.getSessionId(ctx.userId, 'dsh')).toBeUndefined();
  });

  it('preset 变更但没有旧 session 时只提示新建，不抛错', async () => {
    const { router, sessionStore } = makeRouter([], { agentPreset: 'minimal' });
    sessionStore.set(ctx.userId, {
      cwd: '/home/user/project',
      sessions: new Map(),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
    });

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.dsh.agentPreset', option: 'code' },
      ctx,
    );
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    expect(sessionStore.getPreviousSessionId(ctx.userId, 'dsh')).toBeUndefined();
    expect(sessionStore.getSessionId(ctx.userId, 'dsh')).toBeUndefined();
  });

  it('model 变更不清 sessionId（保留 session，模型 run 前对齐）', async () => {
    const { router, sessionStore } = makeRouter([], { model: 'deepseek-v4-flash' });
    sessionStore.set(ctx.userId, {
      cwd: '/home/user/project',
      sessions: new Map([['dsh', SID_OLD]]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
    });

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.dsh.model', option: 'deepseek-v4-pro' },
      ctx,
    );
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // session 保留，未停到停车位
    expect(sessionStore.getSessionId(ctx.userId, 'dsh')).toBe(SID_OLD);
    expect(sessionStore.getPreviousSessionId(ctx.userId, 'dsh')).toBeUndefined();
  });
});

describe('DSH /resume preset 一致性校验', () => {
  it('session preset 与配置不一致时拒绝复用并提示', async () => {
    // 配置 preset = code，session 的 preset = minimal
    const { router, sessionStore } = makeRouter([{ sessionId: SID_OLD, agentPreset: 'minimal' }], {
      agentPreset: 'code',
    });
    sessionStore.set(ctx.userId, {
      cwd: '/home/user/project',
      sessions: new Map(),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
    });

    const result = router.cmdResume(['dsh', SID_OLD], ctx);
    expect(typeof result).toBe('object');
    const text = (result as { text?: string }).text ?? '';
    expect(text).toContain('preset');
    expect(text).toContain('minimal');
    expect(text).toContain('code');
    // 未写入 sessionId
    expect(sessionStore.getSessionId(ctx.userId, 'dsh')).toBeUndefined();
  });

  it('session preset 与配置一致时放行恢复', async () => {
    const { router, sessionStore } = makeRouter([{ sessionId: SID_OLD, agentPreset: 'code' }], {
      agentPreset: 'code',
    });
    sessionStore.set(ctx.userId, {
      cwd: '/home/user/project',
      sessions: new Map(),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
    });

    const result = router.cmdResume(['dsh', SID_OLD], ctx);
    const text = (result as { text?: string }).text ?? '';
    expect(text).not.toContain('preset');
    // 已写入 sessionId
    expect(sessionStore.getSessionId(ctx.userId, 'dsh')).toBe(SID_OLD);
  });

  it('配置跟随服务端默认（无 preset）时不校验，放行恢复', async () => {
    const { router, sessionStore } = makeRouter(
      [{ sessionId: SID_OLD, agentPreset: 'minimal' }],
      {}, // 无 preset 配置
    );
    sessionStore.set(ctx.userId, {
      cwd: '/home/user/project',
      sessions: new Map(),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
    });

    router.cmdResume(['dsh', SID_OLD], ctx);
    expect(sessionStore.getSessionId(ctx.userId, 'dsh')).toBe(SID_OLD);
  });
});
