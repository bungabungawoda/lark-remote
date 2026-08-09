[English](../../en/guides/codex-config.md) | 简体中文

# Codex 配置卡片使用指南

本文档说明 `/config` 卡片中 Codex Agent 的配置字段及其工作原理。

## 概述

Codex Agent 配置通过 `/config` 卡片的交互界面进行管理。当 `defaultAgent` 选择为 `codex` 时，卡片会显示以下字段：

| 字段键 | 显示标签 | 类型 | 说明 |
|--------|----------|------|------|
| `agents.codex.modelProvider` | Codex Provider | select | 模型服务商（内置 `openai` + config.toml `[model_providers.*]`，与 codex `merge_configured_model_providers` 一致；`anthropic` 非 codex 内置 provider，需显式配置） |
| `agents.codex.model` | 使用模型 | select | config.toml `model` + 活动目录 `visibility==='list'` slug（`model_catalog_json` **声明**时 = `codex debug models` 输出；否则 = `--bundled` 内置目录） |
| `agents.codex.reasoningEffort` | 推理强度 | select | 对应 `model_reasoning_effort`，选项随当前模型的 `supported_reasoning_levels` 动态变化 |

> `approval_policy`（`never`）和 `sandbox_mode`（`danger-full-access`）在 runner 内硬编码，不暴露到卡片（见 `src/runner/codex/argv.ts`）。

## 字段键映射原则

为确保读和写使用一致的键路径，Codex 字段使用 `agents.codex.*` 前缀：

- **卡片字段 key**: `agents.codex.modelProvider`（用于 UI 构建和回调）
- **pendingConfig 存储**: `pendingConfig.agents.codex.modelProvider`
- **getConfigValue 读取**: `config.agents.codex.modelProvider`

这与 Pi Agent 的模式一致（`agents.pi.*`），避免读路径和写路径的 key 映射不对称问题。

## 动态模型列表

Codex 的模型下拉选项从 `~/.codex/config.toml` 动态读取：

```typescript
// src/config/codex-config.ts
import { loadCodexConfig } from '../config/codex-config.js';

const codexCfg = loadCodexConfig({ binary: 'codex' });
const providerNames = codexCfg.providerNames;  // 内置 openai + config.toml [model_providers.*]
                                               // （anthropic 非内置，需显式配置）
const modelOptions = codexCfg.modelOptions();  // catalog 模式：活动目录 visibility==='list' 的 slug
                                               // 非 catalog 模式：bundled 中 visibility==='list' 的 slug
```

### 配置源格式

`model_catalog_json`（codex 0.14x+）会把模型目录**整体替换**：一旦配置，codex 运行时
只认该 JSON 文件里的模型（`codex debug models` 输出），内置 `--bundled` 目录不再参与。
因此卡片在 catalog 模式下：

- provider 下拉 = 内置 `openai` + `[model_providers.*]`（对齐 codex
  `merge_configured_model_providers(built_in_model_providers, cfg.model_providers)`，
  `core/src/config/mod.rs:3655`；`model_provider` 未声明时默认 `"openai"`，mod.rs:3659）；
  `anthropic`/`amazon-bedrock`/`ollama`/`lmstudio` 等其余内置 provider 未显式配置
  section/凭据时不列出（当前单用户 API-key 场景）；
- 模型下拉只列活动目录中的模型；
- 推理强度下拉/默认值取活动目录中该模型的 `supported_reasoning_levels` /
  `default_reasoning_level`（如 deepseek-v4-flash = `low/high/max`，默认 `high`）；
- 活动目录命令不可用时模型列表回退 config.toml 当前 `model`（不泄漏内置/FALLBACK 模型）。

`~/.codex/config.toml` 示例：

```toml
model = "glm-5.2"
model_provider = "volcengine-coding-plan"

[model_providers.volcengine-coding-plan]
name = "volcengine-coding-plan"
base_url = "https://ark.example.com/api/v3"
env_key = "ARK_API_KEY"
wire_api = "responses"
```

