/**
 * DshConfigBuilder — /config card fields for the DSH agent.
 *
 * DSH (DeepSeek Harness) is an HTTP-only agent. The card exposes the Web Host
 * base URL plus preset/provider/model/reasoning-effort knobs. The launch token
 * is a YAML-only fallback and is never rendered or saved through the card.
 *
 * 清单来源：
 * - 动态清单：打开 /config 前通过 `session/modelCatalog` / `agentPresets/list`
 *   预取（Router 调 `prefetch()`），失败/离线回退固定兜底清单，卡不依赖
 *   DSH 服务在线。
 * - provider / model / reasoningEffort 用空字符串哨兵表示「跟随默认」：select
 *   的 value `''` 在 handleFieldChange 中被转成 undefined patch（router 删除
 *   键），config.yaml 不写该键 = 服务端默认。
 * - provider 没有哨兵：旧配置没有 provider 时按 `deepseek-official` 生效，
 *   与 runner 的兼容规则一致。provider 清单不硬编码，来自服务端目录。
 */

import type { AgentConfigCardBuilder, ConfigField, SelectOption } from './types.js';
import { DEFAULT_DSH_HOST, type AppConfig, type DshConfig } from '../../config/index.js';
import { DshClient } from '../../runner/dsh/client.js';
import { getLogger } from '../../logger/index.js';
import type {
  DshModelCatalogValue,
  DshPermissionCatalogValue,
  DshPresetListValue,
} from '../../runner/dsh/types.js';

/** DshConfigBuilder 预取只依赖的 client 方法子集。 */
export interface DshCatalogClient {
  listModels(): Promise<DshModelCatalogValue>;
  listPresets(): Promise<DshPresetListValue>;
  listPermissionPresets(): Promise<DshPermissionCatalogValue>;
}

/** 旧配置没有 provider 时的生效值（与 DshRunner 的兼容规则一致）。 */
const LEGACY_PROVIDER = 'deepseek-official';

/** 固定兜底 preset 清单（DSH 0.2.x 实测；动态拉取失败时使用）。 */
const FALLBACK_PRESET_OPTIONS: SelectOption[] = [
  { text: 'standard（标准模式）', value: 'standard' },
  { text: 'minimal（极简模式）', value: 'minimal' },
  { text: 'ptc（PTC 模式）', value: 'ptc' },
  { text: 'cordis（创造模式）', value: 'cordis' },
];

/** 固定兜底模型清单（DSH 0.2.x 实测；动态拉取失败时使用）。 */
const FALLBACK_MODEL_OPTIONS = ['deepseek-flash', 'deepseek-v4-pro'];

/** 固定兜底推理档位（session/modelCatalog 实际档位；动态拉取失败时使用）。 */
const FALLBACK_EFFORT_OPTIONS = ['off', 'low', 'high', 'max'] as const;

/** 固定兜底权限预设（DSH 0.2.x 实测；动态拉取失败时使用）。 */
const FALLBACK_PERMISSION_OPTIONS: SelectOption[] = [
  { text: 'read-only（只读）', value: 'read-only' },
  { text: 'workspace-write（工作区可写）', value: 'workspace-write' },
  { text: 'danger-full-access（完全访问，关闭审批）', value: 'danger-full-access' },
];

/** 「跟随默认」哨兵值：select value 用空串，保存时转 undefined 删除键。 */
const DEFAULT_SENTINEL = '';

export class DshConfigBuilder implements AgentConfigCardBuilder {
  /** 最近一次预取用的 host；host 变更时缓存失效。 */
  private prefetchHost: string | undefined;
  private modelCatalog: DshModelCatalogValue | undefined;
  private presets: DshPresetListValue | undefined;
  private permissionCatalog: DshPermissionCatalogValue | undefined;
  /** 可注入 client 工厂（测试用）；默认生产实现。 */
  private readonly clientFactory: (
    baseUrl: string,
    token?: string,
    credentialsFile?: string,
  ) => DshCatalogClient;

  constructor(
    clientFactory?: (baseUrl: string, token?: string, credentialsFile?: string) => DshCatalogClient,
  ) {
    this.clientFactory =
      clientFactory ??
      ((base, token, credentialsFile) =>
        new DshClient(base, {
          token,
          credentialsFile,
          // 卡片预取是交互路径：DSH 卡死时最多等 5 秒后回退固定清单。
          requestTimeoutMs: 5_000,
        }));
  }

