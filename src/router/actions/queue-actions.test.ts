import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../bridge/index.js';
import type { CommandRouter } from '../index.js';
import { handleQueueDiagnose } from './queue-actions.js';

const ctx: CommandContext = { userId: 'u1', chatId: 'c1', messageId: 'm1' };

function makeHost() {
  const sent: unknown[] = [];
  const host = {
    bridge: {
      getQueuedTask: () => ({ messagePreview: 'queued message' }),
      getQueueInfo: () => ({ isRunning: false, position: 1, tasksAhead: 1 }),
      getQueuedTasks: () => [{ messageId: 'm1' }],
      getAllActiveRuns: () => [],
      getActiveBashRuns: () => [{ runId: 'bash-1', userId: 'u1', chatId: 'c1', cwd: '/tmp' }],
      sendResult: async (result: unknown) => {
        sent.push(result);
      },
    },
    sessionStore: { getSessionId: () => undefined },
    config: { defaultAgent: 'claude' },
  } as unknown as CommandRouter;
  return { host, sent };
}

describe('handleQueueDiagnose', () => {
  it('separates agent queue consumption from independent Bash runs', async () => {
    const { host, sent } = makeHost();

    await handleQueueDiagnose(host, { cwd: '/tmp', messageId: 'm1' }, ctx);

    const card = sent[0] as { card?: unknown };
    const cardStr = JSON.stringify(card);
    expect(cardStr).toContain('Agent 队列正在运行: ❌ 否');
    expect(cardStr).toContain('Bash 独立任务: ✅ 有');
    expect(cardStr).toContain('Bash 独立任务不影响队列消费');
  });
});
