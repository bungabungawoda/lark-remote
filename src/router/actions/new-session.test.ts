// /new（slash 命令）与 run 卡「✨ 新会话」按钮（card action）是同一操作的两个
// 触发入口，回执必须完全一致（§9.19：按操作语义分类，不按触发方式分类）。
// 本文件锁定「同文案（含 📁 工作区）+ 同存储语义」这条契约，以及
// 「/config 切换 agent 的清空分支与 /new 同形」这条回执一致性契约。
import { describe, it, expect } from 'vitest';
import { cmdNew } from './command-actions.js';
import { applyDefaultAgentSwitch } from './shared.js';
import { handleNewSession } from './session-actions.js';
import { SessionStore } from '../../session/index.js';
import type { CommandContext } from '../../bridge/index.js';
import type { CommandRouter } from '../index.js';

function makeHost() {
  const cleared: Array<{
    userId: string;
    agent: string;
    opts?: { clearSessionCwd?: boolean };
  }> = [];
  const texts: string[] = [];
  const host = {
    sessionStore: {
      clearSessionId: (userId: string, agent: string, opts?: { clearSessionCwd?: boolean }) => {
        cleared.push({ userId, agent, opts });
      },
      getCwd: (userId: string) => (userId === 'u1' ? '/tmp/workspace' : undefined),
    },
    config: { defaultAgent: 'codex' },
    bridge: {
      sendResult: async (result: { text: string }) => {
        texts.push(result.text);
      },
    },
  } as unknown as CommandRouter;
  return { host, cleared, texts };
}

describe('new-session 统一回执（/new 与卡片按钮同文案）', () => {
  it('slash /new 与 cardAction new-session 产生完全相同的回执（含工作区）', async () => {
    const slash = makeHost();
    const slashResult = cmdNew(slash.host, { userId: 'u1' } as CommandContext);
    const card = makeHost();
    await handleNewSession(card.host, { userId: 'u1' } as CommandContext);

    expect(card.texts).toHaveLength(1);
    expect(slashResult.text).toBe(card.texts[0]);
    expect(slashResult.text).toContain('📁 /tmp/workspace');
    expect(slashResult.text).toContain('Codex'); // 用户可见 agent 名走 agentDisplayName
    // 两条路径的存储语义一致：清会话绑定 + 清 per-agent sessionCwd（主 cwd 保留）
    expect(slash.cleared[0]).toEqual({
      userId: 'u1',
      agent: 'codex',
      opts: { clearSessionCwd: true },
    });
    expect(card.cleared[0]).toEqual(slash.cleared[0]);
  });

  it('无 cwd 时回执落到 (未设置) 占位', () => {
    const { host } = makeHost();
    const result = cmdNew(host, { userId: 'u2' } as CommandContext);
    expect(result.text).toContain('📁 (未设置)');
  });
});

describe('agent 切换清空分支与 /new 同形（含 📁 工作区）', () => {
  it('清空分支 notice 的工作区行与 /new 逐字一致', () => {
    const store = new SessionStore();
    store.setCwd('u1', '/tmp/workspace');
    const outcome = applyDefaultAgentSwitch(store, 'u1', 'claude', 'codex');

    expect(outcome.notice).toContain('session 已清空');
    expect(outcome.notice).toContain('📁 /tmp/workspace');
    // 同一 helper 产出的工作区行：两处各写一份文案就会漂移，这里钉住逐字相等
    const newHost = {
      sessionStore: store,
      config: { defaultAgent: 'codex' },
    } as unknown as CommandRouter;
    const newText = cmdNew(newHost, { userId: 'u1' } as CommandContext).text ?? '';
    expect(outcome.notice!.split('\n').at(-1)).toBe(newText.split('\n').at(-1));
  });

  it('无 cwd 时清空分支同样落到 (未设置) 占位', () => {
    const store = new SessionStore();
    const outcome = applyDefaultAgentSwitch(store, 'u2', 'claude', 'codex');
    expect(outcome.notice).toContain('📁 (未设置)');
  });

  it('恢复分支不加工作区行（Resume 卡 header 已有 📂 目录行）', () => {
    const store = new SessionStore();
    store.setCwd('u1', '/tmp/workspace');
    store.setPreviousSessionId('u1', 'codex', 'codex-session-P');
    const outcome = applyDefaultAgentSwitch(store, 'u1', 'claude', 'codex');

    expect(outcome.notice).toContain('将继续之前的 session');
    expect(outcome.notice).not.toContain('📁');
  });
});
