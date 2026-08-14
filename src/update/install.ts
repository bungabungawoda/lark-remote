import { execFile, execFileSync } from 'node:child_process';
import { getLogger } from '../logger/index.js';

/** Supported package managers for global install. */
export type PackageManager = 'npm' | 'bun' | 'pnpm';

/** Result of an install attempt. */
export interface InstallResult {
  success: boolean;
  error?: string;
}

/** Type signature matching execFile's callback style. */
type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;
type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: object,
  callback: ExecFileCallback,
) => void;

/**
 * Detect which package manager to use for global install.
 *
 * Priority:
 * 1. Environment variable override (LARK_REMOTE_MANAGED_BY)
 * 2. `which` availability: npm → bun → pnpm
 */
export function detectPackageManager(): PackageManager | null {
  // 1. Env override (highest priority)
  const env = process.env.LARK_REMOTE_MANAGED_BY;
  if (env === 'npm' || env === 'bun' || env === 'pnpm') return env;

  // 2. which availability detection
  const candidates: PackageManager[] = ['npm', 'bun', 'pnpm'];
  for (const cmd of candidates) {
    try {
      execFileSync('which', [cmd], { stdio: 'pipe', timeout: 3000 });
      return cmd;
    } catch {
      // Not found, try next
    }
  }
  return null;
}

/** Get the install command for a package manager. */
function getInstallCommand(pm: PackageManager): { cmd: string; args: string[] } {
  switch (pm) {
    case 'npm':
      return { cmd: 'npm', args: ['install', '-g', 'lark-remote@latest'] };
    case 'bun':
      return { cmd: 'bun', args: ['install', '-g', 'lark-remote@latest'] };
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-g', 'lark-remote@latest'] };
  }
}

/**
 * Run the global install command to upgrade lark-remote to the latest version.
 *
 * @param opts.packageManager - Override detected package manager
 * @param opts.execFn - Override execFile for testing
 */
export function runInstallLatest(opts?: {
  packageManager?: PackageManager | null;
  execFn?: ExecFileFn;
}): Promise<InstallResult> {
  // If packageManager is explicitly null, skip detection and fail immediately.
  // If undefined (not provided), run detection.
  let pm: PackageManager | null;
  if (opts?.packageManager === null) {
    pm = null;
  } else if (opts?.packageManager) {
    pm = opts.packageManager;
  } else {
    pm = detectPackageManager();
  }
  if (!pm) {
    return Promise.resolve({
      success: false,
      error: '未检测到可用的包管理器（npm/bun/pnpm），请手动执行 npm install -g lark-remote@latest',
    });
  }

  const { cmd, args } = getInstallCommand(pm);
  const execFn = opts?.execFn ?? ((...args) => execFile(...(args as Parameters<typeof execFile>)));
  const logger = getLogger();

  logger.info(`[update] running: ${cmd} ${args.join(' ')}`);

  return new Promise((resolve) => {
    execFn(
      cmd,
      args,
      { timeout: 120_000, encoding: 'utf8' }, // 2 min timeout for npm install
      (err, _stdout, _stderr) => {
        if (err) {
          const msg = err.message || String(_stderr);
          logger.error(`[update] install failed: ${msg}`);
          // Detect common errors and give actionable advice
          if (msg.includes('EACCES') || msg.includes('permission')) {
            resolve({
              success: false,
              error: `权限不足，尝试 sudo ${cmd} ${args.join(' ')}`,
            });
            return;
          }
          resolve({
            success: false,
            error: msg.split('\n')[0], // First line only
          });
          return;
        }
        logger.info(`[update] install succeeded`);
        resolve({ success: true });
      },
    );
  });
}
