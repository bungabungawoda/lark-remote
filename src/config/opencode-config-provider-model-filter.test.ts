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
const mockSpawnSync = vi.fn();
const mockResolveExecutable = vi.fn();

vi.mock('../platform/command.js', () => ({
  resolveExecutable: (...args: unknown[]) => mockResolveExecutable(...args),
}));
vi.mock('../platform/spawn.js', () => ({
  spawnProcessSync: (...args: unknown[]) => mockSpawnSync(...args),
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
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: `opencode/big-pickle
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
        stderr: '',
      });

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

      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: `opencode/big-pickle
{
  "id": "big-pickle"
}
deepseek/deepseek-chat
{
  "id": "deepseek-chat"
}
`,
        stderr: '',
      });

      const result = loadOpencodeConfig();

      // deepseek 的模型列表不含 opencode 的模型，也不为空
      const newModelOptions = result.modelOptions('deepseek');
      expect(newModelOptions.length).toBeGreaterThan(0);
      expect(newModelOptions).toContain('deepseek-chat');
      expect(newModelOptions).not.toContain('big-pickle');
    });

    it('should return all models when no provider specified', () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: `opencode/big-pickle
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
        stderr: '',
      });

      const result = loadOpencodeConfig();
      const allModels = result.modelOptions();

      // Should contain models from all providers (deduped)
      expect(allModels).toContain('big-pickle');
      expect(allModels).toContain('deepseek-chat');
      expect(allModels).toContain('MiniMax-M2.5');
      expect(allModels.length).toBe(3);
    });

    it('should handle unknown provider gracefully', () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: `opencode/big-pickle
{
  "id": "big-pickle"
}
`,
        stderr: '',
      });

      const result = loadOpencodeConfig();

      // Unknown provider should return empty array
      const unknownModels = result.modelOptions('unknown-provider-xyz');
      expect(Array.isArray(unknownModels)).toBe(true);
      expect(unknownModels.length).toBe(0);
    });

    it('should use fallback when opencode command fails', () => {
      mockSpawnSync.mockImplementation(() => {
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
  });
});
