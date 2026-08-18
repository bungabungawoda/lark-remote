/**
 * Shared helper functions for the ACP protocol layer.
 *
 * Extracted from runner.ts and translator.ts to avoid duplication (G5).
 * Shape source: approval.ts:28-29 — optionId is opaque, echo back as-is.
 */

import type { PermissionOption } from './protocol-types.js';

/**
 * Find an option by matching its `kind` against a list of candidate values,
 * and return the `optionId` to echo back in the approval response.
 * ACP option kind values vary between kimi versions; this handles both
 * the documented names and the observed real names (§2.3).
 */
export function findOptionIdByKind(
  options: PermissionOption[],
  candidateKinds: string[],
): string | undefined {
  for (const kind of candidateKinds) {
    const found = options.find((opt) => opt.kind === kind);
    if (found) return found.optionId;
  }
  return undefined;
}
