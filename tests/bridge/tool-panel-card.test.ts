import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore, SessionReaderRegistry } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { AgentEvent, Runner } from '../../src/runner/index.js';
import type { SpawnOptions } from '../../src/runner/types.js';
import { createRouterFixture } from '../lib/router-fixture.js';
import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
} from '../lib/bridge-stubs.js';

vi.mock('../../src/logger/index.js', async () =>
  (await import('../lib/logger-mock.js')).loggerModuleMock(),
);

/**
 * 终态卡上「停止后台任务」的端到端路径。
 *
 * 为什么必须走完整 run：后台任务的生命周期跨 run（这正是它需要单独入口的原
 * 因），点按钮时 activeRuns 早已清空，只能靠 finalize 时留下的 state 快照找回
 * sessionId/cwd/agentKind 与 runner。这条链（finalize 挖快照 → 按钮 payload →
 * 路由解析 → runner 真正 kill → 就地重渲染）跨越 bridge + router + runner 三层，
 * 任何一层漏了都只剩"点了没反应"，单测各层都发现不了。
 */
function createStreamingRunner(events: AgentEvent[]): Runner & { runCalls: SpawnOptions[] } {
  const runCalls: SpawnOptions[] = [];
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    runCalls,
    run: async function* (_message: string, opts: SpawnOptions) {
      runCalls.push(opts);
      for (const event of events) yield event;
    },
  };
}

let tmpRoot: string;
let config: AppConfig;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-tool-panel-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    cwd: { default: '' },
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('background job kill (terminal card)', () => {
  /** 一次带后台任务事件的完整 run（init → background_jobs → result）。 */
  const JOB_EVENTS: AgentEvent[] = [
    { type: 'system', subtype: 'init', session_id: 'session-jobs', cwd: '/tmp/ws', model: 'opus' },
    {
      type: 'background_jobs',
      jobs: [
        { id: 'bash-1', label: 'npm run dev', status: 'running' },
        { id: 'bash-2', label: 'watch tests', status: 'running' },
      ],
    },
    { type: 'result', subtype: 'success', session_id: 'session-jobs' },
  ];

  async function runOnce() {
    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    sessionStore.setCwd('user1', tmpRoot);
    const killed: Array<{ sessionId: string; jobId: string }> = [];
    const runner = {
      ...createStreamingRunner(JOB_EVENTS),
      killJob: async (sessionId: string, jobId: string) => {
        killed.push({ sessionId, jobId });
        return true;
      },
    } as Runner;
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const router = createRouterFixture({
      tmpDir: tmpRoot,
      config,
      bridge,
      sessionStore,
      sessionReaderRegistry: new SessionReaderRegistry(),
    }).router;
    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
    await bridge.forwardToClaude('hello', ctx);
    return { connector, router, ctx, killed };
  }

  it('test_anchor_kill_click_reaches_the_runner_and_drops_the_job_from_the_card', async () => {
    const { connector, router, ctx, killed } = await runOnce();

    const terminalJson = JSON.stringify(connector._cards[connector._cards.length - 1]);
    expect(terminalJson).toContain('"cmd":"job.kill"');
    expect(terminalJson).toContain('npm run dev');

    const runId = /"runId":"([^"]+)"/.exec(terminalJson)?.[1];
    expect(runId).toBeTruthy();

    const before = connector._updates.length;
    await router.handleCardAction({ cmd: 'job.kill', runId, jobId: 'bash-1' }, ctx);

    // runner 拿到了真实 sessionId（不是卡片上抄的参数）
    expect(killed).toEqual([{ sessionId: 'session-jobs', jobId: 'bash-1' }]);

    // 同一张卡就地重渲染，且被杀掉的任务不再留在卡片上
    expect(connector._updates.length).toBe(before + 1);
    const patched = connector._updates[connector._updates.length - 1];
    expect(patched.messageId).toBe(ctx.messageId);
    const patchedJson = JSON.stringify(patched.card);
    expect(patchedJson).not.toContain('npm run dev');
    expect(patchedJson).toContain('watch tests');
    expect(patchedJson).toContain('🧵 **后台任务** 1 个仍在运行');
  });

  it('tells the user when the job record is gone instead of failing silently', async () => {
    const { connector, router, ctx } = await runOnce();
    const before = connector._sent.length;
    await router.handleCardAction({ cmd: 'job.kill', runId: 'run-unknown', jobId: 'bash-9' }, ctx);
    const texts = connector._sent
      .slice(before)
      .map((s) => JSON.stringify(s.input))
      .join('\n');
    expect(texts).toContain('停止失败');
  });
});
