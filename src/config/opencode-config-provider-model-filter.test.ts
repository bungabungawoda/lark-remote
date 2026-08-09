/**
 * OpenCode config provider-model filtering tests
 *
 * Verify modelOptions(provider) returns only models for that specific provider,
 * and does NOT leak models from other providers into the list.
 *
 * This is a baseline test to ensure OpenCode doesn't have the same cross-provider
 * model leak bug that Codex had (fixed in codex-config-filter.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadOpencodeConfig, invalidateOpencodeConfigCache } from '../config/opencode-config.js';

// 直接在模块顶层定义 mock（兼容 bun 的 vitest）
const mockExecSync = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

describe('opencode-config provider-model filtering', () => {
  beforeEach(() => {
    // P1-8：模块级 TTL 缓存会在测试间串状态，每个用例前清空
    invalidateOpencodeConfigCache();
    vi.clearAllMocks();
  });

  describe('provider-model isolation', () => {
    it('should return only models for the specified provider', () => {
      // Mock opencode models --verbose output
      mockExecSync.mockReturnValue(
        `opencode/big-pickle
{
  "id": "big-pickle",
  "name": "Big Pickle",
  "context": 200000
}
deepseek/deepseek-chat
{
  "id": "deepseek-chat",
  "name": "DeepSeek Chat",
  "context": 64000
}
minimax-cn-coding-plan/MiniMax-M2.5
{
  "id": "MiniMax-M2.5",
  "name": "MiniMax M2.5",
  "context": 128000
}
`,
      );

      const result = loadOpencodeConfig();

      // Verify all providers are in the list
      expect(result.providerNames).toContain('opencode');
      expect(result.providerNames).toContain('deepseek');
      expect(result.providerNames).toContain('minimax-cn-coding-plan');

      // opencode should only have its own models
      const opencodeModels = result.modelOptions('opencode');
      expect(opencodeModels).toContain('big-pickle');
      expect(opencodeModels).not.toContain('deepseek-chat');
      expect(opencodeModels).not.toContain('MiniMax-M2.5');

      // deepseek should only have its own models
      const deepseekModels = result.modelOptions('deepseek');
      expect(deepseekModels).toContain('deepseek-chat');
      expect(deepseekModels).not.toContain('big-pickle');
      expect(deepseekModels).not.toContain('MiniMax-M2.5');

      // minimax-cn-coding-plan should only have its own models
      const minimaxModels = result.modelOptions('minimax-cn-coding-plan');
      expect(minimaxModels).toContain('MiniMax-M2.5');
      expect(minimaxModels).not.toContain('big-pickle');
      expect(minimaxModels).not.toContain('deepseek-chat');
    });

    it('should NOT leak models from one provider into another provider list', () => {
      // This test verifies the bug that was fixed in Codex doesn't exist in OpenCode

      mockExecSync.mockReturnValue(
        `opencode/big-pickle
{
  "id": "big-pickle"
}
deepseek/deepseek-chat
{
  "id": "deepseek-chat"
}
`,
      );

      const result = loadOpencodeConfig();
      const currentModel = 'big-pickle';

      // Simulate user switching from opencode to deepseek
      const newProvider = 'deepseek';
      const newModelOptions = result.modelOptions(newProvider);
      const currentModelIsValid = newModelOptions.some((m) => m === currentModel);

      // With correct implementation: currentModel (big-pickle) should NOT be valid
      // for a different provider (deepseek)
      expect(currentModelIsValid).toBe(false);

      // The new provider's first model should be used as reset value
      expect(newModelOptions.length).toBeGreaterThan(0);
      expect(newModelOptions[0]).toBe('deepseek-chat');
    });

    it('should return all models when no provider specified', () => {
      mockExecSync.mockReturnValue(
        `opencode/big-pickle
{
  "id": "big-pickle"
}
deepseek/deepseek-chat
{
  "id": "deepseek-chat"
}
minimax-cn-coding-plan/MiniMax-M2.5
{
  "id": "MiniMax-M2.5"
}
`,
      );

      const result = loadOpencodeConfig();
      const allModels = result.modelOptions();

      // Should contain models from all providers (deduped)
      expect(allModels).toContain('big-pickle');
      expect(allModels).toContain('deepseek-chat');
      expect(allModels).toContain('MiniMax-M2.5');
      expect(allModels.length).toBe(3);
    });

    it('should correctly filter by provider via loadOpencodeConfig().modelOptions()', () => {
      mockExecSync.mockReturnValue(
        `opencode/big-pickle
{
  "id": "big-pickle"
}
deepseek/deepseek-chat
{
  "id": "deepseek-chat"
}
`,
      );

      // Test the production API (same path the router config card uses)
      const opencodeModels = loadOpencodeConfig().modelOptions('opencode');
      const deepseekModels = loadOpencodeConfig().modelOptions('deepseek');

      // openai should NOT contain deepseek models
      expect(opencodeModels).not.toContain('deepseek-chat');
      expect(opencodeModels).toContain('big-pickle');

      // deepseek should NOT contain opencode models
      expect(deepseekModels).not.toContain('big-pickle');
      expect(deepseekModels).toContain('deepseek-chat');
    });

    it('should handle unknown provider gracefully', () => {
      mockExecSync.mockReturnValue(
        `opencode/big-pickle
{
  "id": "big-pickle"
}
`,
      );

      const result = loadOpencodeConfig();

      // Unknown provider should return empty array
      const unknownModels = result.modelOptions('unknown-provider-xyz');
      expect(Array.isArray(unknownModels)).toBe(true);
      expect(unknownModels.length).toBe(0);
    });

    it('should use fallback when opencode command fails', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('opencode not found');
      });

      const result = loadOpencodeConfig();

      // Should have fallback providers
      expect(result.providerNames.length).toBeGreaterThan(0);
      expect(result.providerNames).toContain('opencode');

      // Each provider should have its fallback models
      const opencodeModels = result.modelOptions('opencode');
      expect(opencodeModels).toContain('big-pickle');

      const deepseekModels = result.modelOptions('deepseek');
      expect(deepseekModels).toContain('deepseek-chat');
    });

    it('should trigger model reset logic in router (provider switch scenario)', () => {
      // This test simulates the router's logic when user switches provider

      mockExecSync.mockReturnValue(
        `opencode/big-pickle
{
  "id": "big-pickle"
}
deepseek/deepseek-chat
{
  "id": "deepseek-chat"
}
`,
      );

      const result = loadOpencodeConfig();

      // Scenario: user currently has provider=opencode, model=big-pickle
      // They switch to provider=deepseek
      const currentModel = 'big-pickle';
      const newProvider = 'deepseek';

      const newModelOptions = result.modelOptions(newProvider);
      const currentModelIsValid = newModelOptions.some((m) => m === currentModel);

      // With correct implementation:
      // - currentModelIsValid should be FALSE (big-pickle doesn't belong to deepseek)
      // - Router should reset model to newModelOptions[0]
      expect(currentModelIsValid).toBe(false);
      expect(newModelOptions[0]).toBe('deepseek-chat');

      // Test reverse scenario: deepseek -> opencode
      const reverseCurrentModel = 'deepseek-chat';
      const reverseNewProvider = 'opencode';
      const reverseNewModelOptions = result.modelOptions(reverseNewProvider);
      const reverseCurrentModelIsValid = reverseNewModelOptions.some(
        (m) => m === reverseCurrentModel,
      );

      expect(reverseCurrentModelIsValid).toBe(false);
      expect(reverseNewModelOptions[0]).toBe('big-pickle');
    });
  });
});
