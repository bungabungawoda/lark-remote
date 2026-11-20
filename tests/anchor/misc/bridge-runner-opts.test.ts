import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentEvent, Runner, SpawnOptions } from '../../../src/runner/index.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubSessionReaderRegistry,
} from '../../lib/bridge-stubs.js';

const ctx = { userId: 'user-1', chatId: 'chat-1', messageId: 'msg-1' };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-run-options-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function configFor(defaultAgent: AppConfig['defaultAgent']): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', effort: 'high', stopGraceMs: 5000 },
    defaultAgent,
    agents: {
      claude: { model: 'opus', effort: 'high' },
      codex: { model: 'glm-5.2', modelProvider: 'lt', reasoningEffort: 'xhigh' },
      pi: { model: 'glm-5.1', provider: 'lt', thinking: 'high' },
      qoder: { model: 'qfmodel', reasoningEffort: 'xhigh' },
      opencode: {
        modelID: 'claude-sonnet-4-20250505',
        providerID: 'anthropic',
        agent: 'claude',
      },
    },
    idle: { watchdogMinutes: 15 },
    logging: { level: 'info' },
  });
}

async function captureRunOptions(
  agent: AppConfig['defaultAgent'],
): Promise<SpawnOptions | undefined> {
  let captured: SpawnOptions | undefined;
  const runner: Runner = {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* (_message, opts) {
      captured = opts;
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'session-1',
        cwd: tmpDir,
        model: 'test-model',
      } as AgentEvent;
      yield { type: 'result', subtype: 'success', session_id: 'session-1' } as AgentEvent;
    },
  };
  const sessionStore = new SessionStore();
  sessionStore.setCwd(ctx.userId, tmpDir);
  const bridge = new Bridge({
    runner,
    config: configFor(agent),
    connector: createStubConnector(),
    sessionStore,
    agentRegistry: createStubAgentRegistry(runner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
  });
  await bridge.forwardToClaude('hello', ctx);
  return captured;
}

describe('Bridge run options', () => {
  it('passes claude model and effort to runner.run()', async () => {
    const opts = await captureRunOptions('claude');
    expect(opts?.model).toBe('opus');
    expect(opts?.effort).toBe('high');
  });

  it('passes codex model and reasoningEffort to runner.run()', async () => {
    const opts = await captureRunOptions('codex');
    expect(opts?.model).toBe('glm-5.2');
    expect(opts?.reasoningEffort).toBe('xhigh');
  });

  it.each(['pi', 'qoder', 'opencode'] as const)(
    'does not re-map %s constructor options onto every turn',
    async (agent) => {
      const opts = await captureRunOptions(agent);
      expect(opts?.model).toBeUndefined();
      expect(opts?.reasoningEffort).toBeUndefined();
      expect(opts?.effort).toBeUndefined();
    },
  );
});
