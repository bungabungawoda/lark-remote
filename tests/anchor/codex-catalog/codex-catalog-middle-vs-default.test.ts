import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { _Bridge } from '../../../src/bridge/index.js';
import type { _SessionReaderRegistry } from '../../../src/session/registry.js';
import { invalidateCodexBundledCache } from '../../../src/config/codex-config.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 16 - Anchor（codex-y review4 P3-10 测试缺口）
 *
 * P3-10: 既有锚点只覆盖"中位档位恰好等于声明 default"的场景。本锚点锁定
 *   codex with_model（turn_context.rs:260-269）的真实语义：supported_reasoning_levels
 *   长度为 6 时取 index (6-1)/2=2（high），与声明 default（low）不同——
 *   切模型重置档位必须选中位而非 default。
 *
 * Spec basis: turn_context.rs with_model `supported_reasoning_levels.get(len-1/2)`
 *   `.or_else(|| model_info.default_reasoning_level)`。
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
  makeModel(
    'six-level-model',
    [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'ultra' },
    ],
    { default_reasoning_level: 'low', priority: 2, description: 'six-level model' },
  ),
]);

type RouterInternals = {
  pendingConfig?: AppConfig | null;
  buildConfigCard: () => { card: object };
};

function extractSelectCurrentValue(card: object, key: string): string | undefined {
  let current: string | undefined;
  function traverse(obj: unknown) {
    if (current !== undefined || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }
    const record = obj as Record<string, unknown>;
    if (record.tag === 'select_static') {
      const behaviors = record.behaviors as Array<{ value?: { key?: string } }> | undefined;
      const behavior = behaviors?.find((b) => b.value?.key === key);
      if (behavior) {
        current = record.initial_option as string | undefined;
        return;
      }
    }
    for (const value of Object.values(record)) {
      traverse(value);
    }
  }
  traverse(card);
  return current;
}
function buildCodexConfig(model: string, reasoningEffort: string): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'codex',
    agents: {
      codex: {
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

describe('codex catalog middle vs default - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-middle-'));
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

  it('test_anchor_switch_uses_middle_index_not_declared_default', async () => {
    // 当前档位 minimal 不被新模型支持（six-level 只含 low..ultra），触发重置；
    // 若用 ultra（恰好在 six-level 支持集内）则按 with_model 语义保留，无法测中位。
    const config = buildCodexConfig('deepseek-v4-flash', 'minimal');
    const router = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() }),
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({ agentKinds: ['claude', 'codex'] }),
    });
    const internals = router as unknown as RouterInternals;

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'six-level-model' },
      { userId: 'u1', chatId: 'c1', messageId: 'm1' },
    );

    // 6 档 (low..ultra)：中位 index (6-1)/2=2 → high；声明 default 是 low，必须选中位
    expect(internals.pendingConfig?.agents?.codex?.reasoningEffort).toBe('high');
    const card = internals.buildConfigCard().card;
    expect(extractSelectCurrentValue(card, 'agents.codex.reasoningEffort')).toBe('high');
  });
});
