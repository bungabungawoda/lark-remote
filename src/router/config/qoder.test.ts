import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QoderConfigBuilder } from './qoder.js';
import { buildConfigCardFromTabs } from './common/render.js';
import type { AppConfig } from '../../config/index.js';
import { expectNoV1ActionContainer } from '../../../tests/lib/card-view.js';
import { loadQoderConfig } from '../../config/qoder-config.js';

vi.mock('../../config/qoder-config.js', () => ({
  loadQoderConfig: vi.fn(),
}));

/** loadQoderConfig 的默认桩：探测清单为空（对应字段回退文本输入的旧口径）。 */
const baseQoderCfg = {
  currentModel: 'qfmodel',
  modelOptions: ['qfmodel', 'lite'],
  effortOptions: [] as string[],
};

function makeConfig(overrides?: Record<string, unknown>): AppConfig {
  return { feishu: { appId: 'test', appSecret: 'test' }, ...overrides } as AppConfig;
}

describe('QoderConfigBuilder', () => {
  const builder = new QoderConfigBuilder();

  beforeEach(() => {
    vi.mocked(loadQoderConfig).mockReset().mockReturnValue(baseQoderCfg);
  });

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

    it('reasoning effort falls back to a text input when the probe yields no levels', () => {
      const fields = builder.buildFields(
        makeConfig({ agents: { qoder: { reasoningEffort: 'xhigh' } } }),
      );
      const effortField = fields.find((f) => f.key === 'agents.qoder.reasoningEffort');
      expect(effortField!.type).toBe('input');
      expect(effortField!.currentValue).toBe('xhigh');
    });

    it('reasoning effort is a select over probed levels with a follow-default entry', () => {
      vi.mocked(loadQoderConfig).mockReturnValue({
        ...baseQoderCfg,
        effortOptions: [
          'auto',
          'none',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
          'ultracode',
          'off',
        ],
      });
      // 未配置 → 当前值落在 default（跟随 Qoder 默认）
      const empty = builder
        .buildFields(makeConfig())
        .find((f) => f.key === 'agents.qoder.reasoningEffort');
      expect(empty!.type).toBe('select');
      expect(empty!.currentValue).toBe('default');
      expect(empty!.options).toEqual([
        { value: 'default', text: 'default（跟随 Qoder 默认）' },
        ...['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'off'].map(
          (value) => ({ value, text: value }),
        ),
      ]);
      // 已配置且在清单里 → 直接选中
      const configured = builder
        .buildFields(makeConfig({ agents: { qoder: { reasoningEffort: 'xhigh' } } }))
        .find((f) => f.key === 'agents.qoder.reasoningEffort');
      expect(configured!.currentValue).toBe('xhigh');
    });

    it('appends a legacy free-text effort to the probed options instead of blank-selecting', () => {
      vi.mocked(loadQoderConfig).mockReturnValue({
        ...baseQoderCfg,
        effortOptions: ['auto', 'low', 'high'],
      });
      const field = builder
        .buildFields(makeConfig({ agents: { qoder: { reasoningEffort: 'ultra' } } }))
        .find((f) => f.key === 'agents.qoder.reasoningEffort');
      expect(field!.type).toBe('select');
      expect(field!.currentValue).toBe('ultra');
      const values = field!.options!.map((o) => (typeof o === 'string' ? o : o.value));
      expect(values).toEqual(['default', 'auto', 'low', 'high', 'ultra']);
    });

    it('permissionMode select uses ACP-native mode ids (1.1.84 availableModes)', () => {
      const fields = builder.buildFields(makeConfig());
      const permField = fields.find((f) => f.key === 'agents.qoder.permissionMode');
      const values = permField!.options!.map((o) => (typeof o === 'string' ? o : o.value));
      expect(values).toEqual(['default', 'acceptEdits', 'auto', 'dontAsk', 'yolo']);
      expect(permField!.currentValue).toBe('default');
    });

    it('legacy snake_case permissionMode normalizes for display (no blank select)', () => {
      const legacy = builder.buildFields(
        makeConfig({ agents: { qoder: { permissionMode: 'bypass_permissions' } } }),
      );
      const permField = legacy.find((f) => f.key === 'agents.qoder.permissionMode');
      expect(permField!.currentValue).toBe('yolo');
    });

    it('contextWindow renders preset select + custom input sharing one key', () => {
      const fieldsOf = (cw: number | undefined) =>
        builder
          .buildFields(
            makeConfig({
              agents: { qoder: { ...(cw !== undefined ? { contextWindow: cw } : {}) } },
            }),
          )
          .filter((f) => f.key === 'agents.qoder.contextWindow');

      // 未配置：下拉选中 default（跟随 CLI/模型），输入框空串
      const [emptySelect, emptyInput] = fieldsOf(undefined);
      expect(emptySelect!.type).toBe('select');
      expect(emptySelect!.currentValue).toBe('default');
      expect(emptySelect!.options).toEqual([
        { value: 'default', text: 'default（跟随 CLI/模型）' },
        { value: '1000000', text: '1M' },
        { value: '500000', text: '500K' },
      ]);
      expect(emptyInput!.type).toBe('input');
      expect(emptyInput!.currentValue).toBe('');

      // 预设值：下拉直接选中，自定义输入留空
      const [presetSelect, presetInput] = fieldsOf(1000000);
      expect(presetSelect!.currentValue).toBe('1000000');
      expect(presetInput!.currentValue).toBe('');

      // 非预设值（input 时代存下）：追加进下拉防空选，双字段都回显
      const [customSelect, customInput] = fieldsOf(262144);
      const values = customSelect!.options!.map((o) => (typeof o === 'string' ? o : o.value));
      expect(values).toEqual(['default', '1000000', '500000', '262144']);
      expect(customSelect!.currentValue).toBe('262144');
      expect(customInput!.currentValue).toBe('262144');
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
      // 下拉的 default（自造值）= 不传 --reasoning-effort
      expect(
        builder.handleFieldChange('agents.qoder.reasoningEffort', 'default', makeConfig()),
      ).toEqual([{ key: 'agents.qoder.reasoningEffort', value: undefined }]);
    });

    it('non-empty values pass through', () => {
      expect(builder.handleFieldChange('agents.qoder.model', 'lite', makeConfig())).toEqual([
        { key: 'agents.qoder.model', value: 'lite' },
      ]);
    });

    it('contextWindow: empty/0/default clears, numbers pass through for save-time coercion', () => {
      for (const input of ['', ' ', '0', 'default']) {
        expect(
          builder.handleFieldChange('agents.qoder.contextWindow', input, makeConfig()),
        ).toEqual([{ key: 'agents.qoder.contextWindow', value: undefined }]);
      }
      expect(
        builder.handleFieldChange('agents.qoder.contextWindow', '262144', makeConfig()),
      ).toEqual([{ key: 'agents.qoder.contextWindow', value: '262144' }]);
      expect(
        builder.handleFieldChange('agents.qoder.contextWindow', '1000000', makeConfig()),
      ).toEqual([{ key: 'agents.qoder.contextWindow', value: '1000000' }]);
    });
  });
});