`loadCodexConfig()` 解析：
- `model` → 当前选中的模型
- `model_provider` → 当前选中的 provider
- `[model_providers.*]` → provider 列表（从 section 名提取）

### Fallback 行为

未**声明** `model_catalog_json` 时，卡片走非 catalog 模式：provider 含内置
`openai`（anthropic 不是 codex 内置 provider，需在 `[model_providers.anthropic]` 显式配置），
模型列表来自 `codex debug models --bundled`。

- **已声明但非法**（`model_catalog_json = ""` 或非字符串）：仍按 catalog 声明退化处理
  （与 codex 运行时一致：目录加载失败是硬错误，不回退内置目录）——卡片此时只展示
  config.toml 当前 `model`，不泄漏内置模型。
- **config.toml 解析失败**（语法错误，无法得知是否声明）：按**非 catalog**
  处理，走 bundled + 内置默认值兜底。
- **config.toml 不存在或解析失败、且 bundled 命令也失败**：使用内置默认值：

- **Provider**: `['openai']`
- **Model**: 目录首个可用模型（目录不可用时 `['o3', 'o4-mini', 'gpt-4o', ...]` 兜底）

> **API-key 模式假设**：本项目以 API-key 模式运行 codex
> （`forced_login_method = "api"`），因此卡片：
> - 按 `supported_in_api === true` 过滤模型——等价于 codex 的
>   `chatgpt_mode || supported_in_api`（`openai_models.rs` `filter_by_auth`），
>   ChatGPT 登录模式下 codex 会显示全部模型，本项目不支持该模式；
> - 非 catalog 模式用 `--bundled` 而非无参 `debug models`——无参版本在
>   `uses_codex_backend()/has_command_auth()` 时会请求远端 `/models`，API-key
>   模式下结果与 bundled 一致；ChatGPT/命令认证配置下卡片可能不反映远端目录。

### 已知限制

`model_catalog_json` 仅从 `~/.codex/config.toml` 单层读取。codex 自身支持分层配置
（项目 `.codex/`、profile、enterprise 层都可能声明该字段）；若目录声明来自非用户层，
卡片会误判为非 catalog 模式并展示 bundled 列表。真实 run 仍按 codex 分层语义使用该目录。
本项目按单用户本地使用场景，暂不镜像分层加载，涉及此类配置的用户需在
`~/.codex/config.toml` 显式声明。

## Provider 切换逻辑

当用户切换 `Codex Provider` 下拉框时，系统会自动：

1. 更新 `agents.codex.modelProvider` 的值
2. 重新计算该 provider 下的有效模型列表
3. 如果当前选中的模型不在新 provider 的列表中，自动重置为该 provider 的首个模型
4. **同时对新模型执行推理强度校验**：若当前档位不被新模型支持，
   按 with_model 语义重置/清空——否则旧模型的档位会透传给不支持它的模型
   （codex 只在会话中 with_model 时钳制，session 创建路径不钳制）

```typescript
// router/index.ts - config.set 处理
if (key === 'agents.codex.modelProvider' && newValue) {
  const codexBinary = this.pendingConfig?.agents?.codex?.binary ?? 'codex';
  const codexCfg = loadCodexConfig({ binary: codexBinary });
  const newModelOptions = codexCfg.modelOptions(newValue);
  const currentModel = this.pendingConfig?.agents?.codex?.model;
  const currentModelIsValid = newModelOptions.some(m => m === currentModel);
  if (!currentModelIsValid && newModelOptions.length > 0) {
    this.setNestedValue(this.pendingConfig!, 'agents.codex.model', newModelOptions[0]);
  }
}
```

## 模型切换联动推理强度

当用户切换 `使用模型` 下拉框时，系统会自动校验当前 `reasoningEffort` 是否仍被新模型支持，
不支持则按 codex `with_model` 语义重置（`src/router/config/codex.ts` `CodexConfigBuilder.handleFieldChange`）：
取新模型 `supported_reasoning_levels` 的**中位档位** `(len-1)/2`；声明列表为空时才用
`default_reasoning_level`；两者都无则**清空档位**（codex 语义：不传 effort）。清空时
`handleFieldChange` 产出 `value=undefined` 的补丁，router `setNestedValue` 将其视为
**删除键**，保存路径从 `config.yaml` 删除 `reasoningEffort`，不会写入字面量 `"undefined"`：

