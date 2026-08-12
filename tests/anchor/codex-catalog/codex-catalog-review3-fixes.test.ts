import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import {
  isCodexCatalogMode,
  loadCodexConfig,
  getReasoningEffortOptions,
  getDefaultReasoningEffort,
  invalidateCodexBundledCache,
} from '../../../src/config/codex-config.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 15 - Anchor（codex-y review3 P1/P2-1 回归锁定）
 *
 * P1: 模型声明 supported_reasoning_levels 为空 → 选项为空、默认用声明 default
 *     （codex with_model：len=0 → default；都没有 → 不发 effort），不得虚构 DEFAULT 档位。
 * P2-1: model_catalog_json 空串 → 仍按 catalog 声明退化处理，绝不回退 bundled/FALLBACK
 *     （codex 对非法目录声明是硬错误）；config.toml 解析失败 → 无法得知是否声明，
 *     review4 P3-5 修订为按非 catalog（legacy bundled）处理，与历史行为一致。
 *
 * Spec basis: codex-y review3 P1/P2-1 + review4 P3-5 + codex 源码。
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

const EMPTY_LEVELS_CATALOG = makeCatalog([
  makeModel('empty-levels-model', [], { default_reasoning_level: 'high' }),
  makeModel('gpt-5.6-sol', [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }], {
    default_reasoning_level: 'low',
  }),
]);

type RouterInternals = {
  buildConfigCard: () => { card: object };
};

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

describe('codex catalog review3 fixes - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review3-'));
    process.env.CODEX_HOME = tmpDir;
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        // 镜像真实 codex：config.toml 声明有效路径 → 返回该文件内容；
        // 声明存在但不可用（空串/文件缺失）→ 硬错误（codex 不回落内置目录）
        const home = process.env.CODEX_HOME;
        if (home) {
          const cfgPath = path.join(home, 'config.toml');
          if (fs.existsSync(cfgPath)) {
            const cfgRaw = fs.readFileSync(cfgPath, 'utf-8');
            const m = cfgRaw.match(/model_catalog_json\s*=\s*"([^"]+)"/);
            if (m) {
              if (fs.existsSync(m[1])) {
                return fs.readFileSync(m[1], 'utf-8');
              }
              throw new Error('boom: catalog file missing');
            }
            if (cfgRaw.includes('model_catalog_json')) {
              throw new Error('boom: invalid catalog declaration');
            }
          }
        }
        return EMPTY_LEVELS_CATALOG;
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

  function writeCatalogConfig(modelCatalogJsonLine: string | null, modelLine?: string): void {
    const lines: string[] = [];
    if (modelLine) lines.push(modelLine);
    if (modelCatalogJsonLine !== null) lines.push(modelCatalogJsonLine);
    lines.push('[model_providers.deepseek]', 'name = "deepseek"', 'env_key = "DS_API_KEY"', '');
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), lines.join('\n'));
    invalidateCodexBundledCache();
  }

  it('test_anchor_p1_empty_declared_levels_stay_empty_and_default_used', async () => {
    writeCatalogConfig(
      `model_catalog_json = "${path.join(tmpDir, 'models.json')}"`,
      'model = "empty-levels-model"',
    );
    fs.writeFileSync(path.join(tmpDir, 'models.json'), EMPTY_LEVELS_CATALOG);

    // 声明空档位 → 选项为空（不虚构 DEFAULT），默认档位取声明 default 'high'
    expect(getReasoningEffortOptions('empty-levels-model')).toEqual([]);
    expect(getDefaultReasoningEffort('empty-levels-model')).toBe('high');

    // 卡片切到空档位模型：当前 ultra 不支持 → 无中位 → 用声明 default 'high'
    const router = new CommandRouter({
      sessionStore: new SessionStore(),
      bridge: createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() }),
      config: buildCodexConfig('gpt-5.6-sol', 'ultra'),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({ agentKinds: ['claude', 'codex'] }),
    });
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };
    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'empty-levels-model' },
      ctx,
    );
    const card = (router as unknown as RouterInternals).buildConfigCard().card;
    expect(extractSelectOptions(card, 'agents.codex.reasoningEffort')).toEqual([]);
    expect(extractSelectCurrentValue(card, 'agents.codex.reasoningEffort')).toBe('high');
  });

  it('test_anchor_p3_5_unparseable_config_falls_back_to_legacy_non_catalog', () => {
    // config.toml 语法非法 → 无法得知是否声明 model_catalog_json；review4 P3-5 修订：
    // 按非 catalog（legacy）处理，恢复历史行为（bundled/FALLBACK 兜底），并修正文档矛盾
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      'model = "deepseek-v4-flash"\n[model_providers\n',
    );
    invalidateCodexBundledCache();

    expect(isCodexCatalogMode()).toBe(false);
    const cfg = loadCodexConfig();
    // legacy 兜底：provider 只含 openai，模型列表=bundled（gpt-5.2 fixture）
    expect(cfg.providerNames).toEqual(['openai']);
    expect(cfg.modelOptions()).toEqual(['gpt-5.2']);
    expect(cfg.modelOptions('openai')).toEqual(['gpt-5.2']);
  });

  it('test_anchor_p2_1_empty_catalog_json_value_stays_catalog_degraded', () => {
    // model_catalog_json = "" → 非法声明，仍 catalog 退化（不得回退 bundled）
    writeCatalogConfig('model_catalog_json = ""', 'model = "deepseek-v4-flash"');

    expect(isCodexCatalogMode()).toBe(true);
    const cfg = loadCodexConfig();
    expect(cfg.providerNames).toEqual(['openai', 'deepseek']);
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.modelOptions('deepseek')).toEqual(['deepseek-v4-flash']);
    expect(cfg.modelOptions('deepseek')).not.toContain('gpt-5.2');
    expect(cfg.modelOptions('deepseek')).not.toContain('o3');
  });
});
