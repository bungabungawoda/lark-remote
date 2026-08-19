/**
 * Agent availability probe — detect whether each CLI binary is installed
 * by checking whether it resolves on PATH via `which`.
 *
 * Why `which` over `<binary> --help`:
 * - `--help` starts a full Node.js process per agent (2–8 s on
 *   resource-constrained devices like Raspberry Pi). Under startup load
 *   (auto-resume spawns, CPU contention) probes time out and installed
 *   agents are falsely reported as unavailable.
 * - `which` is a lightweight PATH lookup (<10 ms), immune to CPU contention.
 * - "Installed but broken" cases surface at run time via SpawningRunner's
 *   ENOENT/error handling (src/runner/common/spawning-runner.ts), which
 *   shows a friendly error card instead of a startup-time mislabel.
 *
 * Why `which` over `command -v`:
 * - `which` is a standalone executable (e.g. /usr/bin/which on macOS and
 *   Debian-based Linux), so no `shell: true` and no Node DEP0190 warning.
 * - Caveat: `which` is not POSIX-guaranteed. macOS, Raspberry Pi OS and
 *   other Debian-based distributions ship it by default; if Windows or
 *   minimal Alpine containers become supported, prefer a pure-Node
 *   PATH + X_OK lookup instead.
 */

import { spawn } from 'child_process';
import type { AgentKind } from './types.js';

/** Map from AgentKind to its CLI binary name. */
const BINARY_MAP: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  kimi: 'kimi',
  // DSH is an HTTP-only agent (no CLI). `which ''` fails → reported unavailable,
  // which is semantically correct for the /config availability display.
  dsh: '',
};

const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  ts: number;
  ok: boolean;
}

/** Module-level cache, survives across calls within the process. */
const cache = new Map<AgentKind, CacheEntry>();

/**
 * Probe a single agent's availability by spawning `which <binary>`.
 * Exit code 0 = binary on PATH; error / non-zero = unavailable.
 */
async function probeOne(kind: AgentKind): Promise<boolean> {
  const binary = BINARY_MAP[kind];
  return new Promise((resolve) => {
    const proc = spawn('which', [binary], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * Probe a single agent, using cache when fresh.
 * Updates cache on completion.
 */
export async function probeAgentAvailability(kind: AgentKind): Promise<boolean> {
  const cached = cache.get(kind);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ok;

  const ok = await probeOne(kind);
  cache.set(kind, { ts: Date.now(), ok });
  return ok;
}

/**
 * Probe all agents concurrently.
 *
 * Concurrent (not sequential) because `which` is a lightweight PATH lookup
 * (<10 ms) with no CPU contention risk — unlike the previous `--help`
 * probes, which needed to run one-at-a-time to avoid starving each other
 * on resource-constrained devices.
 */
export async function probeAllAgents(): Promise<Map<AgentKind, boolean>> {
  // Skip agents with no CLI binary (DSH is HTTP-only, binary === ''): the
  // probe / availability display only covers spawn-able agents.
  const kinds = Object.keys(BINARY_MAP).filter(
    (k) => BINARY_MAP[k as AgentKind] !== '',
  ) as AgentKind[];
  const entries = await Promise.all(
    kinds.map(async (k) => [k, await probeAgentAvailability(k)] as const),
  );
  return new Map(entries);
}

/**
 * Synchronous cache read — returns cached availability if fresh,
 * or `undefined` if no fresh cache entry exists.
 * Used by synchronous code paths (e.g. buildConfigCard) that cannot await.
 */
export function getCachedAvailability(kind: AgentKind): boolean | undefined {
  const cached = cache.get(kind);
  if (!cached || Date.now() - cached.ts >= CACHE_TTL_MS) return undefined;
  return cached.ok;
}

/** Clear all cache entries. Exported for test use only (cache auto-expires via TTL). */
export function _clearCacheForTest(): void {
  cache.clear();
}