  /**
   * 异步预取模型/预设目录。失败/离线静默回退固定兜底清单，卡不依赖 DSH
   * 服务在线。`force` 用于打开 /config 时强制刷新（在 DSH Web UI 新增
   * provider 后不需要重启 lark-remote）。三个请求并行，最坏等待一个超时。
   */
  async prefetch(
    host?: string,
    token?: string,
    credentialsFile?: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const base = (host ?? DEFAULT_DSH_HOST).replace(/\/$/, '');
    const key = `${base}\u0000${token ?? ''}\u0000${credentialsFile ?? ''}`;
    if (!base || (!options.force && key === this.prefetchHost)) return;
    const client = this.clientFactory(base, token, credentialsFile);
    const [models, presets, permissions] = await Promise.allSettled([
      client.listModels(),
      client.listPresets(),
      client.listPermissionPresets(),
    ]);

    if (models.status === 'fulfilled') {
      this.modelCatalog = models.value;
    } else {
      getLogger().warn(
        `[dsh-config] session/modelCatalog prefetch failed (falling back to fixed catalog): ${(models.reason as Error).message}`,
      );
      this.modelCatalog = undefined;
    }
    if (presets.status === 'fulfilled') {
      this.presets = presets.value;
    } else {
      getLogger().warn(
        `[dsh-config] agentPresets/list prefetch failed (falling back to fixed presets): ${(presets.reason as Error).message}`,
      );
      this.presets = undefined;
    }
    if (permissions.status === 'fulfilled') {
      this.permissionCatalog = permissions.value;
    } else {
      getLogger().warn(
        `[dsh-config] permissionPresets/catalog prefetch failed (falling back to fixed presets): ${(permissions.reason as Error).message}`,
      );
      this.permissionCatalog = undefined;
    }
    this.prefetchHost = key;
  }

  /** 同步注入 catalog/presets（测试用，替代异步 prefetch；标记 prefetchHost 使
   *  后续 prefetch 短路，避免测试误触发网络请求）。 */
  setCatalog(
    catalog: DshModelCatalogValue,
    presets?: DshPresetListValue,
    permissionCatalog?: DshPermissionCatalogValue,
  ): void {
    this.modelCatalog = catalog;
    if (presets) this.presets = presets;
    if (permissionCatalog) this.permissionCatalog = permissionCatalog;
    this.prefetchHost = 'injected';
  }

  /** Provider 下拉：目录 groups + 当前值兜底；离线时只保留当前值。 */
  private providerOptions(currentProvider: string, configured: boolean): SelectOption[] {
    const options: SelectOption[] = [];
    if (this.modelCatalog) {
      for (const group of this.modelCatalog.groups) {
        options.push({
          text: group.name && group.name !== group.id ? `${group.name}（${group.id}）` : group.id,
          value: group.id,
        });
      }
    }
    if (!options.some((option) => option.value === currentProvider)) {
      const source = configured ? '当前配置' : '默认';
      options.push({
        text: this.modelCatalog
          ? `${currentProvider}（${source}，服务端未列出）`
          : `${currentProvider}（${source}，离线未校验）`,
        value: currentProvider,
      });
    }
    return options;
  }

  /**
   * 当前 provider 的模型清单。目录在线但该 provider 不在目录中时返回空列表
   * （不把 DeepSeek 模型冒充成其他 provider 的模型）；目录离线时用固定兜底。
   */
  private modelOptionsFor(provider: string): readonly (string | SelectOption)[] {
    if (!this.modelCatalog) return FALLBACK_MODEL_OPTIONS;
    const group = this.modelCatalog.groups.find((entry) => entry.id === provider);
    if (!group) return [];
    return group.models.map((model) => ({
      text: model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id,
      value: model.id,
    }));
  }

  private modelValues(provider: string): readonly string[] {
    return this.modelOptionsFor(provider).map((option) =>
      typeof option === 'string' ? option : option.value,
    );
  }

  /** Provider 的默认模型：目录默认值属于该 provider 时优先，否则首个模型。 */
  private defaultModelFor(provider: string): string | undefined {
    const group = this.modelCatalog?.groups.find((entry) => entry.id === provider);
    if (!group || group.models.length === 0) return undefined;
    const defaultModel =
      this.modelCatalog?.default?.provider === provider
        ? this.modelCatalog.default.model
        : undefined;
    return defaultModel && group.models.some((model) => model.id === defaultModel)
      ? defaultModel
      : group.models[0]!.id;
  }

