import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppConfigSchema } from '../../../src/config/index.js';

/**
 * Red Agent — P2-26 — Anchor
 *
 * Target: KimiConfigBuilder.handleFieldChange 切模型时重置不兼容的 thinkingEffort
 *
 * 缺陷：用户在 /config 卡片切 kimi 模型（key='agents.kimi.model'）时，
 * pendingConfig 里的 `agents.kimi.thinkingEffort` 可能不被新模型支持，
 * 但当前实现是纯透传 `[{ key, value }]`，原样把非法档位留给 kimi runner。
 * 对比 codex（src/router/config/codex.ts:100-104, effortPatchForModel:118-132）
 * 切模型时校验并重置档位。
 *
 * 缺陷契约：当 handleFieldChange('agents.kimi.model', <newModel>, config)
 * 被调用，且 config 里当前 `agents.kimi.thinkingEffort` 不在
 * modelEfforts[newModel] 内时，返回的 patches 数组应包含一个
 * key='agents.kimi.thinkingEffort' 的重置补丁（value 为 newModel 支持的合法档位）。
 */

const { mockLoadKimiConfig, mockLogger } = vi.hoisted(() => ({
  mockLoadKimiConfig: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/config/kimi-config.js', () => ({
  loadKimiConfig: mockLoadKimiConfig,
  KIMI_THINKING_EFFORTS: ['low', 'high', 'max'] as const,
  FALLBACK_EFFORTS: ['low', 'high', 'max'] as readonly string[],
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

beforeEach(() => {
  mockLoadKimiConfig.mockReset();
  mockLoadKimiConfig.mockReturnValue({
    currentModel: 'modelA',
    modelOptions: ['modelA', 'modelB'],
    modelDisplayNames: { modelA: 'A', modelB: 'B' },
    // modelA 支持低高max；modelB 只支持 low
    modelEfforts: { modelA: ['low', 'high', 'max'], modelB: ['low'] },
    modelDefaultEfforts: { modelA: 'high', modelB: 'low' },
  });
});

describe('KimiConfigBuilder handleFieldChange model switch resets unsupported thinkingEffort - anchor', () => {
  it('test_anchor_kimi_model_switch_resets_unsupported_thinking_effort', async () => {
    const { KimiConfigBuilder } = await import('../../../src/router/config/kimi.js');

    const builder = new KimiConfigBuilder();

    // 当前 modelA 的 thinkingEffort='high'；切到 modelB（只支持 ['low']）
    const config = AppConfigSchema.parse({
      feishu: { appId: 'x', appSecret: 'y' },
      agents: { kimi: { model: 'modelA', thinkingEffort: 'high' } },
    });

    const patches = builder.handleFieldChange('agents.kimi.model', 'modelB', config);

    // 应包含 model 补丁
    const modelPatch = patches.find((p) => p.key === 'agents.kimi.model');
    expect(modelPatch).toBeDefined();
    expect(modelPatch?.value).toBe('modelB');

    // 缺陷断言：应包含 thinkingEffort 重置补丁
    const effortPatch = patches.find((p) => p.key === 'agents.kimi.thinkingEffort');
    expect(effortPatch).toBeDefined();
    // 重置值必须是 modelB 支持的合法档位
    expect(effortPatch?.value).toBe('low');
  });
});
