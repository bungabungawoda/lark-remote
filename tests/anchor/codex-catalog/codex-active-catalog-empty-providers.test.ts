import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 7 - Anchor (F1, review finding → anchor)
 *
 * Target: catalog 模式 + config.toml 有 model_catalog_json 但 **没有** [model_providers.*]
 * 时，providerNames = 内置 openai（codex 始终合并内置 provider 且 model_provider 默认
 * "openai"，core/src/config/mod.rs:3655-3661），不得泄漏 anthropic；模型列表不得泄漏
 * FALLBACK_MODELS（o3/gpt-4.x/claude 静态列表）或内置目录模型。
 *
 * Importance: 这是 catalog 语义边界：目录已被 model_catalog_json 整体替换，内置/FALLBACK
 * 模型在运行时不存在；即便 provider 配置为空，也不该把它们当作可选模型展示——
 * 否则用户选中即失败，与本次修复的 openai+内置模型 bug 同源。
 *
 * Spec basis: A3/A5 边界 + codex-y review4 P2——catalog 模式 providerNames=内置 openai +
 * model_providers keys（无配置时仅 openai，codex 默认 provider），
 * 模型列表=活动目录（失败则 [currentModel]）。
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

import { loadCodexConfig, invalidateCodexBundledCache } from '../../../src/config/codex-config.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';

const ACTIVE_CATALOG_JSON = makeCatalog([
  makeModel('deepseek-v4-flash', [{ effort: 'low' }], {
    default_reasoning_level: 'high',
    description: 'Latest frontier agentic coding model.',
  }),
  makeModel('deepseek-v4-pro', [{ effort: 'low' }], {
    default_reasoning_level: 'high',
    priority: 2,
    description: 'Most capable agentic coding model.',
  }),
]);

const BUNDLED_JSON = makeCatalog([
  makeModel('gpt-5.6-sol', [{ effort: 'low' }], {
    default_reasoning_level: 'low',
    description: 'Latest frontier agentic coding model.',
  }),
]);

describe('codex active catalog empty providers - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-f1-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        `model_catalog_json = "${path.join(tmpDir, 'models.json')}"`,
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

  it('test_anchor_catalog_mode_without_providers_keeps_builtin_openai_only', () => {
    const cfg = loadCodexConfig();

    // providerNames = 内置 openai（codex 默认 provider），anthropic 非内置不得出现
    expect(cfg.providerNames).toEqual(['openai']);
    expect(cfg.providerNames).not.toContain('anthropic');
    // config.toml 显式 model_provider 优先；未声明时才默认 openai
    expect(cfg.currentProvider).toBe('deepseek');

    // 模型列表=活动目录全部 slug（provider 与模型无绑定），不得混入
    // FALLBACK_MODELS / bundled（防泄漏核心契约）
    expect(cfg.modelOptions('openai')).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(cfg.modelOptions()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(cfg.modelOptions()).not.toContain('o3');
    expect(cfg.modelOptions()).not.toContain('gpt-4.1');
    expect(cfg.modelOptions()).not.toContain('gpt-5.6-sol');
  });
});
