// /new（slash 命令）与 run 卡「✨ 新会话」按钮（card action）是同一操作的两个
// 触发入口，回执必须完全一致（§9.19：按操作语义分类，不按触发方式分类）。
// 本文件锁定「同文案（含 📁 工作区）+ 同存储语义」这条契约。
import { describe, it, expect } from 'vitest';
import { cmdNew } from './command-actions.js';
import { handleNewSession } from './session-actions.js';
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
