import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBridge } from '../../tests/lib/bridge-stubs.js';
import { rmRf } from '../../tests/lib/tmp-cleanup.js';
import type { AgentEvent, Runner } from '../runner/index.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

/**
 * 2026-10-21 现场：60 步、10 分钟的 turn 在最后一步被上游内容审核截断
 * （`finish_reason: content_filter`）。DSH 把它归一成 PI_AI_ERROR，既不在默认
 * 重试码里，也不会换模型；桥侧只把英文报文透传成「运行出错」。
 *
 * 修复目标是桥侧两条：错误卡说清楚「谁拦的 / 改动还在 / 下一步」，以及同一
 * session 自动续跑一次（审核是概率判定，重采样通常能过）。这两个用例钉住的
 * 就是「续一次、不多续、别的错误不续」。
 */

interface ScriptedRunner extends Runner {
  prompts: string[];
  calls: number;
}

function createScriptedRunner(
  scripts: AgentEvent[][],
  onRun?: (callIndex: number) => void,
): ScriptedRunner {
  const prompts: string[] = [];
  let calls = 0;
  const runner: ScriptedRunner = {
    isRunning: false,
    prompts,
    get calls() {
      return calls;
    },
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* (message: string) {
      const callIndex = calls;
      calls += 1;
      prompts.push(message);
      onRun?.(callIndex);
      const events = scripts[Math.min(callIndex, scripts.length - 1)] ?? [];
      for (const event of events) yield event;
    },
  };
  return runner;
}

const initEvent = (sessionId: string): AgentEvent =>
  ({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: '/tmp',
    model: 'DSH',
  }) as AgentEvent;

/** DSH translator 对 turn/end=error 的产出形状（content_filter 现场原文）。 */
const contentFilterResult = (sessionId: string): AgentEvent =>
  ({
    type: 'result',
    subtype: 'error',
    session_id: sessionId,
    errorMessage: 'turn ended with reason: error: Provider finish_reason: content_filter',
  }) as AgentEvent;

const otherErrorResult = (sessionId: string): AgentEvent =>
  ({
    type: 'result',
    subtype: 'error',
    session_id: sessionId,
    errorMessage: 'turn ended with reason: error: DSH HTTP 401 for session.create',
  }) as AgentEvent;

const successResult = (sessionId: string): AgentEvent =>
  ({ type: 'result', subtype: 'success', session_id: sessionId }) as AgentEvent;

/** 纯文本消息（sendResult({text})）内容。 */
function sentTexts(connector: { _sent: Array<{ input: unknown }> }): string[] {
  return connector._sent
    .map((entry) => (entry.input as { text?: string }).text)
    .filter((text): text is string => typeof text === 'string');
}

let tmpDir: string;
const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-cf-retry-')));
});

afterEach(() => {
  rmRf(tmpDir);
});

describe('Bridge content_filter 自动续跑', () => {
  it('被截断后自动续跑一次，并先告知用户', async () => {
    const runner = createScriptedRunner([
      [initEvent('s-cf'), contentFilterResult('s-cf')],
      [initEvent('s-cf'), successResult('s-cf')],
    ]);
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('把 A1 落地', ctx);

    expect(runner.calls).toBe(2);
    expect(runner.prompts[0]).toBe('把 A1 落地');
    expect(runner.prompts[1]).toContain('自动继续');
    expect(runner.prompts[1]).toContain('content_filter');
    expect(sentTexts(connector).join('\n')).toContain('已自动重试一次');
    // 续跑成功：最后一张卡是完成态，不是错误卡
    expect(JSON.stringify(connector._cards.at(-1))).toContain('已完成');
  });

  it('续跑仍被截断 → 停在错误卡，不无限重试', async () => {
    const runner = createScriptedRunner([[initEvent('s-cf2'), contentFilterResult('s-cf2')]]);
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('把 A1 落地', ctx);

    expect(runner.calls).toBe(2);
    // 只发一次「已自动重试」通知
    const notices = sentTexts(connector).filter((text) => text.includes('已自动重试一次'));
    expect(notices).toHaveLength(1);
    const lastCard = JSON.stringify(connector._cards.at(-1));
    expect(lastCard).toContain('服务方内容审核拦截');
    expect(lastCard).not.toContain('运行出错');
  });

  it('其它错误不触发续跑', async () => {
    const runner = createScriptedRunner([[initEvent('s-401'), otherErrorResult('s-401')]]);
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('继续', ctx);

    expect(runner.calls).toBe(1);
    expect(sentTexts(connector).join('\n')).not.toContain('自动重试');
    expect(JSON.stringify(connector._cards.at(-1))).toContain('运行出错');
  });

  it('运行期间会话指针被 /new 移动 → 不续跑（否则会把旧会话接回来）', async () => {
    let bumpEpoch = (): void => {};
    const runner = createScriptedRunner(
      [[initEvent('s-moved'), contentFilterResult('s-moved')]],
      () => bumpEpoch(),
    );
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    sessionStore.setCwd(ctx.userId, tmpDir);
    // 首轮 run 开始后模拟 /new：代际 +1
    bumpEpoch = () => sessionStore.bumpSessionEpoch(ctx.userId, 'claude');

    await bridge.forwardToClaude('把 A1 落地', ctx);

    expect(runner.calls).toBe(1);
    expect(sentTexts(connector).join('\n')).not.toContain('已自动重试一次');
    expect(JSON.stringify(connector._cards.at(-1))).toContain('服务方内容审核拦截');
  });
});