  /**
   * 模型可用的推理档位。目录在线时严格按模型声明：模型没有 reasoning 元数据
   * 就返回空（只留「跟随模型默认」），避免把 A 模型的档位塞给 B 模型。
   */
  private effortOptionsFor(provider: string, model?: string): readonly string[] {
    if (!this.modelCatalog) return FALLBACK_EFFORT_OPTIONS;
    const group = this.modelCatalog.groups.find((entry) => entry.id === provider);
    if (!group) return [];
    const target = model ?? this.defaultModelFor(provider);
    const entry = target ? group.models.find((candidate) => candidate.id === target) : undefined;
    return entry?.reasoning?.efforts.map((effort) => effort.id) ?? [];
  }

  /** preset 清单；无 presets 时回退固定清单。显示名优先用 preset.yml 的 name。 */
  private presetOptions(): readonly SelectOption[] {
    if (this.presets && this.presets.presets.length > 0) {
      return this.presets.presets
        .filter((p) => !p.broken)
        .map((p) => ({ text: p.name ? `${p.id}（${p.name}）` : p.id, value: p.id }));
    }
    return FALLBACK_PRESET_OPTIONS;
  }

  /** 权限预设清单；配置默认只允许 defaultOptions（auto 只适用于当前会话）。 */
  private permissionOptions(): readonly SelectOption[] {
    const entries = this.permissionCatalog?.defaultOptions;
    if (entries && entries.length > 0) {
      return entries.map((p) => ({
        text:
          p.value === 'read-only'
            ? 'read-only（只读）'
            : p.value === 'workspace-write'
              ? 'workspace-write（工作区可写）'
              : p.value === 'danger-full-access'
                ? 'danger-full-access（完全访问，关闭审批）'
                : p.name && p.name !== p.value
                  ? `${p.value}（${p.name}）`
                  : p.value,
        value: p.value,
      }));
    }
    return FALLBACK_PERMISSION_OPTIONS;
  }

  /** “跟随服务端默认”文案带上实际默认值，避免用户不知道默认是什么。 */
  private permissionDefaultText(): string {
    const current = this.permissionCatalog?.defaultPreset;
    return current ? `跟随服务端默认（当前 ${current}）` : '跟随服务端默认';
  }

  buildFields(displayConfig: AppConfig): ConfigField[] {
    const dsh = displayConfig.agents?.dsh as DshConfig | undefined;
    const currentHost = dsh?.host ?? DEFAULT_DSH_HOST;
    const currentPreset = dsh?.agentPreset ?? DEFAULT_SENTINEL;
    const currentPermission = dsh?.permissionPreset ?? DEFAULT_SENTINEL;
    const configuredProvider = dsh?.provider;
    const currentProvider = configuredProvider ?? LEGACY_PROVIDER;
    const currentModel = dsh?.model ?? DEFAULT_SENTINEL;
    const currentEffort = dsh?.reasoningEffort ?? DEFAULT_SENTINEL;

    const providerOptions = this.providerOptions(currentProvider, configuredProvider !== undefined);
    const modelOptions = this.modelOptionsFor(currentProvider);
    const isCustomModel =
      currentModel !== DEFAULT_SENTINEL &&
      !this.modelValues(currentProvider).includes(currentModel);
    const permissionOptions = [...this.permissionOptions()];
    if (
      currentPermission !== DEFAULT_SENTINEL &&
      !permissionOptions.some((option) => option.value === currentPermission)
    ) {
      permissionOptions.push({
        text: `${currentPermission}（当前配置，服务端未列出）`,
        value: currentPermission,
      });
    }
    const effortOptions: SelectOption[] = this.effortOptionsFor(
      currentProvider,
      currentModel || undefined,
    ).map((value) => ({ text: value, value }));
    if (
      currentEffort !== DEFAULT_SENTINEL &&
      !effortOptions.some((option) => option.value === currentEffort)
    ) {
      effortOptions.push({
        text: `${currentEffort}（当前配置，模型未列出）`,
        value: currentEffort,
      });
    }

    const fields: ConfigField[] = [
      {
        key: 'agents.dsh.host',
        label: 'DSH Web Host',
        type: 'input',
        currentValue: currentHost,
      },
      {
        key: 'agents.dsh.agentPreset',
        label: '预设模式（工具集）',
        type: 'select',
        options: [{ text: '跟随服务端默认', value: DEFAULT_SENTINEL }, ...this.presetOptions()],
        currentValue: currentPreset,
      },
      {
        key: 'agents.dsh.permissionPreset',
        label: '权限预设（沙箱 + 审批）',
        type: 'select',
        options: [
          { text: this.permissionDefaultText(), value: DEFAULT_SENTINEL },
          ...permissionOptions,
        ],
        currentValue: currentPermission,
      },
      {
        key: 'agents.dsh.provider',
        label: 'Provider（模型服务商）',
        type: 'select',
        options: providerOptions,
        currentValue: currentProvider,
      },
      {
        key: 'agents.dsh.model',
        label: '使用模型',
        type: 'select',
        options: [{ text: '跟随该 Provider 默认', value: DEFAULT_SENTINEL }, ...modelOptions],
        // 自定义模型不在下拉里：让下拉停在哨兵，模型名由下方输入框承载。
        currentValue: isCustomModel ? DEFAULT_SENTINEL : currentModel,
      },
      // 自定义模型名输入框（与 codex/claude 一致的行为）
      {
        key: 'agents.dsh.model',
        label: '自定义模型名',
        type: 'input',
        currentValue: isCustomModel ? currentModel : '',
      },
      {
        key: 'agents.dsh.reasoningEffort',
        label: '推理强度',
        type: 'select',
        options: [{ text: '跟随模型默认', value: DEFAULT_SENTINEL }, ...effortOptions],
        currentValue: currentEffort,
      },
    ];

    const failures = this.modelCatalog?.failures ?? [];
    if (failures.length > 0) {
      fields.push({
        key: 'agents.dsh.providerFailures',
        label: `⚠️ Provider 目录异常：${failures
          .map((failure) => `${failure.id}（${failure.message}）`)
          .join('；')}`,
        type: 'note',
      });
    }

    return fields;
  }

