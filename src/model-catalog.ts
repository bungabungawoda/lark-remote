/**
 * Claude 模型 ID ↔ CLI alias 的双向表。
 *
 * 中立层（谁都不许反向依赖它）：config 要写默认值、runner/claude 要把 alias 传给
 * CLI、router/config 要把 alias 显示给用户。此前这张表住在 config/，于是
 * 「地基层被 runner 反向 import」；挪到这里后三方共同引用同一份。
 *
 * 表内容来自 Claude CLI 的模型别名（alias 是 CLI 侧的稳定名字，model ID 会随
 * 版本变），新增一行只改这里。
 */

/** 模型 ID → alias 映射。 */
export const MODEL_ID_TO_ALIAS: Record<string, string> = {
  'claude-opus-4-8': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-5-20250501': 'haiku',
  'claude-fable-5': 'fable',
};

/** alias → model ID 反向映射。 */
export const MODEL_ALIAS_TO_ID: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20250501',
  fable: 'claude-fable-5',
};
