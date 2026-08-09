/**
 * Codex bundled-models test helpers (review 死代码#7).
 *
 * `getCodexBundledModels` / `getCodexBundledModelSlugs` have no production
 * caller — production uses `getCodexCatalogModels` (which runs `--bundled` in
 * non-catalog mode but caches under `catalogCache`). These wrappers exist only
 * so tests can exercise the `codex debug models --bundled` command path +
 * shared parser in isolation, with their own cache. Extracted out of
 * `codex-config.ts` so the production module no longer ships test-only entry
 * points (mirrors the dormant-API treatment of `isSessionActive`).
 *
 * The parser itself (`parseCodexModelsOutput`) and the `BundledModelInfo` type
 * are imported from the production module so there is a single source of
 * truth for the parsing contract.
 */

import { execFileSync } from 'node:child_process';
import { getLogger } from '../logger/index.js';
import { parseCodexModelsOutput, type BundledModelInfo } from './codex-config.js';

interface BundledCacheEntry {
  binary: string;
  models: BundledModelInfo[];
  ts: number;
}

/** Bundled models from codex binary, 1h TTL (only change on binary upgrade). */
const BUNDLED_CACHE_TTL_MS = 60 * 60 * 1000;
let bundledCache: BundledCacheEntry | null = null;

/**
 * Bundled model list via `codex debug models --bundled` (test-only entry).
 * Production should use `getCodexCatalogModels` from `codex-config.ts`.
 */
export function getCodexBundledModels(binary: string): BundledModelInfo[] {
  const now = Date.now();
  if (
    bundledCache &&
    bundledCache.binary === binary &&
    now - bundledCache.ts < BUNDLED_CACHE_TTL_MS
  ) {
    return bundledCache.models;
  }

  try {
    const stdout = execFileSync(binary, ['debug', 'models', '--bundled'], {
      encoding: 'utf-8',
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const models = parseCodexModelsOutput(stdout);
    if (models.length > 0) {
      bundledCache = { binary, models, ts: now };
    }
    return models;
  } catch (err) {
    getLogger().warn(
      `[codex-config] bundled models unavailable for binary "${binary}": ${(err as Error).message}`,
    );
    return [];
  }
}

/** Returns slug list sorted by priority ascending (test-only). */
export function getCodexBundledModelSlugs(binary: string): string[] {
  return getCodexBundledModels(binary).map((m) => m.slug);
}

/** Test utility: clear the bundled-models cache. */
export function invalidateCodexBundledTestCache(): void {
  bundledCache = null;
}
