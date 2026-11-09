import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodebuddyConfigBuilder } from './codebuddy.js';
import { buildConfigCardFromTabs } from './common/render.js';
import type { AppConfig } from '../../config/index.js';
import { expectNoV1ActionContainer } from '../../../tests/lib/card-view.js';
import { refreshCodebuddyCatalog, resolveCodebuddyEnv } from '../../config/codebuddy-catalog.js';
import { resolveCodebuddyModel } from '../../config/codebuddy-model-state.js';
import { loadCodebuddyConfig } from '../../config/codebuddy-config.js';

// 目录探针会 spawn 真 codebuddy --acp（红线：测试禁止 spawn 真 agent）——
// 这里必须 mock 掉；buildFields 点火接线用下方断言钉住，不因 mock 静默失效。
// 模型事实源同理：真实实现会读配置目录里的学习结果，测试用可控 mock。
vi.mock('../../config/codebuddy-catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/codebuddy-catalog.js')>();
  return {
    ...actual,
    refreshCodebuddyCatalog: vi.fn(async () => null),
    resolveCodebuddyEnv: vi.fn((env: Record<string, string | undefined> = {}) => env),
  };
});

vi.mock('../../config/codebuddy-model-state.js', () => ({
  resolveCodebuddyModel: vi.fn((configured?: string) => configured),
}));

vi.mock('../../config/codebuddy-config.js', () => ({
  loadCodebuddyConfig: vi.fn(() => ({
    currentModel: 'hy3',
    modelOptions: ['hy4free', 'hy3', 'kimi-k3-1'],
    modelDisplayNames: { hy4free: 'Hy4', hy3: 'Hy3', 'kimi-k3-1': 'Kimi-K3' },
    modelCredits: {
      hy4free: 'x0.00 credits',
      hy3: 'x0.00 credits',
      'kimi-k3-1': 'x1.62 credits',
    },
    thoughtLevels: [
      { value: 'enabled', name: 'On（默认）' },
      { value: 'disabled', name: 'Off' },
    ],
  })),
}));

function makeConfig(overrides?: Record<string, unknown>): AppConfig {
  return { feishu: { appId: 'test', appSecret: 'test' }, ...overrides } as AppConfig;
}

