import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import { CommandRouter } from './router/index.js';
import { Bridge } from './bridge/index.js';
import { SessionStore } from './session/index.js';
import { AppConfigSchema, loadConfig, setConfigValue } from './config/index.js';
import type { AppConfig } from './config/index.js';
import type { AgentEvent, Runner } from './runner/index.js';

import {
  createStubAgentRegistry,
  createStubConnector,
  createStubSessionReaderRegistry,
} from '../tests/lib/bridge-stubs.js';
// Stub session reader for tests

// --- Stub helpers ---

interface CapturedSpawn {
  message: string;
  cwd: string;
  sessionId?: string;
}

function createCapturingRunner(events: AgentEvent[], capture: CapturedSpawn[]): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* (message: string, opts: { cwd: string; sessionId?: string }) {
      capture.push({ message, cwd: opts.cwd, sessionId: opts.sessionId });
      for (const e of events) yield e;
    },
  };
}

function createCrashingRunner(error: Error): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      throw error;
    },
  };
}

let tmpDir: string;
let workspaceFile: string;
let configFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-integration-'));
  workspaceFile = path.join(tmpDir, 'workspace.json');
  configFile = path.join(tmpDir, 'config.yaml');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildConfig(overrides?: Partial<AppConfig>): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'claude-opus-4-8',
      stopGraceMs: 5000,
    },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
      ...overrides?.output,
    },
    ...overrides,
  });
}

function createRouter(opts: {
  runner: Runner;
  config?: Partial<AppConfig>;
  workspacePath?: string;
}) {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const config = buildConfig(opts.config);
  const router = new CommandRouter({
    sessionStore,
    bridge: new Bridge({
      runner: opts.runner,
      agentRegistry: createStubAgentRegistry(opts.runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    }),
    config,
    configPath: configFile,
    workspacePath: opts.workspacePath ?? workspaceFile,
    sessionReaderRegistry: createStubSessionReaderRegistry(),
  });
  return { router, sessionStore, connector, config };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

// --- 端到端流程 ---

describe('端到端流程', () => {
  it('飞书发送 "hello" → 收到 claude 回复', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello from claude!' }] } },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];
    const capture: CapturedSpawn[] = [];
    const { router, sessionStore, connector } = createRouter({
      runner: createCapturingRunner(events, capture),
    });
    sessionStore.setCwd('user1', tmpDir);

    await router.handle('hello', ctx);

    // claude was invoked with the user's message
    expect(capture[0].message).toBe('hello');
    // The run card was sent via streaming (initial push + update pushes in _sent)
    expect(connector._sent.length).toBeGreaterThan(0);
    const finalCard = JSON.stringify(connector._cards.at(-1));
    expect(finalCard).toContain('Hello from claude!');
    expect(finalCard).toContain('success');
  });

  it('多轮 tool use：showToolUse=true 时展示工具调用，=false 时隐藏', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.txt' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'file content', is_error: false },
          ],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done reading' }] } },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];

    // showToolUse true → tool name appears in sent messages
    const captureShow: CapturedSpawn[] = [];
    const show = createRouter({
      runner: createCapturingRunner(events, captureShow),
      config: {
        output: {
          showThinking: true,
          showToolUse: true,
          showToolResult: false,
        },
      },
    });
    show.sessionStore.setCwd('user1', tmpDir);
    await show.router.handle('read the file', ctx);
    const showText = JSON.stringify(show.connector._cards.at(-1));
    expect(showText).toContain('Read');

    // showToolUse false → tool name hidden, only final text + result
    const captureHide: CapturedSpawn[] = [];
    const hide = createRouter({
      runner: createCapturingRunner(events, captureHide),
      config: {
        output: {
          showThinking: true,
          showToolUse: false,
          showToolResult: false,
        },
      },
    });
    hide.sessionStore.setCwd('user1', tmpDir);
    await hide.router.handle('read the file', ctx);
    const hideText = JSON.stringify(hide.connector._cards.at(-1));
    expect(hideText).not.toContain('Read');
    expect(hideText).toContain('done reading');
  });

  it('/new 后新对话不包含旧上下文（下次不带 --resume）', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];
    const capture: CapturedSpawn[] = [];
    const { router, sessionStore } = createRouter({
      runner: createCapturingRunner(events, capture),
    });
    sessionStore.setCwd('user1', tmpDir);

    // first message → establishes session
    await router.handle('first', ctx);
    expect(capture[0].sessionId).toBeUndefined();
    expect(sessionStore.getSessionId('user1')).toBe('s1');

    // /new clears session (deletes entry entirely per §4.1)
    await router.handle('/new', ctx);
    expect(sessionStore.getSessionId('user1')).toBeUndefined();

    // User stays in the same cwd; restore it, then send a new message.
    // The key assertion: no --resume is passed (no old context).
    sessionStore.setCwd('user1', tmpDir);
    await router.handle('second', ctx);
    expect(capture[1].sessionId).toBeUndefined();
  });

  it('/cd 后 claude 在新目录工作', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];
    const capture: CapturedSpawn[] = [];
    const { router, sessionStore } = createRouter({
      runner: createCapturingRunner(events, capture),
    });
    const newDir = path.join(tmpDir, 'newdir');
    fs.mkdirSync(newDir);
    sessionStore.setCwd('user1', tmpDir);

    await router.handle(`/cd ${newDir}`, ctx);
    // sessionId cleared after /cd (§9.1): getSessionId returns undefined for empty
    expect(sessionStore.getSessionId('user1')).toBeUndefined();

    await router.handle('work here', ctx);
    // cmdCd canonicalizes via realpathSync so cwd matches Claude JSONL cwd.
    expect(capture[0].cwd).toBe(fs.realpathSync(newDir));
  });

  it('ls.switch 卡片从 cwd 外的兄弟目录切换（2026-07-31 放宽后允许）', async () => {
    const events: AgentEvent[] = [];
    const capture: CapturedSpawn[] = [];
    const { router, sessionStore } = createRouter({
      runner: createCapturingRunner(events, capture),
    });
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-int-switch-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-int-switch-b-'));
    try {
      sessionStore.setCwd('user1', dirA);
      await router.handleCardAction({ cmd: 'ls.switch', path: dirB }, ctx);
      // Canonical cwd, and session untouched (no resume context).
      expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(dirB));
      expect(sessionStore.getSessionId('user1')).toBeUndefined();
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});

