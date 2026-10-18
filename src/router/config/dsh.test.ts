/**
 * DshConfigBuilder tests — /config card fields for the DSH agent.
 */

import { describe, it, expect } from 'vitest';
import { DshConfigBuilder, type DshCatalogClient } from './dsh.js';
import { AppConfigSchema } from '../../config/index.js';
import type { DshModelCatalogValue } from '../../runner/dsh/types.js';

const config = AppConfigSchema.parse({
  feishu: { appId: 'a', appSecret: 'b' },
  defaultAgent: 'dsh',
});

/** 构造含 DSH 配置字段的 AppConfig。 */
function dshConfig(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof AppConfigSchema.parse> {
  return AppConfigSchema.parse({
    feishu: { appId: 'a', appSecret: 'b' },
    defaultAgent: 'dsh',
    agents: { dsh: overrides },
  });
}

function efforts(...ids: string[]) {
  return { efforts: ids.map((id) => ({ id, name: id })) };
}

/** 两个 DeepSeek provider + 一个第三方 provider；flash 在两个 group 里重名。 */
const MULTI_CATALOG: DshModelCatalogValue = {
  default: {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  },
  routableProviders: ['deepseek-official', 'deepseek-account', 'anthropic'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek-V4.1-Flash',
          reasoning: efforts('off', 'low', 'high', 'max'),
        },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek-V4-Pro',
          reasoning: efforts('off', 'low', 'high', 'max'),
        },
      ],
    },
    {
      id: 'deepseek-account',
      name: 'DeepSeek Account',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: efforts('off', 'low') },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek-V4-Pro',
          reasoning: efforts('off', 'low', 'high', 'max'),
        },
      ],
    },
    {
      id: 'anthropic',
      name: 'anthropic',
      models: [
        {
          id: 'claude-sonnet-4-5',
          name: 'Claude Sonnet 4.5',
          reasoning: efforts('low', 'high', 'max'),
        },
        {
          id: 'claude-opus-4-1',
          name: 'Claude Opus 4.1',
          reasoning: efforts('low', 'high', 'max'),
        },
      ],
    },
  ],
  failures: [],
};

function optionValues(
  field: { options?: readonly (string | { value: string })[] } | undefined,
): string[] {
  return (field?.options ?? []).map((option) =>
    typeof option === 'string' ? option : option.value,
  );
}

