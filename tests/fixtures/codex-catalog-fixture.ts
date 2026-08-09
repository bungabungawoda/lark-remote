/**
 * codex 模型目录 fixture 助手（P2-7）。
 *
 * 生成的模型条目满足 codex `ModelsResponse` 严格反序列化要求
 * （protocol/src/openai_models.rs ModelInfo 必填字段：slug/display_name/
 * supported_reasoning_levels/shell_type/visibility/supported_in_api/priority/
 * base_instructions/support_verbosity/truncation_policy/
 * supports_parallel_tool_calls/experimental_supported_tools；
 * ReasoningEffortPreset.description 为必填 String）。
 * 这样 anchor 断言的前提"真实 codex debug models 输出可被解析"本身成立。
 */

interface PresetInput {
  effort: string;
  description?: string;
}

interface ModelOverrides {
  description?: string;
  default_reasoning_level?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
}

export function makeModel(
  slug: string,
  presets: PresetInput[],
  overrides: ModelOverrides = {},
): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: overrides.description ?? `${slug} description`,
    default_reasoning_level: overrides.default_reasoning_level,
    supported_reasoning_levels: presets.map((p) => ({
      effort: p.effort,
      description: p.description ?? `desc-${p.effort}`,
    })),
    shell_type: 'shell_command',
    visibility: overrides.visibility ?? 'list',
    supported_in_api: overrides.supported_in_api ?? true,
    priority: overrides.priority ?? 1,
    base_instructions: 'You are Codex, a coding agent. You collaborate with the user.',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    input_modalities: ['text'],
  };
}

/** 生成 ModelsResponse 字符串（codex debug models 输出形状） */
export function makeCatalog(models: Array<Record<string, unknown>>): string {
  return JSON.stringify({ models });
}
