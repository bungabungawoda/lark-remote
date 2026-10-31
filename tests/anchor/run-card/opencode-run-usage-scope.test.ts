/**
 * Run 卡片 usage scope（opencode）：卡片"本 run"必须是本次 run 内所有模型
 * 请求之和，不是末次请求。
 *
 * 真实链路：OpencodeSessionReader（v2 export）→ registry → Bridge → 卡片渲染。
 * 回归背景（2026-10-30）：一条 25 次请求的 run，卡片显示 input=543 / output=1,250
 * （= 末次请求），真实消耗是 input=20,040 / output=10,358；相邻两张卡的"累计"
 * 差值反而与真实消耗一致，用户据此发现卡片统计不对。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { OpencodeSessionReader } from '../../../src/session/opencode/sessions.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Runner } from '../../../src/runner/index.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
} from '../../lib/bridge-stubs.js';
import { asAgentRunner } from '../../lib/agent-runner.js';

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

let workDir: string;
let config: AppConfig;

beforeEach(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-usage-scope-')));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'opencode',
  });
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

/** v2 export：上一个 turn 已 idle 收尾，当前 turn 有两次模型请求（无收尾 idle）。 */
function v2ExportJson(): string {
  return JSON.stringify({
    info: { id: 'ses_oc_scope', title: 'scope', location: { directory: workDir } },
    messages: [
      { id: 'm1', type: 'user', time: { created: 1 }, text: 'old turn' },
      {
        id: 'm2',
        type: 'assistant',
        time: { created: 2 },
        content: [{ type: 'text', text: 'old answer' }],
        tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 5000, write: 200 } },
      },
      { id: 'm3', type: 'idle', time: { created: 3 }, outcome: 'succeeded' },
      { id: 'm4', type: 'user', time: { created: 4 }, text: 'current turn' },
      {
        id: 'm5',
        type: 'assistant',
        time: { created: 5 },
        content: [{ type: 'text', text: 'step 1' }],
        tokens: { input: 300, output: 30, reasoning: 0, cache: { read: 600, write: 10 } },
      },
      {
        id: 'm6',
        type: 'assistant',
        time: { created: 6 },
        content: [{ type: 'text', text: 'step 2' }],
        tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 400, write: 5 } },
      },
    ],
  });
}

async function runBridge(sessionId: string) {
  const registry = new SessionReaderRegistry();
  registry.register(
    'opencode',
    new OpencodeSessionReader({ cacheTtlMs: 0, captureExport: () => v2ExportJson() }),
  );

  const connector = createStubConnector();
  const sessionStore = new SessionStore();
  const runner = asAgentRunner(
    createStubRunner({
      mode: 'streaming',
      events: [
        {
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          cwd: workDir,
          model: 'opencode-go/deepseek-v4.1-flash',
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
        { type: 'result', subtype: 'success', session_id: sessionId },
      ],
    }) as Runner,
    'opencode',
    { model: 'opencode-go/deepseek-v4.1-flash' },
  );
  const bridge = new Bridge({
    agentRegistry: createStubAgentRegistry(runner),
    connector,
    sessionStore,
    config,
    sessionReaderRegistry: registry,
  });
  sessionStore.setCwd(ctx.userId, workDir);

  await bridge.forwardToClaude('hello', ctx);
  return connector;
}

describe('run card usage scope (opencode)', () => {
  it('test_anchor_opencode_done_card_sums_every_request_of_the_run', async () => {
    const connector = await runBridge('ses_oc_scope');
    const finalCard = JSON.stringify(connector._cards.at(-1));

    // 本 run = 末个 turn 两次请求之和：input 300+200、output 30+20。
    expect(finalCard).toContain('Input token - 500');
    expect(finalCard).toContain('Output token - 50');
    // 累计仍应是整条会话（含上一个 turn）。
    expect(finalCard).toContain('· 累计 2K');
    expect(finalCard).toContain('· 累计 150');
    // contextLength 仍是末次请求的窗口水位（200+20+400+5），不求和。
    expect(finalCard).toContain('Context - 625');
    // 反回归：末次请求的单点值（200 / 20）不再冒充本 run。
    expect(finalCard).not.toContain('Input token - 200');
    expect(finalCard).not.toContain('Output token - 20');
  });
});