describe('DshConfigBuilder', () => {
  it('buildFields exposes host, preset, permission, provider, model, custom-model and effort fields', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(config);
    expect(fields.map((f) => f.key)).toEqual([
      'agents.dsh.host',
      'agents.dsh.agentPreset',
      'agents.dsh.permissionPreset',
      'agents.dsh.provider',
      'agents.dsh.model',
      'agents.dsh.model',
      'agents.dsh.reasoningEffort',
    ]);
    expect(fields[0]).toMatchObject({ key: 'agents.dsh.host', type: 'input' });
    // provider/model/effort 是 select；fields[5] 是自定义模型输入框（input）
    expect(fields[1].type).toBe('select');
    expect(fields[2].type).toBe('select');
    expect(fields[3].type).toBe('select');
    expect(fields[4].type).toBe('select');
    expect(fields[5].type).toBe('input');
    expect(fields[6].type).toBe('select');
  });

  it('never renders the configured launch token in card fields', () => {
    const builder = new DshConfigBuilder();
    const cfg = dshConfig({ token: 'http://127.0.0.1:3080/?token=secret-token' });
    const fields = builder.buildFields(cfg);

    expect(fields.some((field) => field.key === 'agents.dsh.token')).toBe(false);
    expect(JSON.stringify(fields)).not.toContain('secret-token');
  });

  it('preset select offers fallback presets plus follow-default sentinel', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(config);
    const preset = fields[1];
    const options = preset.options as Array<{ text: string; value: string }>;
    expect(options[0]).toEqual({ text: '跟随服务端默认', value: '' });
    expect(options.map((o) => o.value)).toEqual(['', 'standard', 'minimal', 'ptc', 'cordis']);
  });

  it('permission select offers fallback presets plus follow-default sentinel', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(config);
    const permission = fields[2];
    const options = permission.options as Array<{ text: string; value: string }>;
    expect(options[0]).toEqual({ text: '跟随服务端默认', value: '' });
    expect(options.map((o) => o.value)).toEqual([
      '',
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]);
    expect(options[3].text).toContain('danger-full-access');
  });

  it('keeps a configured custom permission preset selectable when the catalog is offline', () => {
    const builder = new DshConfigBuilder();
    const cfg = dshConfig({ permissionPreset: 'team-policy' });
    const permission = builder.buildFields(cfg)[2];
    expect(permission.options as Array<{ value: string }>).toContainEqual({
      text: 'team-policy（当前配置，服务端未列出）',
      value: 'team-policy',
    });
  });

  it('provider select offers every catalog group plus the current provider', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const fields = builder.buildFields(dshConfig({ provider: 'anthropic' }));
    expect(optionValues(fields[3])).toEqual(['deepseek-official', 'deepseek-account', 'anthropic']);
    expect(fields[3].currentValue).toBe('anthropic');
    expect((fields[3].options as Array<{ text: string }>)[0].text).toBe(
      'DeepSeek（deepseek-official）',
    );
  });

  it('keeps the configured provider selectable when the server does not list it', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(dshConfig({ provider: 'acme-gateway' }));
    expect(optionValues(fields[3])).toEqual(['acme-gateway']);
    expect((fields[3].options as Array<{ text: string }>)[0].text).toContain('离线未校验');
  });

  it('model select only lists models of the selected provider', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const fields = builder.buildFields(
      dshConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
    );
    expect(optionValues(fields[4])).toEqual(['', 'claude-sonnet-4-5', 'claude-opus-4-1']);
    expect(optionValues(fields[4])).not.toContain('deepseek-flash');
    expect(fields[4].currentValue).toBe('claude-sonnet-4-5');
  });

  it('legacy model-only config renders the effective provider and its models', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const fields = builder.buildFields(dshConfig({ model: 'deepseek-v4-pro' }));
    expect(fields[3].currentValue).toBe('deepseek-official');
    expect(fields[4].currentValue).toBe('deepseek-v4-pro');
    expect(optionValues(fields[3])).toContain('deepseek-account');
  });

  it('provider-only config shows that provider default model efforts', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const fields = builder.buildFields(
      dshConfig({ provider: 'anthropic', reasoningEffort: 'max' }),
    );
    expect(fields[3].currentValue).toBe('anthropic');
    expect(fields[4].currentValue).toBe('');
    expect(optionValues(fields[6])).toEqual(['', 'low', 'high', 'max']);
    expect(fields[6].currentValue).toBe('max');
  });

  it('effort select follows the model reasoning metadata and keeps an unsupported current value', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const fields = builder.buildFields(
      dshConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5', reasoningEffort: 'off' }),
    );
    expect(optionValues(fields[6])).toEqual(['', 'low', 'high', 'max', 'off']);
    expect((fields[6].options as Array<{ text: string }>)[4].text).toContain('模型未列出');
  });

  it('model select offers fallback models plus follow-default sentinel when offline', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(config);
    expect(optionValues(fields[4])).toEqual(['', 'deepseek-flash', 'deepseek-v4-pro']);
  });

  it('effort select offers fallback efforts plus follow-default sentinel when offline', () => {
    const builder = new DshConfigBuilder();
    const fields = builder.buildFields(config);
    const options = fields[6].options as Array<{ text: string; value: string }>;
    expect(options[0]).toEqual({ text: '跟随模型默认', value: '' });
    expect(options.map((o) => o.value)).toEqual(['', 'off', 'low', 'high', 'max']);
  });

  it('reads configured preset/provider/model/effort as currentValue', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const cfg = dshConfig({
      agentPreset: 'code',
      permissionPreset: 'read-only',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'low',
    });
    const fields = builder.buildFields(cfg);
    expect(fields[1].currentValue).toBe('code');
    expect(fields[2].currentValue).toBe('read-only');
    expect(fields[3].currentValue).toBe('anthropic');
    expect(fields[4].currentValue).toBe('claude-sonnet-4-5');
    expect(fields[6].currentValue).toBe('low');
  });

  it('custom model outside the provider catalog renders the custom-model input', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const cfg = dshConfig({ provider: 'anthropic', model: 'my-custom-model' });
    const fields = builder.buildFields(cfg);
    // 下拉停在哨兵，模型名由自定义输入框承载
    expect(fields[4].currentValue).toBe('');
    expect(fields[5]).toMatchObject({
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

  it('model change pins the provider for a legacy model-only config', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const cfg = dshConfig({ model: 'deepseek-flash', reasoningEffort: 'high' });
    const patches = builder.handleFieldChange('agents.dsh.model', 'deepseek-v4-pro', cfg);
    expect(patches).toEqual([
      { key: 'agents.dsh.model', value: 'deepseek-v4-pro' },
      { key: 'agents.dsh.provider', value: 'deepseek-official' },
    ]);
  });

  it('model change to a model missing the current effort resets effort to catalog middle', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const cfg = dshConfig({
      provider: 'deepseek-account',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
    const patches = builder.handleFieldChange('agents.dsh.model', 'deepseek-flash', cfg);
    // account 的 flash 只有 off/low → 中位 low
    expect(patches).toEqual([
      { key: 'agents.dsh.model', value: 'deepseek-flash' },
      { key: 'agents.dsh.provider', value: 'deepseek-account' },
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

  it('switching provider keeps a model that exists in both providers', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const cfg = dshConfig({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'low',
    });
    const patches = builder.handleFieldChange('agents.dsh.provider', 'deepseek-account', cfg);
    expect(patches).toEqual([{ key: 'agents.dsh.provider', value: 'deepseek-account' }]);
  });

  it('switching provider replaces an incompatible model and resets its effort', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog(MULTI_CATALOG);
    const cfg = dshConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'max',
    });
    const patches = builder.handleFieldChange('agents.dsh.provider', 'deepseek-account', cfg);
    // account/flash 只有 off/low → 中位 low
    expect(patches).toEqual([
      { key: 'agents.dsh.provider', value: 'deepseek-account' },
      { key: 'agents.dsh.model', value: 'deepseek-flash' },
      { key: 'agents.dsh.reasoningEffort', value: 'low' },
    ]);
  });

  it('switching provider keeps model/effort when the catalog is offline', () => {
    const builder = new DshConfigBuilder();
    const cfg = dshConfig({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    });
    const patches = builder.handleFieldChange('agents.dsh.provider', 'anthropic', cfg);
    expect(patches).toEqual([{ key: 'agents.dsh.provider', value: 'anthropic' }]);
  });

  it('renders a note when the catalog reports provider failures', () => {
    const builder = new DshConfigBuilder();
    builder.setCatalog({
      ...MULTI_CATALOG,
      groups: [],
      failures: [{ id: 'anthropic', name: 'anthropic', message: 'MISSING_CREDENTIAL' }],
    });
    const fields = builder.buildFields(config);
    expect(fields.at(-1)).toMatchObject({
      key: 'agents.dsh.providerFailures',
      type: 'note',
    });
    expect(fields.at(-1)?.label).toContain('MISSING_CREDENTIAL');
  });

  it('prefetch pulls catalog and presets into the card options', async () => {
    const catalog = MULTI_CATALOG;
    const presets = {
      presets: [
        { id: 'standard', trust: 'system' as const, isDefault: false, name: '标准模式' },
        { id: 'code', trust: 'system' as const, isDefault: false, name: 'PTC 模式' },
      ],
      authorable: false,
      hasDocument: false,
    };
    const permissionCatalog = {
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      defaultOptions: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      defaultPreset: 'workspace-write',
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
      listPermissionPresets: async () => {
        calls++;
        return permissionCatalog;
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
    expect(fields[2].options as Array<{ text: string; value: string }>).toContainEqual({
      text: 'danger-full-access（完全访问，关闭审批）',
      value: 'danger-full-access',
    });
    expect(fields[2].options as Array<{ text: string; value: string }>).toContainEqual({
      text: '跟随服务端默认（当前 workspace-write）',
      value: '',
    });
    expect(optionValues(fields[4])).toContain('deepseek-v4-pro');
    expect(calls).toBe(3);

    // host 相同 → 第二次 prefetch 短路（不重复请求）
    await builder.prefetch('http://127.0.0.1:3080');
    expect(calls).toBe(3);

    // force → 强制刷新（DSH Web UI 新增 provider 后打开 /config 能立即看到）
    await builder.prefetch('http://127.0.0.1:3080', undefined, undefined, { force: true });
    expect(calls).toBe(6);
  });

  it('prefetch failure falls back to fixed catalog without throwing', async () => {
    const clientFactory = (): DshCatalogClient => ({
      listModels: async () => {
        throw new Error('offline');
      },
      listPresets: async () => {
        throw new Error('offline');
      },
      listPermissionPresets: async () => {
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
    expect(fields[2].options as Array<{ value: string }>).toContainEqual({
      text: 'danger-full-access（完全访问，关闭审批）',
      value: 'danger-full-access',
    });
    expect(optionValues(fields[4])).toContain('deepseek-flash');
    expect(fields[3].currentValue).toBe('deepseek-official');
  });

  it('passes credentialsFile through and keys the prefetch cache by it', async () => {
    const seen: Array<{ baseUrl: string; token?: string; credentialsFile?: string }> = [];
    const clientFactory = (
      baseUrl: string,
      token?: string,
      credentialsFile?: string,
    ): DshCatalogClient => {
      seen.push({ baseUrl, token, credentialsFile });
      return {
        listModels: async () => ({ groups: [] }),
        listPresets: async () => ({ presets: [] }),
        listPermissionPresets: async () => ({
          options: [],
          defaultOptions: [],
          defaultPreset: 'workspace-write',
        }),
      };
    };
    const builder = new DshConfigBuilder(clientFactory);
    await builder.prefetch('http://127.0.0.1:3080', undefined, '/tmp/a/.credentials.yaml');
    await builder.prefetch('http://127.0.0.1:3080', undefined, '/tmp/b/.credentials.yaml');
    expect(seen).toEqual([
      {
        baseUrl: 'http://127.0.0.1:3080',
        token: undefined,
        credentialsFile: '/tmp/a/.credentials.yaml',
      },
      {
        baseUrl: 'http://127.0.0.1:3080',
        token: undefined,
        credentialsFile: '/tmp/b/.credentials.yaml',
      },
    ]);
  });
});
