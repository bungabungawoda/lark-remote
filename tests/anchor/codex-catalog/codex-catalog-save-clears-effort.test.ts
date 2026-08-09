import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema, setConfigValues } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Bridge } from '../../../src/bridge/index.js';
import type { SessionReaderRegistry } from '../../../src/session/registry.js';
import { invalidateCodexBundledCache } from '../../../src/config/codex-config.js';
import { buildCodexExecArgs } from '../../../src/runner/codex/argv.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 16 - Anchor（codex-y review4 P1 + P3-10 保存路径）
 *
 * P1: 切换到档位为空/未知模型时，handleFieldChange 产出 value=undefined 的档位补丁。
 *     router 的 setNestedValue 必须把 undefined 当作"删除键"，diffConfig 必须把
 *     "已删除"表达为 undefined（而非 String(undefined)="undefined"），setConfigValues
 *     必须从 YAML 中删除该键——否则 config.yaml 会写入字面量 "undefined"，
 *     下一次 run 透传 `-c model_reasoning_effort="undefined"` 被 codex 解析为
 *     ReasoningEffort::Custom("undefined") 直接发给 API（openai_models.rs:133、
 *     session/mod.rs:677）。
 *
 * Spec basis: codex-y review4 P1 + codex 源码 openai_models.rs/session/mod.rs。
 */

const { mockExecFileSync, mockLogger } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));
vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

const ACTIVE_CATALOG_JSON = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
    description: 'Latest frontier agentic coding model.',
  }),
]);

type RouterInternals = {
  pendingConfig?: AppConfig | null;
  ensurePendingConfig: () => void;
  diffConfig: (original: AppConfig, pending: AppConfig) => Record<string, string | undefined>;
  setNestedValue: (target: AppConfig, key: string, value: unknown) => void;
};

function createMockBridge(): Bridge {
  return {
    sendResult: vi.fn().mockResolvedValue(undefined),
    forwardToClaude: vi.fn().mockResolvedValue(undefined),
    isBusy: false,
    isBusyFor: vi.fn().mockReturnValue(false),
    enqueue: vi.fn(),
    interruptCurrentRun: vi.fn().mockResolvedValue(false),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setConfig: vi.fn(),
    setIdleTimeout: vi.fn(),
    removeFromQueue: vi.fn().mockReturnValue(false),
    updateCardInPlace: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    getQueuedTasks: vi.fn().mockReturnValue([]),
    getQueuedTask: vi.fn().mockReturnValue(undefined),
    getQueueInfo: vi.fn().mockReturnValue({ position: 0, isRunning: false, tasksAhead: 0 }),
    getAllActiveRuns: vi.fn().mockReturnValue(new Map()),
    sendFile: vi.fn().mockResolvedValue(''),
    getActiveRunFor: vi.fn().mockReturnValue(undefined),
    clearRunners: vi.fn(),
  } as unknown as Bridge;
}

function createMockSessionReaderRegistry(): SessionReaderRegistry {
  return {
    listRegistered: vi.fn().mockReturnValue(['claude', 'codex']),
    get: vi.fn(),
  } as unknown as SessionReaderRegistry;
}

function buildCodexConfig(model: string, reasoningEffort: string): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'codex',
    agents: {
      codex: {
        binary: 'codex',
        model,
        modelProvider: 'deepseek',
        reasoningEffort,
        stopGraceMs: 5000,
      },
    },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    idle: { watchdogMinutes: 15 },
    logging: { level: 'info' },
  });
}

describe('codex catalog save clears effort - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;
  let configPath: string;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-save-clear-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        `model_catalog_json = "${path.join(tmpDir, 'models.json')}"`,
        '',
        '[model_providers.deepseek]',
        'name = "deepseek"',
        'env_key = "DS_API_KEY"',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, 'models.json'), ACTIVE_CATALOG_JSON);
    configPath = path.join(tmpDir, 'config.yaml');
    process.env.CODEX_HOME = tmpDir;
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        return ACTIVE_CATALOG_JSON;
      }
      return makeCatalog([makeModel('gpt-5.2', [{ effort: 'medium' }])]);
    });
  });

  afterEach(() => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateCodexBundledCache();
  });

  it('test_anchor_effort_clear_is_delete_not_literal_undefined_through_save_path', async () => {
    const config = buildCodexConfig('deepseek-v4-flash', 'high');
    const router = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge(),
      config,
      configPath,
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    });
    const internals = router as unknown as RouterInternals;

    // 切到未知模型（目录无档位元数据、无声明 default）→ 档位应被清空
    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'unknown-model' },
      { userId: 'u1', chatId: 'c1', messageId: 'm1' },
    );

    expect(internals.pendingConfig?.agents?.codex?.model).toBe('unknown-model');
    // 删除语义：键必须从 pendingConfig 中移除，而不是值为 undefined 或字符串 "undefined"
    expect(
      Object.prototype.hasOwnProperty.call(
        internals.pendingConfig?.agents?.codex,
        'reasoningEffort',
      ),
    ).toBe(false);

    // diffConfig：已删除的键表达为 undefined，绝不能变成 "undefined"
    const updates = internals.diffConfig(config, internals.pendingConfig!);
    expect(updates['agents.codex.reasoningEffort']).toBeUndefined();
    expect(updates['agents.codex.reasoningEffort']).not.toBe('undefined');
    expect(updates['agents.codex.model']).toBe('unknown-model');

    // setConfigValues：删除键，不写入 "undefined" 字面量
    const saved = setConfigValues(configPath, config, updates);
    expect(saved.agents?.codex?.reasoningEffort).toBeUndefined();
    const yamlContent = fs.readFileSync(configPath, 'utf-8');
    expect(yamlContent).not.toContain('reasoningEffort');
    expect(yamlContent).not.toContain('undefined');

    // runner 侧：reasoningEffort 为 undefined 时不透传 effort（argv 短路）
    const argv = buildCodexExecArgs({
      cwd: '/tmp',
      model: 'unknown-model',
      modelProvider: 'deepseek',
      reasoningEffort: saved.agents?.codex?.reasoningEffort,
    });
    expect(argv.join(' ')).not.toContain('model_reasoning_effort');
  });
});
