[简体中文](../../zh/guides/codex-config.md) | English

# Codex Configuration Card User Guide

This document explains the configuration fields for the Codex Agent on the `/config` card and how they work.

## Overview

Codex Agent configuration is managed through the `/config` card's interactive interface. When `defaultAgent` is set to `codex`, the card displays the following fields:

| Field Key | Display Label | Type | Description |
|-----------|---------------|------|-------------|
| `agents.codex.modelProvider` | Codex Provider | select | Model provider (built-in `openai` + config.toml `[model_providers.*]`, consistent with codex `merge_configured_model_providers`; `anthropic` is not a codex built-in provider and requires explicit configuration) |
| `agents.codex.model` | Model | select | config.toml `model` + active catalog `visibility==='list'` slugs (when `model_catalog_json` is **declared** = `codex debug models` output; otherwise = `--bundled` built-in catalog) |
| `agents.codex.reasoningEffort` | Reasoning Effort | select | Maps to `model_reasoning_effort`; options change dynamically based on the current model's `supported_reasoning_levels` |

> `approval_policy` (`never`) and `sandbox_mode` (`danger-full-access`) are hardcoded in the runner and not exposed on the card (see `src/runner/codex/argv.ts`).

## Field Key Mapping Principles

To ensure consistent key paths for both reading and writing, Codex fields use the `agents.codex.*` prefix:

- **Card field key**: `agents.codex.modelProvider` (used for UI construction and callbacks)
- **pendingConfig storage**: `pendingConfig.agents.codex.modelProvider`
- **getConfigValue read**: `config.agents.codex.modelProvider`

This is consistent with the Pi Agent pattern (`agents.pi.*`), avoiding key mapping asymmetry between read and write paths.

## Dynamic Model List

The Codex model dropdown options are dynamically read from `~/.codex/config.toml`:

```typescript
// src/config/codex-config.ts
import { loadCodexConfig } from '../config/codex-config.js';

const codexCfg = loadCodexConfig({ binary: 'codex' });
const providerNames = codexCfg.providerNames;  // built-in openai + config.toml [model_providers.*]
                                               // (anthropic is not built-in, requires explicit config)
const modelOptions = codexCfg.modelOptions();  // catalog mode: active catalog visibility==='list' slugs
                                               // non-catalog mode: bundled visibility==='list' slugs
```

### Configuration Source Format

`model_catalog_json` (codex 0.14x+) **replaces** the entire model catalog: once configured, the codex runtime
only recognizes models from that JSON file (`codex debug models` output); the built-in `--bundled` catalog no longer participates.
Therefore, in catalog mode, the card:

- Provider dropdown = built-in `openai` + `[model_providers.*]` (aligned with codex
  `merge_configured_model_providers(built_in_model_providers, cfg.model_providers)`,
  `core/src/config/mod.rs:3655`; when `model_provider` is undeclared, defaults to `"openai"`, mod.rs:3659);
  `anthropic`/`amazon-bedrock`/`ollama`/`lmstudio` and other built-in providers are not listed without
  explicit section/credentials configuration (current single-user API-key scenario);
- Model dropdown only lists models in the active catalog;
- Reasoning effort dropdown/default values are taken from the active catalog model's `supported_reasoning_levels` /
  `default_reasoning_level` (e.g., deepseek-v4-flash = `low/high/max`, default `high`);
- When the active catalog command is unavailable, the model list falls back to the current `model` in config.toml
  (does not leak built-in/FALLBACK models).

`~/.codex/config.toml` example:

```toml
model = "glm-5.2"
model_provider = "volcengine-coding-plan"

[model_providers.volcengine-coding-plan]
name = "volcengine-coding-plan"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = "ARK_API_KEY"
wire_api = "responses"
```

`loadCodexConfig()` parses:
- `model` → currently selected model
- `model_provider` → currently selected provider
- `[model_providers.*]` → provider list (extracted from section names)

### Fallback Behavior

When `model_catalog_json` is not **declared**, the card uses non-catalog mode: provider includes built-in
`openai` (anthropic is not a codex built-in provider, must be explicitly configured in `[model_providers.anthropic]`),
and the model list comes from `codex debug models --bundled`.

- **Declared but invalid** (`model_catalog_json = ""` or non-string): still treated as catalog declaration
  (consistent with codex runtime: catalog load failure is a hard error, no fallback to built-in catalog) —
  the card only shows the current `model` from config.toml, without leaking built-in models.
- **config.toml parse failure** (syntax error, cannot determine declaration status): treated as
  **non-catalog** mode, using bundled + built-in defaults as fallback.
- **config.toml missing or parse failure, and bundled command also fails**: uses built-in defaults:

- **Provider**: `['openai']`
- **Model**: first available model from catalog (falls back to `['o3', 'o4-mini', 'gpt-4o', ...]` when catalog is unavailable)

> **API-key mode assumption**: This project runs codex in API-key mode
> (`forced_login_method = "api"`), therefore the card:
> - Filters models by `supported_in_api === true` — equivalent to codex's
>   `chatgpt_mode || supported_in_api` (`openai_models.rs` `filter_by_auth`),
>   where codex under ChatGPT login shows all models; this project does not support that mode;
> - Uses `--bundled` instead of no-argument `debug models` in non-catalog mode — the no-argument version
>   under `uses_codex_backend()/has_command_auth()` requests the remote `/models` endpoint, which in API-key
>   mode yields the same results as bundled; under ChatGPT/command auth configurations the card may not
>   reflect the remote catalog.