// --- 异常场景 ---

describe('异常场景', () => {
  it('claude 进程异常退出后 bridge 不崩溃，下一条消息可正常处理', async () => {
    const capture: CapturedSpawn[] = [];
    const goodEvents: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's2', cwd: tmpDir, model: 'opus' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'recovered' }] } },
      { type: 'result', subtype: 'success', session_id: 's2' },
    ];

    // First router with a crashing runner
    const { router, sessionStore, connector } = createRouter({
      runner: createCrashingRunner(new Error('claude died (exit 137)')),
    });
    sessionStore.setCwd('user1', tmpDir);

    // first message → claude crashes, error sent but bridge survives
    await router.handle('hello', ctx);
    expect(JSON.stringify(connector._cards.at(-1))).toContain('claude died (exit 137)');

    // Swap in a working runner to simulate next message succeeding.
    // We rebuild the router with the same sessionStore/connector to verify
    // the bridge recovers after a crash.
    const workingRouter = new CommandRouter({
      sessionStore,
      bridge: new Bridge({
        runner: createCapturingRunner(goodEvents, capture),
        agentRegistry: createStubAgentRegistry(createCapturingRunner(goodEvents, capture)),
        sessionReaderRegistry: createStubSessionReaderRegistry(),
        connector,
        sessionStore,
        config: buildConfig(),
      }),
      config: buildConfig(),
      configPath: configFile,
      workspacePath: workspaceFile,
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    await workingRouter.handle('hello again', ctx);
    expect(capture[0].message).toBe('hello again');
    const texts = JSON.stringify(connector._cards.at(-1));
    expect(texts).toContain('recovered');
  });

  it('bridge 异常退出后重启，残留 claude 进程被 kill', async () => {
    // Directly test WorkspaceStore + ClaudeRunner.killOrphan is covered in
    // claude-runner.test.ts. Here we verify the pid-file cleanup path the
    // bridge relies on: a stale pid file is removed after killOrphan().
    const { ClaudeRunner } = await import('./runner/index.js');
    const pidDir = path.join(tmpDir, 'pids');
    fs.mkdirSync(pidDir, { recursive: true });
    const pidFile = path.join(pidDir, 'claude-test.pid');

    // Simulate a stale pid pointing to a dead process
    fs.writeFileSync(pidFile, '999999999', 'utf-8');

    const runner = new ClaudeRunner({ workspace: 'test', pidDir });
    runner.killOrphan();

    expect(fs.existsSync(pidFile)).toBe(false);
    // A fresh runner can start (no orphan blocking)
    expect(runner.isRunning).toBe(false);
  });
});

// --- 配置持久化验证 ---

describe('配置持久化验证', () => {
  it('/config set 修改的值重启后保留', () => {
    // Write an initial config file
    const initial = buildConfig();
    fs.writeFileSync(configFile, yaml.stringify(initial), 'utf-8');

    // Mutate via setConfigValue (what /config set calls)
    const loaded1 = loadConfig(configFile);
    const updated = setConfigValue(configFile, loaded1, 'claude.model', 'claude-sonnet-4-20250514');

    expect(updated.claude.model).toBe('claude-sonnet-4-20250514');

    // Simulate restart: reload from disk
    const reloaded = loadConfig(configFile);
    expect(reloaded.claude.model).toBe('claude-sonnet-4-20250514');
  });

  it('/ws save 的别名重启后保留', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];
    const capture: CapturedSpawn[] = [];

    // First "run": save a workspace alias
    const r1 = createRouter({
      runner: createCapturingRunner(events, capture),
      workspacePath: workspaceFile,
    });
    r1.sessionStore.setCwd('user1', tmpDir);
    await r1.router.handle('/ws save proj', ctx);

    // File exists on disk
    expect(fs.existsSync(workspaceFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(workspaceFile, 'utf-8'));
    expect(raw.proj.path).toBe(tmpDir);
    expect(raw.proj.lastUsedAt).toBe(0);

    // Simulate restart: new router reading the same workspace file
    const r2 = createRouter({
      runner: createCapturingRunner(events, capture),
      workspacePath: workspaceFile,
    });
    await r2.router.handle('/ws list', ctx);

    const listInput = r2.connector._sent[0].input as {
      card: {
        body?: {
          elements: Array<{
            tag: string;
            columns?: Array<{
              elements?: Array<{ behaviors?: Array<{ value: { cmd: string; name: string } }> }>;
            }>;
          }>;
        };
      };
    };
    expect(listInput.card).toBeDefined();
    const elements = listInput.card.body?.elements ?? [];
    // CardKit 2.0: column_set+column with behaviors
    const buttons = elements.flatMap((e) =>
      (e.columns ?? []).flatMap((c) => (c.elements ?? []).flatMap((b) => b.behaviors ?? [])),
    );
    const names = buttons.map((b) => b.value?.name);
    expect(names).toContain('proj');
  });
});
