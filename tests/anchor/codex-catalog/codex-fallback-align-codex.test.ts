import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Red Agent - Round 12 - Anchor (P3-2 + P3-3, review findings → anchor)
 *
 * Target:
 *   P3-2: 无 config.toml 的 fallback provider 列表不得含 anthropic——codex 内置
 *     provider 只有 openai/amazon-bedrock/ollama/lmstudio（model-provider-info/src/lib.rs
 *     built_in_model_providers），anthropic 必须用户显式配置才存在。
 *   P3-3: config.toml 缺 model 键时，默认模型取目录首个可用模型（codex
 *     default_model_from_available：优先 is_default，否则第一个），不是硬编码 'o3'。
 *
 * Importance: 卡片列出的每个 provider/model 都必须是 codex 运行时真实可解析的；
 * 'anthropic' 与 'o3' 是 legacy 假值，选中即失败。
 *
 * Spec basis: P3-2/P3-3（review 发现）+ codex 源码。
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

const BUNDLED_JSON = makeCatalog([
  makeModel('gpt-5.6-sol', [{ effort: 'low' }], {
    default_reasoning_level: 'low',
    description: 'Latest frontier agentic coding model.',
  }),
  makeModel('gpt-5.4', [{ effort: 'medium' }], {
    default_reasoning_level: 'medium',
    priority: 16,
    description: 'GPT-5.4',
  }),
]);

describe('codex fallback aligns with codex runtime - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fallback-'));
    process.env.CODEX_HOME = tmpDir;
    mockExecFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && args.includes('--bundled')) {
        return BUNDLED_JSON;
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

  it('test_anchor_fallback_providers_exclude_anthropic_without_config', () => {
    // 无 config.toml：anthropic 不是 codex 内置 provider，不得出现在下拉
    const cfg = loadCodexConfig({ codexHome: path.join(tmpDir, 'no-home') });
    expect(cfg.providerNames).not.toContain('anthropic');
    expect(cfg.providerNames).toEqual(['openai']);
  });

  it('test_anchor_default_model_is_first_available_not_o3', () => {
    // config.toml 存在但缺 model 键：codex 默认取目录首个模型（gpt-5.6-sol，priority 1）
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), 'model_provider = "openai"\n');
    invalidateCodexBundledCache();

    const cfg = loadCodexConfig();
    expect(cfg.currentModel).toBe('gpt-5.6-sol');
    expect(cfg.modelOptions('openai')[0]).toBe('gpt-5.6-sol');
  });
});