```typescript
// src/router/config/codex.ts - handleFieldChange
const effortPatch = this.effortPatchForModel(config, newModel); // 中位 → default → undefined
if (effortPatch) patches.push(effortPatch);
}
```

`getReasoningEffortOptions(model, binary?, codexHome?)` 从活动目录（catalog 模式）或 bundled（非 catalog）
的 `supported_reasoning_levels` 取选项，**原样透传**（含 `minimal`/自定义档位）；模型未声明
档位或未知时返回空列表（codex fallback 元数据 supported 为空，不虚构档位）。`binary` 参数
用于覆盖自定义 codex 二进制路径，`codexHome` 用于覆盖配置目录。空串档位/空串 default 会被解析器过滤
（codex `ReasoningEffort::from_str("")` 是硬错误）。

## 配置保存与生效

保存配置后（点击 💾 保存所有修改）：

1. 配置写入 `config.yaml` 的 `agents.codex.*` 字段
2. 如果检测到 codex 配置变更（任何 `agents.codex.*` 键），自动清除 runner 缓存：
   ```typescript
   const agentConfigKeys = Object.keys(updates).filter(
     (k) => k.startsWith('agents.codex.') || k === 'agents.codex'
   );
   if (agentConfigKeys.length > 0) {
     this.bridge.clearRunners();
   }
   ```
3. 下次运行命令时，使用新配置创建 CodexRunner

## 添加新 Provider/Model

### 方式 1: 修改 ~/.codex/config.toml

在 codex 的配置文件中添加新的 provider section：

```toml
[model_providers.anthropic]
name = "anthropic"
base_url = "https://api.anthropic.com"
env_key = "ANTHROPIC_API_KEY"
wire_api = "responses"
```

保存后刷新 `/config` 卡片，新 provider 会自动出现在下拉选项中。

### 方式 2: 修改代码 fallback

如果需要修改内置 fallback 列表，编辑 `src/config/codex-config.ts`：

```typescript
const FALLBACK_PROVIDERS = ['openai']; // 与 codex 内置 provider 对齐（无 anthropic/google）
const FALLBACK_MODELS = ['o3', 'o4-mini', 'gpt-4o', 'gpt-4.1', ...];
```

## 常见问题

### Q: 为什么选择后下拉框显示"请选择"？

检查字段 key 是否正确使用了 `agents.codex.xxx` 格式。如果使用旧格式 `codex.xxx`，`getConfigValue` 会找不到值，因为数据实际存储在 `agents.codex` 下。

### Q: 模型下拉是空的吗？

确保 `~/.codex/config.toml` 存在且（catalog 模式）`model_catalog_json` 指向的目录
能被 `codex debug models` 读取。catalog 模式下模型只来自活动目录；命令失败时模型
回退为 config.toml 当前 `model`。如果配置文件不存在，会使用内置的 fallback 列表。

### Q: 修改配置后不生效？

确认配置已保存（点击 💾 按钮）。保存时会自动清除 runner 缓存，确保下次运行使用新配置。如果仍然不生效，检查 `config.yaml` 中的字段名是否正确。

## 相关代码

- `src/config/codex-config.ts` - Codex 配置读取工具（`loadCodexConfig`/`getCodexCatalogModels`/`getReasoningEffortOptions`）
- `src/config/index.ts` - CodexConfigSchema 定义（含 `reasoningEffort`）
- `src/router/index.ts` - config.set 处理逻辑、buildConfigCard
- `src/runner/codex/runner.ts` - CodexExecRunner 实现（`codex exec --json`）
- `src/runner/codex/argv.ts` - argv 构建（含 `model_reasoning_effort` 透传）
