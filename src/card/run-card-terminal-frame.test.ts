/**
 * 终态帧必须真的落到飞书上。
 *
 * 症状是点停止后 run 确实停了（日志有 interrupt hit / stop done），但卡片上
 * 仍留着底部「⏹ 停止」按钮；再点一次，服务端已无活跃 run（点击只留下
 * `card action: stop` 一条日志）。用户看到的是**停止前的最后一帧**。
 *
 * 通道契约：`controller.update()` 只把帧交给 @larksuite/channel 的 throttle/queue，
 * resolve 时 patch 还没发（见 `src/connector/index.ts` 的 patchWithRetry 注释）。
 * 所以终态帧必须在流关闭后再做一次整卡 patch 把它钉死。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunCardSession } from './run-card-session.js';
import { makeStreamCardConnector } from '../../tests/lib/card-stubs.js';
import { expectNoV1ActionContainer } from '../../tests/lib/card-view.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

import { mockLogger } from '../../tests/lib/logger-mock.js';

describe('RunCardSession - 终态帧确认落地', () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
  });

  it('test_anchor_finish_patches_terminal_frame_after_stream_close', async () => {
    const patched: Array<{ messageId: string; card: object }> = [];
    const { connector } = makeStreamCardConnector({ messageId: 'card-9' });
    connector.updateCard = async (messageId, card) => {
      patched.push({ messageId, card });
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-9',
    });

    await session.start();
    await session.finish('interrupted', { interruptedReason: 'user_stop' });
    expect(await session.settle()).toBe('streamed');

    // controller.update 已不保证落地 —— 必须有一次经 connector 的真实 patch。
    expect(patched.length).toBe(1);
    const card = patched[0]!.card;
    expect(patched[0]!.messageId).toBe('card-9');

    const json = JSON.stringify(card);
    expect(json).toContain('已被用户终止');
    // 终态卡不能再带底部停止按钮（点击它只会是一次无声的空转）。
    expect(json).not.toContain('⏹ 停止');
    expectNoV1ActionContainer(card);

    const infos = mockLogger.info.mock.calls.map((c) => String(c[0]));
    expect(infos.some((m) => m.includes('terminal frame confirmed'))).toBe(true);
  });

  it('test_anchor_terminal_frame_confirm_failure_does_not_break_finish', async () => {
    const { connector } = makeStreamCardConnector({ messageId: 'card-10' });
    connector.updateCard = async () => {
      throw new Error('feishu down');
    };

    const session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-10',
    });

    await session.start();
    // 确认失败只是少了一次兜底 patch，不能让收尾抛错（否则 run 卡永远停在运行态）。
    await expect(session.finish('done', { resultSubtype: 'success' })).resolves.toBeUndefined();
    await expect(session.settle()).resolves.toBe('streamed');

    const warns = mockLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warns.some((m) => m.includes('terminal frame confirm failed'))).toBe(true);
  });
});
