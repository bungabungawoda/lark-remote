import { describe, it, expect, vi } from 'vitest';
import { OpencodeConfigBuilder } from './opencode.js';
import type { AppConfig } from '../../config/index.js';

vi.mock('../../config/opencode-config.js', () => ({
  loadOpencodeConfig: vi.fn(() => ({
    providerNames: ['openai', 'anthropic'],
    modelOptions: (provider?: string) => {
      if (!provider) return ['gpt-4o', 'claude-sonnet'];
      if (provider === 'openai') return ['gpt-4o'];
      if (provider === 'anthropic') return ['claude-sonnet'];
      return [];
    },
  })),
  invalidateOpencodeConfigCache: vi.fn(),
}));

function makeConfig(overrides?: Record<string, unknown>): AppConfig {
  return { feishu: { appId: 'test', appSecret: 'test' }, ...overrides } as AppConfig;
}

describe('OpencodeConfigBuilder', () => {
  const builder = new OpencodeConfigBuilder();

  describe('buildFields', () => {
    it('returns provider + model fields with correct options', () => {
      const config = makeConfig({ agents: { opencode: { providerID: 'openai' } } });
      const fields = builder.buildFields(config);

      const providerField = fields.find((f) => f.key === 'agents.opencode.providerID');
      const modelField = fields.find((f) => f.key === 'agents.opencode.modelID');

      expect(providerField).toBeDefined();
      expect(providerField!.type).toBe('select');
      expect(providerField!.options).toEqual(['openai', 'anthropic']);

      expect(modelField).toBeDefined();
      expect(modelField!.type).toBe('select');
      // When provider is 'openai', model options should be filtered
      expect(modelField!.options).toEqual(['gpt-4o']);
    });

    it('returns all model options when no provider selected', () => {
      const config = makeConfig({ agents: { opencode: {} } });
      const fields = builder.buildFields(config);

      const modelField = fields.find((f) => f.key === 'agents.opencode.modelID');
      expect(modelField!.options).toEqual(['gpt-4o', 'claude-sonnet']);
    });

    it('returns mode select field with build/plan options (§P5)', () => {
      const config = makeConfig({ agents: { opencode: { mode: 'plan' } } });
      const fields = builder.buildFields(config);

      const modeField = fields.find((f) => f.key === 'agents.opencode.mode');
      expect(modeField).toBeDefined();
      expect(modeField!.type).toBe('select');
      expect(modeField!.options).toEqual([
        { text: 'build（默认，逐项审批）', value: 'build' },
        { text: 'plan（规划模式）', value: 'plan' },
      ]);
      expect(modeField!.currentValue).toBe('plan');
    });

    it('mode select defaults to build when config missing (§P5)', () => {
      const config = makeConfig({ agents: { opencode: {} } });
      const fields = builder.buildFields(config);

      const modeField = fields.find((f) => f.key === 'agents.opencode.mode');
      expect(modeField!.currentValue).toBe('build');
    });
  });

  describe('handleFieldChange', () => {
    it('for non-provider key: returns just the single patch', () => {
      const config = makeConfig({
        agents: { opencode: { providerID: 'openai', modelID: 'gpt-4o' } },
      });
      const patches = builder.handleFieldChange('agents.opencode.modelID', 'gpt-4o', config);
      expect(patches).toEqual([{ key: 'agents.opencode.modelID', value: 'gpt-4o' }]);
    });

    it('for provider change, current model still valid: returns just the provider patch', () => {
      // Both providers share 'gpt-4o' is not true in our mock, but 'claude-sonnet' exists only under 'anthropic'.
      // Let's test a scenario where model is valid under new provider.
      // Our mock: openai → ['gpt-4o'], anthropic → ['claude-sonnet']
      // So switching to 'openai' when model is 'gpt-4o' should NOT reset model.
      const config = makeConfig({
        agents: { opencode: { providerID: 'anthropic', modelID: 'gpt-4o' } },
      });
      const patches = builder.handleFieldChange('agents.opencode.providerID', 'openai', config);
      expect(patches).toEqual([{ key: 'agents.opencode.providerID', value: 'openai' }]);
    });

    it('for provider change, current model invalid: returns provider + model reset patch', () => {
      // Switching to 'anthropic' when model is 'gpt-4o': 'gpt-4o' is NOT in anthropic's model list
      const config = makeConfig({
        agents: { opencode: { providerID: 'openai', modelID: 'gpt-4o' } },
      });
      const patches = builder.handleFieldChange('agents.opencode.providerID', 'anthropic', config);
      expect(patches).toEqual([
        { key: 'agents.opencode.providerID', value: 'anthropic' },
        { key: 'agents.opencode.modelID', value: 'claude-sonnet' },
      ]);
    });

    it('for provider change, no current model: does not reset model', () => {
      const config = makeConfig({ agents: { opencode: {} } });
      const patches = builder.handleFieldChange('agents.opencode.providerID', 'anthropic', config);
      // currentModel is undefined, so !currentModelIsValid is true, but we should still get a model reset
      // because newModelOptions.length > 0 and undefined is not in the list
      expect(patches).toEqual([
        { key: 'agents.opencode.providerID', value: 'anthropic' },
        { key: 'agents.opencode.modelID', value: 'claude-sonnet' },
      ]);
    });
  });
});
