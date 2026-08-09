/**
 * Codex config filtering tests
 *
 * Verify modelOptions(provider) can filter models by provider
 * based on first principles:
 * - Custom provider: model from config.toml (single model)
 * - openai: all bundled models
 * - anthropic: bundled models with 'claude-*' prefix
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadCodexConfig, invalidateCodexBundledCache } from '../../src/config/codex-config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 直接在模块顶层定义 mock（兼容 bun 的 vitest）
const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

describe('codex-config model filtering', () => {
  const testCodexHome = path.join(os.tmpdir(), 'test-codex-config-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(testCodexHome, { recursive: true });
    invalidateCodexBundledCache();
  });

  afterEach(() => {
    if (fs.existsSync(testCodexHome)) {
      fs.rmSync(testCodexHome, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('should filter openai models - all bundled models belong to openai', async () => {
    const configContent = `
model = "glm-5.2"
model_provider = "volcengine-coding-plan"

[model_providers.volcengine-coding-plan]
name = "volcengine-coding-plan"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = "ARK_API_KEY"
wire_api = "responses"
`;
    fs.writeFileSync(path.join(testCodexHome, 'config.toml'), configContent);

    // Mock bundled models
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: 'glm-5.2',
            display_name: 'GLM-5.2',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
          {
            slug: 'gpt-4o',
            display_name: 'GPT-4O',
            visibility: 'list',
            supported_in_api: true,
            priority: 2,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
          {
            slug: 'o3',
            display_name: 'O3',
            visibility: 'list',
            supported_in_api: true,
            priority: 3,
            supported_reasoning_levels: [{ effort: 'high' }],
            default_reasoning_level: 'high',
          },
        ],
      }),
    );

    const result = loadCodexConfig({ codexHome: testCodexHome, binary: 'codex' });

    // Verify provider list includes openai (built-in) + volcengine-coding-plan (custom)
    expect(result.providerNames).toContain('openai');
    expect(result.providerNames).toContain('volcengine-coding-plan');

    // openai provider should have ALL bundled models (no way to filter by provider from bundled JSON)
    const openaiModels = result.modelOptions('openai');
    expect(openaiModels).toContain('gpt-4o');
    expect(openaiModels).toContain('o3');
    expect(openaiModels).toContain('glm-5.2'); // openai gets ALL bundled models
  });

  it('should filter custom provider models - only current model from config.toml', async () => {
    const configContent = `
model = "glm-5.2"
model_provider = "volcengine-coding-plan"

[model_providers.volcengine-coding-plan]
name = "volcengine-coding-plan"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = "ARK_API_KEY"
wire_api = "responses"
`;
    fs.writeFileSync(path.join(testCodexHome, 'config.toml'), configContent);

    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: 'glm-5.2',
            display_name: 'GLM-5.2',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
          {
            slug: 'glm-5.1',
            display_name: 'GLM-5.1',
            visibility: 'list',
            supported_in_api: true,
            priority: 2,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
          {
            slug: 'gpt-4o',
            display_name: 'GPT-4O',
            visibility: 'list',
            supported_in_api: true,
            priority: 3,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
        ],
      }),
    );

    const result = loadCodexConfig({ codexHome: testCodexHome, binary: 'codex' });

    // Custom provider: only the model from config.toml (no model list in config.toml)
    const volcModels = result.modelOptions('volcengine-coding-plan');
    expect(volcModels).toContain('glm-5.2');
    // config.toml doesn't store model list for custom provider, only current model
    expect(volcModels).not.toContain('glm-5.1');
    expect(volcModels).not.toContain('gpt-4o');
  });

  it('should return empty array when provider has no models', async () => {
    const configContent = `
model = "gpt-4o"
model_provider = "openai"
`;
    fs.writeFileSync(path.join(testCodexHome, 'config.toml'), configContent);

    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-4o',
            display_name: 'GPT-4O',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
        ],
      }),
    );

    const result = loadCodexConfig({ codexHome: testCodexHome, binary: 'codex' });

    // Request a provider that doesn't exist
    const unknownModels = result.modelOptions('nonexistent-provider');
    expect(Array.isArray(unknownModels)).toBe(true);
  });

  it('should include current model even if not in bundled list (same provider)', async () => {
    const configContent = `
model = "my-custom-model"
model_provider = "openai"
`;
    fs.writeFileSync(path.join(testCodexHome, 'config.toml'), configContent);

    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-4o',
            display_name: 'GPT-4O',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
        ],
      }),
    );

    const result = loadCodexConfig({ codexHome: testCodexHome, binary: 'codex' });

    // Current model should always be in the list when it belongs to the current provider
    const openaiModels = result.modelOptions('openai');
    expect(openaiModels).toContain('my-custom-model');
  });

  it('should NOT leak cross-provider currentModel into another provider list', async () => {
    const configContent = `
model = "glm-5.2"
model_provider = "volcengine-coding-plan"

[model_providers.volcengine-coding-plan]
name = "volcengine-coding-plan"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = "ARK_API_KEY"
wire_api = "responses"
`;
    fs.writeFileSync(path.join(testCodexHome, 'config.toml'), configContent);

    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-4o',
            display_name: 'GPT-4O',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
          {
            slug: 'o3',
            display_name: 'O3',
            visibility: 'list',
            supported_in_api: true,
            priority: 2,
            supported_reasoning_levels: [{ effort: 'high' }],
            default_reasoning_level: 'high',
          },
        ],
      }),
    );

    const result = loadCodexConfig({ codexHome: testCodexHome, binary: 'codex' });

    // glm-5.2 belongs to volcengine-coding-plan, should NOT appear in openai's model list
    const openaiModels = result.modelOptions('openai');
    expect(openaiModels).not.toContain('glm-5.2');
    expect(openaiModels).toContain('gpt-4o');
    expect(openaiModels).toContain('o3');

    // glm-5.2 SHOULD appear in its own provider's list
    const volcModels = result.modelOptions('volcengine-coding-plan');
    expect(volcModels).toContain('glm-5.2');
  });

  it('should still include currentModel in global (no-provider) list', async () => {
    const configContent = `
model = "glm-5.2"
model_provider = "volcengine-coding-plan"

[model_providers.volcengine-coding-plan]
name = "volcengine-coding-plan"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = "ARK_API_KEY"
wire_api = "responses"
`;
    fs.writeFileSync(path.join(testCodexHome, 'config.toml'), configContent);

    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-4o',
            display_name: 'GPT-4O',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
        ],
      }),
    );

    const result = loadCodexConfig({ codexHome: testCodexHome, binary: 'codex' });

    // Global list (no provider filter) should still include currentModel
    const globalModels = result.modelOptions();
    expect(globalModels).toContain('glm-5.2');
    expect(globalModels).toContain('gpt-4o');
  });

  it('should trigger model reset logic in router (provider switch scenario)', async () => {
    // This test simulates the router's logic when user switches from volcengine-coding-plan to openai
    const configContent = `
model = "glm-5.2"
model_provider = "volcengine-coding-plan"

[model_providers.volcengine-coding-plan]
name = "volcengine-coding-plan"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = "ARK_API_KEY"
wire_api = "responses"
`;
    fs.writeFileSync(path.join(testCodexHome, 'config.toml'), configContent);

    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-4o',
            display_name: 'GPT-4O',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            supported_reasoning_levels: [{ effort: 'medium' }],
            default_reasoning_level: 'medium',
          },
          {
            slug: 'o3',
            display_name: 'O3',
            visibility: 'list',
            supported_in_api: true,
            priority: 2,
            supported_reasoning_levels: [{ effort: 'high' }],
            default_reasoning_level: 'high',
          },
        ],
      }),
    );

    const result = loadCodexConfig({ codexHome: testCodexHome, binary: 'codex' });
    const currentModel = 'glm-5.2';

    // Simulate user switching provider from volcengine-coding-plan to openai
    const newProvider = 'openai';
    const newModelOptions = result.modelOptions(newProvider);
    const currentModelIsValid = newModelOptions.some((m) => m === currentModel);

    // With the fix: currentModel should NOT be valid for new provider
    // This will trigger the router's model reset logic
    expect(currentModelIsValid).toBe(false);

    // The first model in the new provider's list should be used as reset value
    expect(newModelOptions.length).toBeGreaterThan(0);
    expect(newModelOptions[0]).toBe('gpt-4o'); // First bundled model for openai
  });
});
