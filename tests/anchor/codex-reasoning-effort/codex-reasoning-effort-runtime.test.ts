import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';

/**
 * Red Agent - Round 1 - Anchor (Bug 模式)
 *
 * Target: reasoningEffort 运行时修改必须生效——
 *   1. Bridge.getAgentRunOptions() 必须为 codex 提取 reasoningEffort
 *   2. CodexExecRunner.run() 必须使用 per-run opts.reasoningEffort（优先于 constructor 值）
 *
 * Importance: 用户在 /config 卡片修改"推理强度"后，若不生效则功能完全失效。
 *   根因：getAgentRunOptions 不提取 reasoningEffort + SpawnOptions 无此字段 +
 *   runner.run() 只读 constructor 字段。三层断链。
 *
 * Spec basis: CLAUDE.md "Codex 推理强度配置" — "存储在 agents.codex.reasoningEffort"
 *   + router config.set 切换模型时自动重置 reasoningEffort 的逻辑依赖运行时生效。
 *
 * Pyramid: L1 (unit) — 验证 getAgentRunOptions 返回值 + runner 参数传递
 */

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

let tmpDir: string;
let baseConfig: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-effort-runtime-'));
  baseConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { binary: 'claude', model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'codex',
    agents: {
      codex: {
        binary: 'codex',
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: 'high',
      },
    },
    idle: { watchdogMinutes: 15 },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P1: reasoningEffort runtime propagation', () => {
  /**
   * 验证 Bridge.getAgentRunOptions() 为 codex 提取 reasoningEffort。
   * 缺失/错误：用户改推理强度后 bridge 不传新值，runner 用旧值。
   */
  it('test_anchor_getAgentRunOptions_extracts_codex_reasoningEffort', () => {
    const connector = {
      sendWithRetry: vi.fn().mockResolvedValue('msg-id'),
      reconnect: async () => {},
      addReaction: async () => {},
      streamCard: vi.fn().mockResolvedValue('msg-id'),
      updateCard: vi.fn().mockResolvedValue(undefined),
      connected: true,
    };

    const sessionStore = new SessionStore();
    const mockRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {},
    };

    const mockRegistry = {
      get: () => mockRunner,
      isRegistered: () => true,
      listRegistered: () => ['codex'],
      setConfigContainer: () => {},
      getConfigContainer: () => ({ current: baseConfig }),
    };

    const bridge = new Bridge({
      runner: {
        isRunning: false,
        run: async function* () {},
        stop: async () => {},
        killOrphan: () => {},
        registerExitHandlers: () => {},
      },
      config: baseConfig,
      connector: connector as any,
      sessionStore,
      agentRegistry: mockRegistry as any,
      sessionReaderRegistry: null as any,
    });

    const agentOpts = (bridge as any).getAgentRunOptions();

    // ← RED: 当前 getAgentRunOptions 的 codex case 不提取 reasoningEffort
    expect(agentOpts.reasoningEffort).toBe('high');
  });

  /**
   * 验证运行时修改 reasoningEffort 后 getAgentRunOptions 返回新值。
   * 缺失/错误：setConfig 后仍返回旧值 → 功能失效。
   */
  it('test_anchor_getAgentRunOptions_reflects_runtime_reasoningEffort_change', () => {
    const connector = {
      sendWithRetry: vi.fn().mockResolvedValue('msg-id'),
      reconnect: async () => {},
      addReaction: async () => {},
      streamCard: vi.fn().mockResolvedValue('msg-id'),
      updateCard: vi.fn().mockResolvedValue(undefined),
      connected: true,
    };

    const sessionStore = new SessionStore();
    const mockRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {},
    };

    const mockRegistry = {
      get: () => mockRunner,
      isRegistered: () => true,
      listRegistered: () => ['codex'],
      setConfigContainer: () => {},
      getConfigContainer: () => ({ current: baseConfig }),
    };

    const bridge = new Bridge({
      runner: {
        isRunning: false,
        run: async function* () {},
        stop: async () => {},
        killOrphan: () => {},
        registerExitHandlers: () => {},
      },
      config: baseConfig,
      connector: connector as any,
      sessionStore,
      agentRegistry: mockRegistry as any,
      sessionReaderRegistry: null as any,
    });

    // 初始值
    let agentOpts = (bridge as any).getAgentRunOptions();
    expect(agentOpts.reasoningEffort).toBe('high');

    // 模拟 /config 卡片修改 reasoningEffort → setConfig
    const updatedConfig: AppConfig = {
      ...baseConfig,
      agents: {
        ...baseConfig.agents,
        codex: {
          ...baseConfig.agents!.codex!,
          reasoningEffort: 'xhigh',
        },
      },
    };
    bridge.setConfig(updatedConfig);

    agentOpts = (bridge as any).getAgentRunOptions();
    // ← RED: setConfig 后应返回新值 'xhigh'
    expect(agentOpts.reasoningEffort).toBe('xhigh');
  });

  /**
   * 验证 CodexExecRunner.run() 使用 per-run opts.reasoningEffort 优先于 constructor 值。
   * 缺失/错误：runner 只读 constructor 字段，per-run override 无效。
   *
   * 策略：mock spawn 捕获 args，用 EventEmitter + PassThrough 模拟子进程，
   * 立即 emit 'close' 让 generator 完成。
   */
  it('test_anchor_codex_runner_uses_per_run_reasoningEffort', async () => {
    const { PassThrough } = await import('node:stream');
    const { EventEmitter } = await import('node:events');

    let capturedArgs: string[] | null = null;

    spawnMock.mockImplementation((_binary: string, args: string[]) => {
      capturedArgs = args;
      const proc = new EventEmitter() as any;
      proc.pid = 12345;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = { write: () => {}, end: () => {} };
      proc.kill = () => {};
      proc.removeAllListeners = () => proc;
      // 立即关闭流和进程，让 generator 完成
      process.nextTick(() => {
        proc.stdout.end();
        proc.stderr.end();
        proc.emit('close', 0, null);
      });
      return proc;
    });

    const { CodexExecRunner } = await import('../../../src/runner/codex/index.js');

    // constructor 设置 reasoningEffort: 'low'
    const runner = new CodexExecRunner({
      workspace: 'test',
      binary: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
      stopGraceMs: 1000,
      pidDir: tmpDir,
      sessionReader: {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => null,
        readSessionContent: () => ({ events: [] }),
        isSessionActive: () => false,
      } as any,
    });

    // run() 传入 per-run reasoningEffort: 'high'
    const gen = runner.run('test message', {
      cwd: tmpDir,
      reasoningEffort: 'high',
    } as any);

    // 消费 generator 直到结束
    for await (const _event of gen) {
      // drain
    }

    // ← RED: spawn args 应包含 model_reasoning_effort="high"（per-run），
    //   当前 runner 用 this.reasoningEffort='low'
    expect(capturedArgs).toBeTruthy();
    const effortArg = capturedArgs!.find(
      (a) => typeof a === 'string' && a.includes('model_reasoning_effort'),
    );
    expect(effortArg).toBe('model_reasoning_effort="high"');

    spawnMock.mockReset();
  });
});
