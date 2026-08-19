/**
 * DshConfigBuilder — /config card fields for the DSH agent.
 *
 * DSH (DeepSeek Harness) is an HTTP-only agent. Beyond the Web Host base URL it
 * exposes three runtime-configurable knobs — preset, model, reasoning effort.
 *
 * 清单来源分两期：
 * - 动态清单（当前实现）：打开 /config 前通过 `llm.models` / `agentPreset.list`
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
import type { DshModelCatalogValue, DshPresetListValue } from '../../runner/dsh/types.js';

/** DshConfigBuilder 预取只依赖的 client 方法子集。 */
export interface DshCatalogClient {
  listModels(): Promise<DshModelCatalogValue>;
  listPresets(): Promise<DshPresetListValue>;
}

/** 固定兜底 preset 清单（DSH rc.7 实测；动态拉取失败时使用）。 */
const FALLBACK_PRESET_OPTIONS: SelectOption[] = [
  { text: 'standard（标准模式）', value: 'standard' },
  { text: 'minimal（极简模式）', value: 'minimal' },
  { text: 'code（PTC 模式）', value: 'code' },
  { text: 'cordis（创造模式）', value: 'cordis' },
];

/** 固定兜底模型清单（DSH rc.7 实测；动态拉取失败时使用）。 */
const FALLBACK_MODEL_OPTIONS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

/** 固定兜底推理档位（llm.models 实际档位；动态拉取失败时使用）。 */
const FALLBACK_EFFORT_OPTIONS = ['off', 'low', 'high', 'max'] as const;

/** 「跟随服务端默认」哨兵值：select value 用空串，保存时转 undefined 删除键。 */
const DEFAULT_SENTINEL = '';

export class DshConfigBuilder implements AgentConfigCardBuilder {
  /** 最近一次预取用的 host；host 变更时缓存失效（下一张卡重新拉取）。 */
  private prefetchHost: string | undefined;
  private modelCatalog: DshModelCatalogValue | undefined;
  private presets: DshPresetListValue | undefined;
  /** 可注入 client 工厂（测试用）；默认生产实现。 */
  private readonly clientFactory: (baseUrl: string) => DshCatalogClient;

  constructor(clientFactory?: (baseUrl: string) => DshCatalogClient) {
    this.clientFactory = clientFactory ?? ((base) => new DshClient(base));
  }

  /** 异步预取模型/预设目录（§4.2 二期动态清单）。失败/离线静默回退固定兜底清单，
   *  卡不依赖 DSH 服务在线；同一 host 只拉一次，避免每次刷卡重复请求。 */
  async prefetch(host?: string): Promise<void> {
    const base = (host ?? DEFAULT_DSH_HOST).replace(/\/$/, '');
    if (!base || base === this.prefetchHost) return;
    const client = this.clientFactory(base);
    try {
      this.modelCatalog = await client.listModels();
    } catch (err) {
      getLogger().warn(
        `[dsh-config] llm.models prefetch failed (falling back to fixed catalog): ${(err as Error).message}`,
      );
      this.modelCatalog = undefined;
    }
    try {
      this.presets = await client.listPresets();
    } catch (err) {
      getLogger().warn(
        `[dsh-config] agentPreset.list prefetch failed (falling back to fixed presets): ${(err as Error).message}`,
      );
      this.presets = undefined;
    }
    this.prefetchHost = base;
  }

  /** 同步注入 catalog/presets（测试用，替代异步 prefetch；标记 prefetchHost 使
   *  后续 prefetch 短路，避免测试误触发网络请求）。 */
  setCatalog(catalog: DshModelCatalogValue, presets?: DshPresetListValue): void {
    this.modelCatalog = catalog;
    if (presets) this.presets = presets;
    this.prefetchHost = 'injected';
  }

  /** 展平 llm.models 各 provider group 的模型 id；无 catalog 时回退固定清单。 */
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
    const currentModel = dsh?.model ?? DEFAULT_SENTINEL;
    const currentEffort = dsh?.reasoningEffort ?? DEFAULT_SENTINEL;

    const modelOptions = this.modelOptions();
    const isCustomModel = currentModel !== DEFAULT_SENTINEL && !modelOptions.includes(currentModel);
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
        label: '预设模式',
        type: 'select',
        options: [{ text: '跟随服务端默认', value: DEFAULT_SENTINEL }, ...this.presetOptions()],
        currentValue: currentPreset,
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
