/**
 * DshConfigBuilder tests — /config card fields for the DSH agent.
 */

import { describe, it, expect } from 'vitest';
import { DshConfigBuilder, type DshCatalogClient } from './dsh.js';
import { AppConfigSchema } from '../../config/index.js';

const config = AppConfigSchema.parse({
  feishu: { appId: 'a', appSecret: 'b' },
  defaultAgent: 'dsh',
});

/** 构造含 DSH 三个新配置字段的 AppConfig。 */
function dshConfig(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof AppConfigSchema.parse> {
  return AppConfigSchema.parse({
    feishu: { appId: 'a', appSecret: 'b' },
    defaultAgent: 'dsh',
    agents: { dsh: overrides },
  });
}

describe('DshConfigBuilder', () => {
  it('buildFields exposes host, preset, model, custom-model and effort fields', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(config);
    expect(fields.map((f) => f.key)).toEqual([
      'agents.dsh.host',
      'agents.dsh.agentPreset',
      'agents.dsh.model',
      'agents.dsh.model',
      'agents.dsh.reasoningEffort',
    ]);
    // host 保留 input
    expect(fields[0]).toMatchObject({ key: 'agents.dsh.host', type: 'input' });
    // preset/model/effort 是 select；fields[3] 是自定义模型输入框（input）
    expect(fields[1].type).toBe('select');
    expect(fields[3].type).toBe('input');
    expect(fields[4].type).toBe('select');
  });

  it('preset select offers fallback presets plus follow-default sentinel', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(config);
    const preset = fields[1];
    const options = preset.options as Array<{ text: string; value: string }>;
    expect(options[0]).toEqual({ text: '跟随服务端默认', value: '' });
    const values = options.map((o) => o.value);
    expect(values).toEqual(['', 'standard', 'minimal', 'code', 'cordis']);
  });

  it('model select offers fallback models plus follow-default sentinel', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(config);
    const model = fields[2];
    const options = model.options as Array<string | { text: string; value: string }>;
    const values = options.map((o) => (typeof o === 'string' ? o : o.value));
    expect(values).toContain('');
    expect(values).toContain('deepseek-v4-flash');
    expect(values).toContain('deepseek-v4-pro');
  });

  it('effort select offers fallback efforts plus follow-default sentinel', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(config);
    const effort = fields[4];
    const options = effort.options as Array<string | { text: string; value: string }>;
    expect(options[0]).toEqual({ text: '跟随服务端默认', value: '' });
    const values = options.map((o) => (typeof o === 'string' ? o : o.value));
    expect(values).toEqual(['', 'off', 'low', 'high', 'max']);
  });

  it('reads configured preset/model/effort as currentValue', () => {
    const builder = new DshConfigBuilder();
    const cfg = dshConfig({
      agentPreset: 'code',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
    });
    const fields = builder.buildFields(cfg);
    expect(fields[1].currentValue).toBe('code');
    expect(fields[2].currentValue).toBe('deepseek-v4-pro');
    expect(fields[4].currentValue).toBe('low');
  });

  it('custom model outside catalog renders the custom-model input', () => {
    const builder = new DshConfigBuilder();
    const cfg = dshConfig({ model: 'my-custom-model' });
    const fields = builder.buildFields(cfg);
    // select currentValue undefined（不在选项中），自定义输入框带当前值
    expect(fields[2].currentValue).toBeUndefined();
    expect(fields[3]).toMatchObject({
      key: 'agents.dsh.model',
      type: 'input',
      currentValue: 'my-custom-model',
    });
  });

  it('handleFieldChange passes the patch through with sentinel → undefined', () => {
    const builder = new DshConfigBuilder();
    const patches = builder.handleFieldChange('agents.dsh.host', 'http://127.0.0.1:3080', config);
    expect(patches).toEqual([{ key: 'agents.dsh.host', value: 'http://127.0.0.1:3080' }]);

    // 空串哨兵 → undefined（router 删除键 = 跟随服务端默认）
    const sentinelPatches = builder.handleFieldChange('agents.dsh.agentPreset', '', config);
    expect(sentinelPatches).toEqual([{ key: 'agents.dsh.agentPreset', value: undefined }]);
  });

  it('model change to a model the current effort does not support resets effort to catalog middle', () => {
    const builder = new DshConfigBuilder();
    // 预置 catalog：pro 模型只有 off/low 两档
    builder.setCatalog({
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek Official',
          models: [
            {
              id: 'deepseek-v4-flash',
              name: 'Flash',
              reasoning: {
                efforts: [
                  { id: 'off', name: 'off' },
                  { id: 'low', name: 'low' },
                ],
              },
            },
            {
              id: 'deepseek-v4-pro',
              name: 'Pro',
              reasoning: {
                efforts: [
                  { id: 'off', name: 'off' },
                  { id: 'low', name: 'low' },
                  { id: 'high', name: 'high' },
                  { id: 'max', name: 'max' },
                ],
              },
            },
          ],
        },
      ],
    });
    const cfg = dshConfig({ model: 'deepseek-v4-flash', reasoningEffort: 'max' });
    const patches = builder.handleFieldChange('agents.dsh.model', 'deepseek-v4-pro', cfg);
    // max 仍被 pro 支持 → 无档位补丁
    expect(patches).toEqual([{ key: 'agents.dsh.model', value: 'deepseek-v4-pro' }]);
  });

  it('model change to a model missing the current effort resets effort to catalog middle', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog({
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek Official',
          models: [
            {
              id: 'deepseek-v4-flash',
              name: 'Flash',
              reasoning: {
                efforts: [
                  { id: 'off', name: 'off' },
                  { id: 'low', name: 'low' },
                ],
              },
            },
          ],
        },
      ],
    });
    const cfg = dshConfig({ model: 'deepseek-v4-flash', reasoningEffort: 'max' });
    const patches = builder.handleFieldChange('agents.dsh.model', 'deepseek-v4-flash', cfg);
    // max 不被 flash 支持 → 重置到中位 low
    expect(patches).toEqual([
      { key: 'agents.dsh.model', value: 'deepseek-v4-flash' },
      { key: 'agents.dsh.reasoningEffort', value: 'low' },
    ]);
  });

  it('model cleared to follow-default also clears effort to follow-default', () => {
    const builder = new DshConfigBuilder();
    const cfg = dshConfig({ model: 'deepseek-v4-flash', reasoningEffort: 'high' });
    const patches = builder.handleFieldChange('agents.dsh.model', '', cfg);
    expect(patches).toEqual([
      { key: 'agents.dsh.model', value: undefined },
      { key: 'agents.dsh.reasoningEffort', value: undefined },
    ]);
  });

  it('prefetch pulls catalog and presets into the card options', async () => {
    const catalog = {
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek Official',
          models: [
            { id: 'deepseek-v4-flash', name: 'Flash' },
            { id: 'deepseek-v4-pro', name: 'Pro' },
          ],
        },
      ],
    };
    const presets = {
      presets: [
        { id: 'standard', trust: 'system' as const, isDefault: false, name: '标准模式' },
        { id: 'code', trust: 'system' as const, isDefault: false, name: 'PTC 模式' },
      ],
      authorable: false,
      hasDocument: false,
    };
    let calls = 0;
    const clientFactory = (): DshCatalogClient => ({
      listModels: async () => {
        calls++;
        return catalog;
      },
      listPresets: async () => {
        calls++;
        return presets;
      },
    });

    const builder = new DshConfigBuilder(clientFactory);
    await builder.prefetch('http://127.0.0.1:3080');
    const fields = builder.buildFields(config);
    // preset 显示名用 preset.yml 的 name
    expect(fields[1].options as Array<{ text: string; value: string }>).toContainEqual({
      text: 'code（PTC 模式）',
      value: 'code',
    });
    expect(fields[2].options as string[]).toContain('deepseek-v4-pro');
    expect(calls).toBe(2);

    // host 相同 → 第二次 prefetch 短路（不重复请求）
    await builder.prefetch('http://127.0.0.1:3080');
    expect(calls).toBe(2);
  });

  it('prefetch failure falls back to fixed catalog without throwing', async () => {
    const clientFactory = (): DshCatalogClient => ({
      listModels: async () => {
        throw new Error('offline');
      },
      listPresets: async () => {
        throw new Error('offline');
      },
    });
    const builder = new DshConfigBuilder(clientFactory);
    await expect(builder.prefetch('http://127.0.0.1:3080')).resolves.toBeUndefined();
    const fields = builder.buildFields(config);
    expect(fields[1].options as Array<{ value: string }>).toContainEqual({
      text: 'standard（标准模式）',
      value: 'standard',
    });
    expect(fields[2].options as string[]).toContain('deepseek-v4-flash');
  });
});
