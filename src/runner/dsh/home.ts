import os from 'node:os';
import path from 'node:path';

/** Resolve the same DSH home DSH itself uses: configured, env, then ~/.dsh. */
export function resolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = configured?.trim() || env.DSH_HOME?.trim();
  return path.resolve(value && value.length > 0 ? value : path.join(os.homedir(), '.dsh'));
}
