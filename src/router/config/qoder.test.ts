import { describe, it, expect, vi } from 'vitest';
import { QoderConfigBuilder } from './qoder.js';
import { buildConfigCardFromTabs } from './common/render.js';
import type { AppConfig } from '../../config/index.js';
import { expectNoV1ActionContainer } from '../../../tests/lib/card-view.js';
import { loadQoderConfig } from '../../config/qoder-config.js';

vi.mock('../../config/qoder-config.js', () => ({
  loadQoderConfig: vi.fn(() => ({
    currentModel: 'qfmodel',
    modelOptions: ['qfmodel', 'lite'],
  })),
}));

function makeConfig(overrides?: Record<string, unknown>): AppConfig {
  return { feishu: { appId: 'test', appSecret: 'test' }, ...overrides } as AppConfig;
}

describe('QoderConfigBuilder', () => {
  const builder = new QoderConfigBuilder();

  describe('buildFields', () => {
    it('probes --list-models with the configured cli.binary (CN/国际版安装名不同)', () => {
      builder.buildFields(makeConfig({ agents: { qoder: { cli: { binary: 'qoder' } } } }));
      expect(vi.mocked(loadQoderConfig)).toHaveBeenLastCalledWith('qoder');
      builder.buildFields(makeConfig());
      expect(vi.mocked(loadQoderConfig)).toHaveBeenLastCalledWith(undefined);
    });
    it('model is a select over --list-models when the list is non-empty', () => {
      const fields = builder.buildFields(makeConfig());
      const modelField = fields.find((f) => f.key === 'agents.qoder.model');
      expect(modelField!.type).toBe('select');
      expect(modelField!.options).toEqual(['qfmodel', 'lite']);
      expect(modelField!.currentValue).toBe('qfmodel');
    });

    it('reasoning effort renders as a text input (no stable official enum)', () => {
      const fields = builder.buildFields(
        makeConfig({ agents: { qoder: { reasoningEffort: 'xhigh' } } }),
      );
      const effortField = fields.find((f) => f.key === 'agents.qoder.reasoningEffort');
      expect(effortField!.type).toBe('input');
      expect(effortField!.currentValue).toBe('xhigh');
    });

    it('permissionMode select uses snake_case official values', () => {
      const fields = builder.buildFields(makeConfig());
      const permField = fields.find((f) => f.key === 'agents.qoder.permissionMode');
      const values = permField!.options!.map((o) => (typeof o === 'string' ? o : o.value));
      expect(values).toEqual([
        'default',
        'accept_edits',
        'plan',
        'auto',
        'bypass_permissions',
        'dont_ask',
      ]);
      expect(permField!.currentValue).toBe('default');
    });

    it('contextWindow renders as an input with the configured value', () => {
      const fields = builder.buildFields(
        makeConfig({ agents: { qoder: { contextWindow: 262144 } } }),
      );
      const ctxField = fields.find((f) => f.key === 'agents.qoder.contextWindow');
      expect(ctxField!.type).toBe('input');
      expect(ctxField!.currentValue).toBe('262144');
      // 未配置时显示空串（跟随 CLI/模型默认）
      const empty = builder
        .buildFields(makeConfig())
        .find((f) => f.key === 'agents.qoder.contextWindow');
      expect(empty!.currentValue).toBe('');
    });

    it('renders as a v1-safe card container (no tag:action)', () => {
      const config = makeConfig();
      const fields = builder.buildFields(config);
      const tabs = [{ id: 'qoder', label: 'Qoder', fields }];
      const cardStr = JSON.stringify(buildConfigCardFromTabs(tabs, config));
      expect(cardStr).toContain('"schema":"2.0"');
      expectNoV1ActionContainer(cardStr);
      expect(cardStr).toContain('"cmd":"config.');
    });
  });

  describe('handleFieldChange', () => {
    it('empty model/effort strings clear the config', () => {
      expect(builder.handleFieldChange('agents.qoder.model', '', makeConfig())).toEqual([
        { key: 'agents.qoder.model', value: undefined },
      ]);
      expect(builder.handleFieldChange('agents.qoder.reasoningEffort', ' ', makeConfig())).toEqual([
        { key: 'agents.qoder.reasoningEffort', value: undefined },
      ]);
    });

    it('non-empty values pass through', () => {
      expect(builder.handleFieldChange('agents.qoder.model', 'lite', makeConfig())).toEqual([
        { key: 'agents.qoder.model', value: 'lite' },
      ]);
    });

    it('contextWindow: empty or 0 clears, numbers pass through for save-time coercion', () => {
      for (const input of ['', ' ', '0']) {
        expect(
          builder.handleFieldChange('agents.qoder.contextWindow', input, makeConfig()),
        ).toEqual([{ key: 'agents.qoder.contextWindow', value: undefined }]);
      }
      expect(
        builder.handleFieldChange('agents.qoder.contextWindow', '262144', makeConfig()),
      ).toEqual([{ key: 'agents.qoder.contextWindow', value: '262144' }]);
    });
  });
});