  handleFieldChange(
    key: string,
    value: unknown,
    config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    // provider 没有哨兵：切换时联动 model/effort，避免 provider 与 model 来自
    // 不同目录（selectModel 会以 session/model-unavailable 失败）。
    if (key === 'agents.dsh.provider' && typeof value === 'string') {
      return this.providerChangePatches(value, config);
    }

    const patches: Array<{ key: string; value: unknown }> = [];
    // 空串哨兵「跟随默认」→ undefined patch（router 删除键）
    const effective = value === DEFAULT_SENTINEL ? undefined : value;
    patches.push({ key, value: effective });

    // 模型变更时，把 provider 固定到当前 provider（旧配置只有 model 时，
    // 第一次选模型即完成迁移），并按新模型重置不被支持的档位。
    if (key === 'agents.dsh.model' && typeof value === 'string') {
      const newModel = effective as string | undefined;
      const provider = config.agents?.dsh?.provider ?? LEGACY_PROVIDER;
      if (newModel) {
        patches.push({ key: 'agents.dsh.provider', value: provider });
      }
      const effortPatch = this.effortPatchForModel(config, provider, newModel);
      if (effortPatch) patches.push(effortPatch);
    }
    return patches;
  }

  /** 切 provider 后的联动：provider → 新 provider 的默认/首个模型 → 合法档位。 */
  private providerChangePatches(
    provider: string,
    config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    const patches: Array<{ key: string; value: unknown }> = [
      { key: 'agents.dsh.provider', value: provider },
    ];
    if (!this.modelCatalog) return patches;

    const group = this.modelCatalog.groups.find((entry) => entry.id === provider);
    if (!group) return patches;

    const currentModel = config.agents?.dsh?.model;
    const keepModel =
      currentModel !== undefined && group.models.some((model) => model.id === currentModel);
    const nextModel = keepModel ? currentModel : this.defaultModelFor(provider);
    if (nextModel !== currentModel) {
      patches.push({ key: 'agents.dsh.model', value: nextModel });
    }
    const effortPatch = this.effortPatchForModel(config, provider, nextModel);
    if (effortPatch) patches.push(effortPatch);
    return patches;
  }

  /**
   * 切到 (provider, newModel) 后的档位补丁：当前档位仍被新模型支持 → 不产出；
   * 否则用新模型目录中位；目录离线 → 不产出（保留现状，由服务端校验）；
   * 模型无 reasoning 元数据 → 清空档位（跟随模型默认）。
   */
  private effortPatchForModel(
    config: AppConfig,
    provider: string,
    newModel: string | undefined,
  ): { key: string; value: string | undefined } | null {
    const currentEffort = config.agents?.dsh?.reasoningEffort as string | undefined;
    if (!newModel) {
      return currentEffort ? { key: 'agents.dsh.reasoningEffort', value: undefined } : null;
    }
    if (!this.modelCatalog) return null;
    const supported = this.effortOptionsFor(provider, newModel);
    if (currentEffort && supported.includes(currentEffort)) return null;
    // 新模型目录中位档位；偶数长度取偏高位（off/low → low，符合 DSH 默认 high 语义）
    const middle = supported[Math.floor(supported.length / 2)];
    return { key: 'agents.dsh.reasoningEffort', value: middle };
  }
}
