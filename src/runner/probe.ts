/**
 * Agent availability probe — detect whether each CLI binary is installed
 * and functional by running `<binary> --help`.
 *
 * Why `--help` over `command -v`:
 * - Validates not just PATH existence but also executability + dependency integrity
 * - All 5 agent CLIs (claude/codex/opencode/pi/kimi) return immediately on --help
 * - No shell-builtin portability concerns (spawn uses the binary directly)
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
};

const CACHE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 3_000;

interface CacheEntry {
  ts: number;
  ok: boolean;
}

/** Module-level cache, survives across calls within the process. */
const cache = new Map<AgentKind, CacheEntry>();

/**
 * Probe a single agent's availability by spawning `<binary> --help`.
 * Exit code 0 = available; error / non-zero / timeout = unavailable.
 */
async function probeOne(kind: AgentKind): Promise<boolean> {
  const binary = BINARY_MAP[kind];
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const proc = spawn(binary, ['--help'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      // SIGKILL fallback after 500ms if the process ignores SIGTERM.
      // This ensures the child is forcibly cleaned up even if SIGTERM
      // is ignored, preventing zombie processes.
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, 500);
      killTimer.unref();
      done(false);
    }, PROBE_TIMEOUT_MS);
    // Don't prevent the process from exiting naturally
    proc.unref();
    timer.unref();

    proc.on('error', () => done(false));
    proc.on('exit', (code) => done(code === 0));
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
 * Probe all agents concurrently, using cache when fresh.
 * Updates cache for each probed agent.
 */
export async function probeAllAgents(): Promise<Map<AgentKind, boolean>> {
  const kinds = Object.keys(BINARY_MAP) as AgentKind[];
  const results = await Promise.all(
    kinds.map(async (k) => [k, await probeAgentAvailability(k)] as const),
  );
  return new Map(results);
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