describe('CodebuddyConfigBuilder', () => {
  const builder = new CodebuddyConfigBuilder();

  describe('buildFields', () => {
    beforeEach(() => {
      // buildFields 几乎在每个用例里都会点火目录探针；两个 mock 的调用记录与
      // mockReturnValueOnce 队列必须跨用例隔离，否则 toHaveBeenCalledTimes(1)
      // 会被前面用例累计的调用打挂。mockReset 会连工厂里的默认实现一起清掉，
      // 这里显式恢复成与生产一致的口径（resolve 原样返回显式 env）。
      vi.mocked(refreshCodebuddyCatalog).mockReset();
      vi.mocked(refreshCodebuddyCatalog).mockResolvedValue(null);
      vi.mocked(resolveCodebuddyEnv).mockReset();
      vi.mocked(resolveCodebuddyEnv).mockImplementation(
        (env: Record<string, string | undefined> = {}) => env,
      );
      vi.mocked(resolveCodebuddyModel).mockReset();
      vi.mocked(resolveCodebuddyModel).mockImplementation((configured?: string) => configured);
    });

    it('model renders as a select over the ACP catalog (name + credits, no id)', () => {
      const fields = builder.buildFields(makeConfig());
      const modelField = fields.find((f) => f.key === 'agents.codebuddy.model');
      expect(modelField!.type).toBe('select');
      // 与 claude / codex 的模型字段同一种控件；id 多数只是名称的重复，不展示。
      expect(modelField!.options).toEqual([
        { value: 'hy4free', text: 'Hy4 x0.00' },
        { value: 'hy3', text: 'Hy3 x0.00' },
        { value: 'kimi-k3-1', text: 'Kimi-K3 x1.62' },
      ]);
      expect(modelField!.currentValue).toBe('hy3');
    });

    it('appends the id only when name + credits collide', () => {
      vi.mocked(loadCodebuddyConfig).mockReturnValueOnce({
        currentModel: 'a',
        modelOptions: ['a', 'b'],
        modelDisplayNames: { a: 'Same', b: 'Same' },
        modelCredits: { a: 'x0.10', b: 'x0.10' },
        thoughtLevels: [{ value: 'enabled', name: 'On（默认）' }],
      });
      const field = builder
        .buildFields(makeConfig())
        .find((f) => f.key === 'agents.codebuddy.model');
      expect(field!.options).toEqual([
        { value: 'a', text: 'Same x0.10（a）' },
        { value: 'b', text: 'Same x0.10（b）' },
      ]);
    });

    it('configured model overrides the catalog current', () => {
      const fields = builder.buildFields(
        makeConfig({ agents: { codebuddy: { model: 'hy4free' } } }),
      );
      expect(fields.find((f) => f.key === 'agents.codebuddy.model')!.currentValue).toBe('hy4free');
    });

    it('配置的 model 被账号清单校正时，卡片显示校正后的值', () => {
      // 换账号后配置里还是旧账号的 id：卡片不能回显一个一发就 400 的值，
      // 必须走 resolveCodebuddyModel（账号清单在它内部裁决）。
      vi.mocked(resolveCodebuddyModel).mockReturnValueOnce('hy3');
      const fields = builder.buildFields(
        makeConfig({ agents: { codebuddy: { model: 'sg-model' } } }),
      );
      expect(resolveCodebuddyModel).toHaveBeenCalledWith('sg-model');
      expect(fields.find((f) => f.key === 'agents.codebuddy.model')!.currentValue).toBe('hy3');
    });

    it('thinking level select: default sentinel = follow CodeBuddy default', () => {
      const fields = builder.buildFields(
        makeConfig({ agents: { codebuddy: { thinkingLevel: 'high' } } }),
      );
      const field = fields.find((f) => f.key === 'agents.codebuddy.thinkingLevel');
      expect(field!.type).toBe('select');
      expect(field!.options).toEqual([
        { value: 'default', text: 'default（跟随 CodeBuddy 默认）' },
        { value: 'enabled', text: 'On（默认）' },
        { value: 'disabled', text: 'Off' },
      ]);
      expect(field!.currentValue).toBe('high');
      // 未配置时下拉必须显示 default 哨兵（空串会被飞书渲染成 placeholder）
      const unset = builder
        .buildFields(makeConfig())
        .find((f) => f.key === 'agents.codebuddy.thinkingLevel');
      expect(unset!.currentValue).toBe('default');
    });

    it('sandbox select with default sentinel and string→boolean coercion', () => {
      const fields = builder.buildFields(makeConfig());
      const field = fields.find((f) => f.key === 'agents.codebuddy.sandbox');
      expect(field!.type).toBe('select');
      expect(field!.currentValue).toBe('default');
      expect((field!.options as ReadonlyArray<{ value: string }>)[0].value).toBe('default');
      const patches = builder.handleFieldChange('agents.codebuddy.sandbox', 'true', makeConfig());
      expect(patches).toEqual([{ key: 'agents.codebuddy.sandbox', value: true }]);
      // 非字符串输入（boolean 口径）走 Boolean(value) 收敛，不静默清配置。
      expect(builder.handleFieldChange('agents.codebuddy.sandbox', true, makeConfig())).toEqual([
        { key: 'agents.codebuddy.sandbox', value: true },
      ]);
      expect(builder.handleFieldChange('agents.codebuddy.sandbox', false, makeConfig())).toEqual([
        { key: 'agents.codebuddy.sandbox', value: false },
      ]);
      const cleared = builder.handleFieldChange(
        'agents.codebuddy.sandbox',
        'default',
        makeConfig(),
      );
      expect(cleared).toEqual([{ key: 'agents.codebuddy.sandbox', value: undefined }]);
      // 旧卡片残留的空串哨兵同义
      expect(builder.handleFieldChange('agents.codebuddy.sandbox', '', makeConfig())).toEqual([
        { key: 'agents.codebuddy.sandbox', value: undefined },
      ]);
    });

    it('permissionMode is a select over the official modes enum (incl. fullAccess)', () => {
      const fields = builder.buildFields(makeConfig());
      const permField = fields.find((f) => f.key === 'agents.codebuddy.permissionMode');
      expect(permField!.type).toBe('select');
      const values = permField!.options!.map((o) => (typeof o === 'string' ? o : o.value));
      expect(values).toEqual([
        'default',
        'acceptEdits',
        'bypassPermissions',
        'plan',
        'dontAsk',
        'auto',
        'fullAccess',
      ]);
      expect(permField!.currentValue).toBe('default');
    });

    it('exposes acp.turnIdleTimeoutMinutes', () => {
      const fields = builder.buildFields(makeConfig());
      expect(
        fields.find((f) => f.key === 'agents.codebuddy.acp.turnIdleTimeoutMinutes'),
      ).toBeDefined();
    });

    it('buildFields fires the catalog refresh (wiring pinned; probe mocked)', () => {
      builder.buildFields(makeConfig());
      expect(refreshCodebuddyCatalog).toHaveBeenCalledTimes(1);
    });

    it('buildFields 把 agents.codebuddy.env 透给目录探针', () => {
      const config = makeConfig({
        agents: { codebuddy: { env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' } } },
      });
      builder.buildFields(config);
      // binary/timeoutMs 走默认；第三个参数必须与 runner 的 env 是同一份配置。
      expect(refreshCodebuddyCatalog).toHaveBeenCalledWith(undefined, undefined, {
        CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
      });
    });

    it('buildFields 走统一 env 口径：自动判定区域叠加到探针参数', () => {
      vi.mocked(resolveCodebuddyEnv).mockReturnValueOnce({
        CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
      });
      builder.buildFields(makeConfig());
      expect(resolveCodebuddyEnv).toHaveBeenCalledTimes(1);
      // 卡片不能自己读配置拼 env，必须与 runner 共用同一个 resolve 结果。
      expect(refreshCodebuddyCatalog).toHaveBeenCalledWith(undefined, undefined, {
        CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
      });
    });

    it('renders as a v1-safe card container (no tag:action)', () => {
      const config = makeConfig();
      const fields = builder.buildFields(config);
      const tabs = [{ id: 'codebuddy', label: 'CodeBuddy', fields }];
      const cardStr = JSON.stringify(buildConfigCardFromTabs(tabs, config));
      expect(cardStr).toContain('"schema":"2.0"');
      expectNoV1ActionContainer(cardStr);
      expect(cardStr).toContain('"cmd":"config.');
      // 模型下拉的选项文本：展示名 + 费率。
      expect(cardStr).toContain('Hy3 x0.00');
    });
  });

  describe('handleFieldChange', () => {
    it('empty model/thinkingLevel and thinking default sentinel clear the config', () => {
      const patches = builder.handleFieldChange('agents.codebuddy.model', '   ', makeConfig());
      expect(patches).toEqual([{ key: 'agents.codebuddy.model', value: undefined }]);
      const sentinel = builder.handleFieldChange(
        'agents.codebuddy.thinkingLevel',
        'default',
        makeConfig(),
      );
      expect(sentinel).toEqual([{ key: 'agents.codebuddy.thinkingLevel', value: undefined }]);
      // 旧卡片残留的空串哨兵同义
      const cleared = builder.handleFieldChange('agents.codebuddy.thinkingLevel', '', makeConfig());
      expect(cleared).toEqual([{ key: 'agents.codebuddy.thinkingLevel', value: undefined }]);
    });

    it('non-empty values pass through', () => {
      const patches = builder.handleFieldChange(
        'agents.codebuddy.permissionMode',
        'acceptEdits',
        makeConfig(),
      );
      expect(patches).toEqual([{ key: 'agents.codebuddy.permissionMode', value: 'acceptEdits' }]);
    });
  });
});
