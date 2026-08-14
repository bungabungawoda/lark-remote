import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { getVersion } from '../config/dir.js';
import { getLogger } from '../logger/index.js';
import { atomicWrite } from '../persistence/atomic-write.js';

/** Cache TTL for version check results (1 hour). */
export const CACHE_TTL_MS = 60 * 60 * 1000;

/** Default npm registry endpoint for latest version query. */
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/lark-remote/latest';

/** Cache file schema. */
export interface UpdateCache {
  latestVersion: string;
  checkedAt: string; // ISO timestamp
}

/** Result of a version check. */
export interface VersionCheckResult {
  current: string;
  latest: string;
}

/**
 * Compare two semver strings (major.minor.patch).
 * Returns true if latest > current, false if latest <= current,
 * null if either version is not a valid semver string.
 */
export function isNewer(current: string, latest: string): boolean | null {
  const parse = (v: string): { nums: [number, number, number]; pre: string } | null => {
    // Split core and pre-release suffix; compare the core numerically and treat
    // a release as newer than any pre-release of the same core version.
    const [core, pre = ''] = v.trim().split('-', 2);
    const parts = core.split('.');
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
    return { nums: nums as [number, number, number], pre };
  };

  const c = parse(current);
  const l = parse(latest);
  if (!c || !l) return null;

  for (let i = 0; i < 3; i++) {
    if (l.nums[i] > c.nums[i]) return true;
    if (l.nums[i] < c.nums[i]) return false;
  }
  // Equal core version: a release beats a pre-release of the same version.
  if (c.pre !== l.pre) return l.pre === '';
  return false;
}

/**
 * Fetch the latest version from npm registry.
 * Returns the version string.
 */
function fetchLatestVersion(registryUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = registryUrl.startsWith('https') ? https : http;
    const req = mod.get(registryUrl, { timeout: 10_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow one redirect
        fetchLatestVersion(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`npm registry returned status ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { version?: string };
          if (!parsed.version) {
            reject(new Error('npm registry response missing version field'));
            return;
          }
          resolve(parsed.version);
        } catch (err) {
          reject(new Error(`npm registry response parse error: ${(err as Error).message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('npm registry request timed out'));
    });
  });
}

/**
 * Read cached version check result. Returns null if cache is missing,
 * expired, or corrupt.
 */
function readCache(cachePath: string): UpdateCache | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    const cached = JSON.parse(raw) as UpdateCache;
    if (!cached.latestVersion || !cached.checkedAt) return null;
    return cached;
  } catch {
    return null;
  }
}

/** Write version check result to cache file. */
function writeCache(cachePath: string, latestVersion: string): void {
  try {
    const cache: UpdateCache = {
      latestVersion,
      checkedAt: new Date().toISOString(),
    };
    atomicWrite(cachePath, JSON.stringify(cache), 'utf8');
  } catch (err) {
    getLogger().warn(`[update] failed to write cache: ${(err as Error).message}`);
  }
}

/**
 * Check the latest available version of lark-remote.
 * Uses a local cache file with 1-hour TTL to avoid frequent network requests.
 *
 * @param opts.cachePath - Path to cache file (default: <configDir>/update-cache.json)
 * @param opts.bypassCache - If true, always fetch from registry
 * @param opts.registryUrl - Override registry URL (for testing)
 */
export async function checkLatestVersion(opts?: {
  cachePath?: string;
  bypassCache?: boolean;
  registryUrl?: string;
}): Promise<VersionCheckResult> {
  const current = getVersion();
  const registryUrl = opts?.registryUrl ?? DEFAULT_REGISTRY_URL;
  const cachePath = opts?.cachePath;

  // Try cache first (unless bypassed)
  if (cachePath && !opts?.bypassCache) {
    const cached = readCache(cachePath);
    if (cached) {
      const age = Date.now() - new Date(cached.checkedAt).getTime();
      if (age < CACHE_TTL_MS) {
        getLogger().info(`[update] using cached latest version: ${cached.latestVersion}`);
        return { current, latest: cached.latestVersion };
      }
    }
  }

  // Fetch from registry
  getLogger().info(`[update] checking latest version from ${registryUrl}`);
  const latest = await fetchLatestVersion(registryUrl);

  // Update cache
  if (cachePath) {
    writeCache(cachePath, latest);
  }

  return { current, latest };
}
