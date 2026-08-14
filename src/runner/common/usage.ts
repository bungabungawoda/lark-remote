/**
 * Normalized usage extracted from a result event.
 *
 * @module runner/common/usage
 */

import type { TokenUsage } from '../types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Normalized, camelCase view of a `TokenUsage` payload.
 *
 *  **Naming rule** — canonical field names (`cache_read_tokens`,
 *  `cache_creation_tokens`) take priority over Anthropic native naming
 *  (`cache_read_input_tokens`, `cache_creation_input_tokens`). When both are
 *  present the canonical value wins; when only the native name exists it is
 *  used as a fallback.
 *
 *  **contextLength rule** — `total_tokens` (the agent-declared total) takes
 *  priority. When absent, contextLength is reconstructed as
 *  `input + cacheRead + cacheCreation + output` (missing cache components
 *  default to 0).
 */
interface NormalizedResultUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  /** Model context window limit (codex app-server `modelContextWindow` passthrough). */
  contextLimit?: number;
  /** Reconstructed or agent-declared context length (see JSDoc above). */
  contextLength: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Extract and normalize usage fields from a result event payload. */
export function normalizeResultUsage(usage: TokenUsage): NormalizedResultUsage {
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  // Canonical name takes priority over Anthropic native naming
  const cacheRead = usage.cache_read_tokens ?? usage.cache_read_input_tokens;
  const cacheCreation = usage.cache_creation_tokens ?? usage.cache_creation_input_tokens;
  const totalTokens = usage.total_tokens;
  const contextLimit = usage.context_limit;
  // total_tokens (agent-declared total) takes priority; otherwise reconstruct
  // from the parts: input + cacheRead + cacheCreation + output.
  const contextLength =
    totalTokens ?? inputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0) + outputTokens;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    totalTokens,
    contextLimit,
    contextLength,
  };
}
