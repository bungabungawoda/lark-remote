import { describe, expect, it, vi } from 'vitest';
import { formatHostStopResult, HostTurnStop } from './host-stop.js';
import type { AgentKind } from '../agent-kinds.js';
import type { AppConfig } from '../config/index.js';
import type { HostStopOutcome, Runner } from '../runner/types.js';
import type { SessionReaderRegistry, SessionStore } from '../session/index.js';
import type { CommandContext } from './index.js';

const CWD = '/home/user/project';
const SID = 'dsh-session-1';
const ctx: CommandContext = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

function makeReaderRegistry(): SessionReaderRegistry {
  return {
    get: () => ({
      readSessionContent: () => ({ events: [{ type: 'text', content: 'session tail' }] }),
    }),
  } as unknown as SessionReaderRegistry;
}

function makeStore(opts?: { sessionId?: string; cwd?: string }): SessionStore {
  return {
    getCwd: () => opts?.cwd ?? CWD,
    getSessionId: () => opts?.sessionId ?? SID,
  } as unknown as SessionStore;
}

function makeHostStop(opts?: {
  cancel?: (sessionId: string) => Promise<HostStopOutcome>;
  defaultAgent?: AgentKind;
  store?: SessionStore;
  readerRegistry?: SessionReaderRegistry;
}) {
  const sendResult = vi.fn().mockResolvedValue(true);
  const cancel =
    opts?.cancel ??
    vi.fn().mockResolvedValue({ status: 'cancelled', sessionId: SID, goalPhase: 'paused' });
  const getRunner = vi.fn().mockReturnValue({
    cancelHostTurn: cancel,
  } as unknown as Runner);
  const hostStop = new HostTurnStop({
    sessionStore: opts?.store ?? makeStore(),
    sessionReaderRegistry: opts?.readerRegistry ?? makeReaderRegistry(),
    getConfig: () => ({ defaultAgent: opts?.defaultAgent ?? 'dsh' }) as unknown as AppConfig,
    getRunner,
    sendResult,
  });
  return { hostStop, sendResult, getRunner, cancel };
}

function sentText(sendResult: ReturnType<typeof vi.fn>): string {
  return (sendResult.mock.calls.at(-1)?.[0] as { text?: string } | undefined)?.text ?? '';
}

describe('HostTurnStop', () => {
  it('cancels the explicit session and reports the paused goal', async () => {
    const { hostStop, sendResult, cancel } = makeHostStop();

    await hostStop.handleCardAction({ sessionId: SID, agent: 'dsh', cwd: CWD }, ctx);

    expect(cancel).toHaveBeenCalledWith(SID);
    const text = sentText(sendResult);
    expect(text).toContain('已终止 DSH 会话');
    expect(text).toContain('目标已暂停');
  });

  it('rejects a non-DSH agent without touching a runner', async () => {
    const { hostStop, sendResult, getRunner } = makeHostStop();

    await hostStop.handleCardAction({ sessionId: SID, agent: 'claude', cwd: CWD }, ctx);

    expect(getRunner).not.toHaveBeenCalled();
    expect(sentText(sendResult)).toContain('不支持终止宿主轮次');
  });

  it('reports a missing session instead of cancelling an unrelated one', async () => {
    const { hostStop, sendResult, getRunner } = makeHostStop({
      store: makeStore({ sessionId: '' }),
    });

    await hostStop.handleCardAction({ agent: 'dsh', cwd: CWD }, ctx);

    expect(getRunner).not.toHaveBeenCalled();
    expect(sentText(sendResult)).toContain('没有可终止的会话');
  });

  it('stopCurrent uses the current cwd/session for DSH', async () => {
    const { hostStop, cancel } = makeHostStop();

    const result = await hostStop.stopCurrent('user1');

    expect(cancel).toHaveBeenCalledWith(SID);
    expect(result).toMatchObject({
      status: 'cancelled',
      sessionId: SID,
      agentKind: 'dsh',
      goalPhase: 'paused',
    });
  });

  it('stopCurrent is a no-op for non-DSH agents', async () => {
    const { hostStop, getRunner } = makeHostStop({ defaultAgent: 'claude' });

    expect(await hostStop.stopCurrent('user1')).toBeUndefined();
    expect(getRunner).not.toHaveBeenCalled();
  });

  it('formats unconfirmed results without over-promising', () => {
    const text = formatHostStopResult({
      status: 'unconfirmed',
      sessionId: SID,
      agentKind: 'dsh',
      detail: 'turn still open after cancel',
    });
    expect(text).toContain('未能确认');
    expect(text).toContain('可能仍在后台运行');
    expect(text).toContain('DSH Web UI');
  });
});
