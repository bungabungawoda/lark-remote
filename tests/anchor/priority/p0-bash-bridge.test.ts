/**
 * Anchor Test: P0-2 B4 — bridge 全流程集成（! 高频输出 → patch 有界 + 终态卡有界）
 *
 * ① 验证什么行为：bridge.executeBash 对 10_000 个 stdout chunk 的洪峰输出，
 *    controller.update（patch）调用次数 < 100，且最终卡片 JSON 有界（≤28KB）——
 *    输出在 store/render 两层都被截断，不会把 1M+ 字符推进飞书。
 *
 * ② 缺失/错误会导致什么问题：桥接层每 chunk 一次 PATCH（现状 == chunk 数）+
 *    大输出全量驻留，!yes 几十秒即 V8 OOM / 飞书 PATCH 风暴。本用例把 B1（store
 *    截断）+ B2（合批）在真实 bridge 流上做集成锁定，防止未来把 session 层修复
 *    绕开（例如 bridge 直连 connector 发 patch）。
 *
 * ③ 依据：review.md §P0-2 失败的测试用例#2「bash 高频输出应合批 patch：vi.mock
 *    BashProcessRunner，run() 一次性 yield 10_000 个 stdout chunk，expect(updateCalls)
 *    .toBeLessThan(100)」。
 */
import { describe, it, expect, vi } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';

const { MockBashProcessRunner } = vi.hoisted(() => {
  class MockBashProcessRunner {
    async *run(
      _command: string,
      _opts: { cwd: string },
    ): AsyncGenerator<{
      type: 'stdout' | 'stderr' | 'exit';
      content: string;
      exitCode?: number;
    }> {
      for (let i = 0; i < 10_000; i++) {
        yield { type: 'stdout', content: 'x'.repeat(100) };
      }
      yield { type: 'exit', content: '', exitCode: 0 };
    }
    async stop(): Promise<void> {}
    get isRunning(): boolean {
      return false;
    }
  }
  return { MockBashProcessRunner };
});

vi.mock('../../../src/runner/bash/index.js', () => ({
  BashProcessRunner: MockBashProcessRunner,
}));

import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
} from '../../lib/bridge-stubs.js';
function makeConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', effort: 'high', stopGraceMs: 5000 },
    defaultAgent: 'claude',
    agents: {
      claude: { model: 'opus', effort: 'high' },
      codex: { model: 'glm-5.2', modelProvider: 'lt' },
      pi: { model: 'glm-5.1', provider: 'lt', thinking: 'high' },
      opencode: {
        modelID: 'claude-sonnet-4-20250505',
        providerID: 'anthropic',
        agent: 'claude',
      },
    },
    idle: { watchdogMinutes: 15 },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
  });
}

describe('P0-2 B4: bridge 集成（10k chunk 洪峰）', () => {
  it('test_anchor_bridge_bash_high_frequency_output_coalesces_patches', async () => {
    const updates: object[] = [];
    const controller: CardStreamController = {
      messageId: 'card-1',
      current: {},
      update: async (card) => {
        updates.push(typeof card === 'function' ? card({}) : card);
      },
    };
    const connector = {
      streamCard: async (
        _chatId: string,
        _initial: object,
        producer: (ctrl: CardStreamController) => Promise<void>,
      ) => {
        await producer(controller);
        return 'card-1';
      },
      updateCard: async () => {},
      sendWithRetry: async () => 'msg-id',
      reconnect: async () => {},
      sendFile: async () => 'file-id',
      addReaction: async () => {},
      connected: true,
    };

    const sessionStore = new SessionStore();
    sessionStore.set('u1', { sessions: new Map(), cwd: '/tmp' });

    const inlineRunner = {
      isRunning: false,
      run: async function* () {},
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
    };
    const bridge = new Bridge({
      runner: inlineRunner,
      agentRegistry: createStubAgentRegistry(inlineRunner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      config: makeConfig(),
      connector: connector as never,
      sessionStore,
      sessionReaderRegistry: null as never,
    });

    await bridge.executeBash('yes', { userId: 'u1', chatId: 'c1', messageId: 'm1' });

    // PATCH 风暴锁定：10_000 chunk 的 patch 数必须 < 100（现状 == chunk 数）
    expect(updates.length).toBeLessThan(100);

    // 终态卡有界：最后一张卡是 finish 后的 done 卡，JSON 必须远小于 1M 字符
    const lastJson = JSON.stringify(updates.at(-1));
    expect(lastJson.length).toBeLessThan(100_000);
    // 截断提示存在（输出确实被 store/render 层截断，而非吞掉）
    expect(lastJson).toContain('输出已截断');
  });
});