### Known Limitations

`model_catalog_json` is only read from `~/.codex/config.toml` at the top level. Codex itself supports layered
configuration (project `.codex/`, profile, and enterprise layers may each declare this field); if the catalog
declaration comes from a non-user layer, the card will incorrectly determine non-catalog mode and display the
bundled list. Actual runs still use the catalog per codex's layered semantics. This project targets a
single-user local usage scenario and does not mirror layered loading for now; users with such configurations
should explicitly declare them in `~/.codex/config.toml`.

## Provider Switching Logic

When the user switches the `Codex Provider` dropdown, the system automatically:

1. Updates the value of `agents.codex.modelProvider`
2. Recomputes the valid model list for that provider
3. If the currently selected model is not in the new provider's list, automatically resets to the first model for that provider
4. **Simultaneously validates reasoning effort for the new model**: if the current level is not supported by
   the new model, it resets/clears per `with_model` semantics — otherwise the old model's level would leak
   through to a model that doesn't support it (codex only clamps on `with_model` within a session, not on session creation path)

```typescript
// router/index.ts - config.set handling
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

## Model Switching Linked to Reasoning Effort

When the user switches the `Model` dropdown, the system automatically validates whether the current `reasoningEffort` is still supported by the new model. If not, it resets per codex `with_model` semantics (`src/router/config/codex.ts` `CodexConfigBuilder.handleFieldChange`):
takes the **median level** `(len-1)/2` of the new model's `supported_reasoning_levels`; only uses
`default_reasoning_level` when the declared list is empty; if both are absent, **clears the level** (codex semantics: no effort passed). When cleared, `handleFieldChange` produces a patch with `value=undefined`, and the router's `setNestedValue` treats it as a **key deletion**, removing `reasoningEffort` from `config.yaml` rather than writing the literal string `"undefined"`:

```typescript
// src/router/config/codex.ts - handleFieldChange
const effortPatch = this.effortPatchForModel(config, newModel); // median → default → undefined
if (effortPatch) patches.push(effortPatch);
}
```

`getReasoningEffortOptions(model, binary?, codexHome?)` retrieves options from the active catalog (catalog mode) or bundled (non-catalog) `supported_reasoning_levels`, **passing them through as-is** (including `minimal`/custom levels); returns an empty list when the model declares no levels or is unknown (codex fallback metadata has empty `supported`, no fabricated levels). The `binary` parameter overrides the custom codex binary path, and `codexHome` overrides the config directory. Empty-string levels/empty-string defaults are filtered by the parser (codex `ReasoningEffort::from_str("")` is a hard error).

## Configuration Save and Effect

After saving configuration (clicking 💾 Save All Changes):

1. Configuration is written to `config.yaml` under `agents.codex.*` fields
2. If codex configuration changes are detected (any `agents.codex.*` key), the runner cache is automatically cleared:
   ```typescript
   const agentConfigKeys = Object.keys(updates).filter(
     (k) => k.startsWith('agents.codex.') || k === 'agents.codex'
   );
   if (agentConfigKeys.length > 0) {
     this.bridge.clearRunners();
   }
   ```
3. The next command run creates a new CodexRunner with the updated configuration

## Adding a New Provider/Model

### Method 1: Modify ~/.codex/config.toml

Add a new provider section in codex's configuration file:

```toml
[model_providers.anthropic]
name = "anthropic"
base_url = "https://api.anthropic.com"
env_key = "ANTHROPIC_API_KEY"
wire_api = "responses"
```

After saving, refresh the `/config` card — the new provider will automatically appear in the dropdown options.

### Method 2: Modify Code Fallback

If you need to modify the built-in fallback list, edit `src/config/codex-config.ts`:

```typescript
const FALLBACK_PROVIDERS = ['openai']; // Aligned with codex built-in providers (no anthropic/google)
const FALLBACK_MODELS = ['o3', 'o4-mini', 'gpt-4o', 'gpt-4.1', ...];
```

## FAQ

### Q: Why does the dropdown show "Please select" after selection?

Check whether the field key uses the correct `agents.codex.xxx` format. If using the old format `codex.xxx`, `getConfigValue` will not find the value because data is actually stored under `agents.codex`.

### Q: Is the model dropdown empty?

Ensure `~/.codex/config.toml` exists and (in catalog mode) the catalog pointed to by `model_catalog_json` can be read by `codex debug models`. In catalog mode, models only come from the active catalog; if the command fails, the model falls back to the current `model` in config.toml. If the configuration file does not exist, the built-in fallback list is used.

### Q: Configuration changes not taking effect?

Confirm the configuration has been saved (click the 💾 button). Saving automatically clears the runner cache, ensuring the next run uses the new configuration. If it still doesn't take effect, check that the field names in `config.yaml` are correct.

## Related Code

- `src/config/codex-config.ts` - Codex configuration reading utilities (`loadCodexConfig`/`getCodexCatalogModels`/`getReasoningEffortOptions`)
- `src/config/index.ts` - CodexConfigSchema definition (including `reasoningEffort`)
- `src/router/index.ts` - config.set handling logic, buildConfigCard
- `src/runner/codex/runner.ts` - CodexExecRunner implementation (`codex exec --json`)
- `src/runner/codex/argv.ts` - argv construction (including `model_reasoning_effort` passthrough)
