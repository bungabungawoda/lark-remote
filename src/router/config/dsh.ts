/**
 * DshConfigBuilder — /config card fields for the DSH agent.
 *
 * DSH (DeepSeek Harness) is an HTTP-only agent. The card exposes the Web Host
 * base URL plus preset/model/reasoning-effort knobs. The launch token is a
 * YAML-only fallback and is never rendered or saved through the card.
 *
 * 清单来源分两期：
 * - 动态清单（当前实现）：打开 /config 前通过 `session/modelCatalog` / `agentPresets/list`
 *   预取（Router 调 `prefetch()`），失败/离线回退下方固定兜底清单，卡不依赖
 *   DSH 服务在线。
 * - 三个可选字段用空字符串哨兵表示「跟随服务端默认」：select 的 value `''`
 *   在 handleFieldChange 中被转成 undefined patch（router 删除键），config.yaml
 *   不写该键 = 服务端默认。
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

/** 「跟随服务端默认」哨兵值：select value 用空串，保存时转 undefined 删除键。 */
const DEFAULT_SENTINEL = '';

export class DshConfigBuilder implements AgentConfigCardBuilder {
  /** 最近一次预取用的 host；host 变更时缓存失效（下一张卡重新拉取）。 */
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
      ((base, token, credentialsFile) => new DshClient(base, { token, credentialsFile }));
  }

  /** 异步预取模型/预设目录（§4.2 二期动态清单）。失败/离线静默回退固定兜底清单，
   *  卡不依赖 DSH 服务在线；同一 host 只拉一次，避免每次刷卡重复请求。 */
  async prefetch(host?: string, token?: string, credentialsFile?: string): Promise<void> {
    const base = (host ?? DEFAULT_DSH_HOST).replace(/\/$/, '');
    const key = `${base}\u0000${token ?? ''}\u0000${credentialsFile ?? ''}`;
    if (!base || key === this.prefetchHost) return;
    const client = this.clientFactory(base, token, credentialsFile);
    try {
      this.modelCatalog = await client.listModels();
    } catch (err) {
      getLogger().warn(
        `[dsh-config] session/modelCatalog prefetch failed (falling back to fixed catalog): ${(err as Error).message}`,
      );
      this.modelCatalog = undefined;
    }
    try {
      this.presets = await client.listPresets();
    } catch (err) {
      getLogger().warn(
        `[dsh-config] agentPresets/list prefetch failed (falling back to fixed presets): ${(err as Error).message}`,
      );
      this.presets = undefined;
    }
    try {
      this.permissionCatalog = await client.listPermissionPresets();
    } catch (err) {
      getLogger().warn(
        `[dsh-config] permissionPresets/catalog prefetch failed (falling back to fixed presets): ${
          (err as Error).message
        }`,
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

  /** 展平 session/modelCatalog 各 provider group 的模型 id；无 catalog 时回退固定清单。 */
  private modelOptions(): readonly string[] {
    if (this.modelCatalog) {
      const ids = this.modelCatalog.groups.flatMap((g) => g.models.map((m) => m.id));
      if (ids.length > 0) return ids;
    }
    return FALLBACK_MODEL_OPTIONS;
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

  /** 模型在 catalog 中声明的推理档位；无 catalog/模型不在目录时回退固定档位。 */
  private effortOptionsForModel(model?: string): readonly string[] {
    if (model && this.modelCatalog) {
      for (const group of this.modelCatalog.groups) {
        const entry = group.models.find((m) => m.id === model);
        if (entry?.reasoning && entry.reasoning.efforts.length > 0) {
          return entry.reasoning.efforts.map((e) => e.id);
        }
      }
    }
    return FALLBACK_EFFORT_OPTIONS;
  }

  buildFields(displayConfig: AppConfig): ConfigField[] {
    const dsh = displayConfig.agents?.dsh as DshConfig | undefined;
    const currentHost = dsh?.host ?? DEFAULT_DSH_HOST;
    const currentPreset = dsh?.agentPreset ?? DEFAULT_SENTINEL;
    const currentPermission = dsh?.permissionPreset ?? DEFAULT_SENTINEL;
    const currentModel = dsh?.model ?? DEFAULT_SENTINEL;
    const currentEffort = dsh?.reasoningEffort ?? DEFAULT_SENTINEL;

    const modelOptions = this.modelOptions();
    const isCustomModel = currentModel !== DEFAULT_SENTINEL && !modelOptions.includes(currentModel);
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
    const effortOptions = this.effortOptionsForModel(
      currentModel === DEFAULT_SENTINEL ? undefined : currentModel,
    );

    return [
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
        key: 'agents.dsh.permissionPreset',
        label:
          'ℹ️ 保存后，下一条 DSH 消息的 run 前生效；运行中的 turn 不会中途切换。danger-full-access 会关闭审批，仅在信任的仓库使用。',
        type: 'note',
      },
      {
        key: 'agents.dsh.model',
        label: '使用模型',
        type: 'select',
        options: [{ text: '跟随服务端默认', value: DEFAULT_SENTINEL }, ...modelOptions],
        currentValue: isCustomModel ? undefined : currentModel,
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
        options: [{ text: '跟随服务端默认', value: DEFAULT_SENTINEL }, ...effortOptions],
        currentValue: currentEffort,
      },
    ];
  }

  handleFieldChange(
    key: string,
    value: unknown,
    config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    const patches: Array<{ key: string; value: unknown }> = [];
    // 空串哨兵「跟随服务端默认」→ undefined patch（router 删除键）
    const effective = value === DEFAULT_SENTINEL ? undefined : value;
    patches.push({ key, value: effective });

    // 模型变更时，若当前档位不被新模型支持，重置（参照 kimi/codex 语义）
    if (key === 'agents.dsh.model' && typeof value === 'string') {
      const effortPatch = this.effortPatchForModel(config, effective as string | undefined);
      if (effortPatch) patches.push(effortPatch);
    }
    return patches;
  }

  /** 切到 newModel 后的档位补丁：当前档位仍被新模型支持 → 不产出；否则用新模型
   *  目录中位；无目录/空列表 → undefined（清空 = 跟随服务端默认）。 */
  private effortPatchForModel(
    config: AppConfig,
    newModel: string | undefined,
  ): { key: string; value: string | undefined } | null {
    const currentEffort = config.agents?.dsh?.reasoningEffort as string | undefined;
    if (!newModel) {
      // 模型被清空（跟随默认）→ 档位一并清空跟随默认
      return currentEffort ? { key: 'agents.dsh.reasoningEffort', value: undefined } : null;
    }
    const supported = this.effortOptionsForModel(newModel);
    if (currentEffort && supported.includes(currentEffort)) return null;
    // 新模型目录中位档位；偶数长度取偏高位（off/low → low，符合 DSH 默认 high 语义）
    const middle = supported[Math.floor(supported.length / 2)];
    return middle
      ? { key: 'agents.dsh.reasoningEffort', value: middle }
      : { key: 'agents.dsh.reasoningEffort', value: undefined };
  }
}
