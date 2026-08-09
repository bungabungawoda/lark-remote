import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Bridge } from '../../../src/bridge/index.js';
import type { SessionReaderRegistry } from '../../../src/session/registry.js';
import { invalidateCodexBundledCache } from '../../../src/config/codex-config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';

/**
 * Red Agent - Round 6 - Anchor (A6)
 *
 * Target: /config 卡片（经 CommandRouter.buildConfigCard 真实渲染）在 catalog 模式下，
 * codex 分区的推理强度下拉必须恰为活动目录声明的档位 ['low','high','max']；
 * provider 下拉=内置 openai + 配置项（codex 合并内置 provider，review4 P2），不含
 * anthropic；模型下拉=活动目录模型。这是用户可见的验收面。
 *
 * Importance: config 层函数正确但卡片渲染层接错（如仍走 bundled/兜底）时，用户看到的
 * 选项依然是错的——A6 是 A1/A3 的 user-visible 闭环，防止"底层修好、UI 没跟上"。
 *
 * Spec basis: A6 —— 自定义目录场景下卡片推理强度=low/high/max、provider 无 openai、
 * model 下拉=活动目录 slug。
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

type RouterInternals = {
  buildConfigCard: () => { card: object };
};

/** Extract select_static options by callback key (CardKit 2.0). */
function extractSelectOptions(card: object, key: string): string[] {
  const values: string[] = [];

  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }

    const record = obj as Record<string, unknown>;
    if (record.tag === 'select_static') {
      const behaviors = record.behaviors as Array<{ value?: { key?: string } }> | undefined;
      const behavior = behaviors?.find((b) => b.value?.key === key);
      if (behavior) {
        const options = record.options as Array<{ value?: string }> | undefined;
        for (const opt of options ?? []) {
          if (typeof opt.value === 'string') values.push(opt.value);
        }
        return;
      }
    }

    for (const value of Object.values(record)) {
      traverse(value);
    }
  }

  traverse(card);
  return values;
}

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

function createMockSessionReaderRegistry(
  agentKinds: string[] = ['claude', 'codex'],
): SessionReaderRegistry {
  return {
    listRegistered: vi.fn().mockReturnValue(agentKinds),
    get: vi.fn(),
  } as unknown as SessionReaderRegistry;
}

function buildCodexConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'codex',
    agents: {
      codex: {
        binary: 'codex',
        model: 'deepseek-v4-flash',
        modelProvider: 'deepseek',
        reasoningEffort: 'high',
        stopGraceMs: 5000,
      },
    },
    output: {
      showThinking: true,
      showToolUse: true,
      showToolResult: true,
    },
    idle: { watchdogMinutes: 15 },
    logging: { level: 'info' },
  });
}

const ACTIVE_CATALOG_JSON = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
    description: 'Latest frontier agentic coding model.',
  }),
  makeModel('deepseek-v4-pro', [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], {
    default_reasoning_level: 'high',
    priority: 2,
    description: 'Most capable agentic coding model.',
  }),
]);

const BUNDLED_JSON = makeCatalog([
  makeModel(
    'gpt-5.6-sol',
    [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
    { default_reasoning_level: 'low', description: 'Latest frontier agentic coding model.' },
  ),
]);

describe('codex active catalog config card - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-card-a6-'));
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
    process.env.CODEX_HOME = tmpDir;
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        return ACTIVE_CATALOG_JSON;
      }
      return BUNDLED_JSON;
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

  it('test_anchor_catalog_mode_config_card_reasoning_effort_select_is_active_catalog_levels', () => {
    const router = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge(),
      config: buildCodexConfig(),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    });

    const card = (router as unknown as RouterInternals).buildConfigCard().card;

    // 推理强度下拉 = 活动目录档位，不得是 bundled 的 4 档/6 档
    expect(extractSelectOptions(card, 'agents.codex.reasoningEffort')).toEqual([
      'low',
      'high',
      'max',
    ]);
    // provider 下拉 = 内置 openai + deepseek（codex 合并内置 provider）
    expect(extractSelectOptions(card, 'agents.codex.modelProvider')).toEqual([
      'openai',
      'deepseek',
    ]);
    // 模型下拉 = 活动目录 slug（两个 deepseek 模型都在）
    expect(extractSelectOptions(card, 'agents.codex.model')).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
  });
});
