import fs from 'node:fs';
import { getLogger } from '../logger/index.js';
import { resolveExecutable } from '../platform/command.js';
import { currentPlatform, isWin32 } from '../platform/select.js';
import { spawnProcess, spawnProcessSync } from '../platform/spawn.js';

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
 * execFile 回调风格适配 cross-spawn（platform/spawn.ts）。
 *
 * npm/pnpm 在 Windows 是 .cmd 垫片，execFile 不经 shell 无法执行——Node 自
 * CVE-2024-27980 收紧后对无 shell 启动 .cmd 直接抛错，win32 上 /update 会
 * 永远失败。执行统一走 spawnProcess（cross-spawn 处理 PATHEXT + .cmd 经
 * cmd.exe 受控执行），错误/退出码语义对齐 execFile：
 * - 非 0 退出 → err.message 为 execFile 同款 "Command failed: ..." 形态
 *   （含 stderr 首段，EACCES 提示逻辑依赖它）；
 * - 'error' 事件（ENOENT 等）→ 原样回调。
 */
function execViaSpawnProcess(
  file: string,
  args: readonly string[],
  options: { timeout?: number; encoding?: string },
  callback: ExecFileCallback,
): void {
  const proc = spawnProcess(file, args, {
    timeout: options.timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (error: Error | null): void => {
    if (settled) return;
    settled = true;
    callback(error, stdout, stderr);
  };
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  proc.on('error', (err) => finish(err));
  proc.on('close', (code, signal) => {
    if (code === 0) {
      finish(null);
      return;
    }
    const detail = stderr.trim() || stdout.trim();
    const how = signal ? ` terminated with ${signal}` : ` with exit code ${code ?? 'unknown'}`;
    finish(
      new Error(`Command failed: ${file} ${args.join(' ')}${how}${detail ? `\n${detail}` : ''}`),
    );
  });
}

/**
 * Infer the installing package manager from the real path of the running
 * script (e.g. `.../node_modules/lark-remote/dist/index.js`).
 *
 * Layout markers (check order matters — bun/pnpm paths also contain
 * `/node_modules/lark-remote/`):
 * - bun:  `~/.bun/install/global/node_modules/lark-remote/...`
 * - pnpm: `<global>/node_modules/.pnpm/lark-remote@<ver>/node_modules/lark-remote/...`
 * - npm:  `<prefix>/lib/node_modules/lark-remote/...` (POSIX) or
 *         `<prefix>/node_modules/lark-remote/...` (Windows)
 *
 * Returns null when the path has no marker (e.g. running from a source
 * checkout in dev mode).
 */
export function inferPackageManagerFromPath(scriptPath: string): PackageManager | null {
  const p = scriptPath.replace(/\\/g, '/');
  if (p.includes('/.bun/install/global/')) return 'bun';
  if (p.includes('/.pnpm/lark-remote@')) return 'pnpm';
  if (p.includes('/node_modules/lark-remote/')) return 'npm';
  return null;
}

/**
 * Detect which package manager to use for global install.
 *
 * Priority:
 * 1. Environment variable override (LARK_REMOTE_MANAGED_BY)
 * 2. Install location of the running script (upgrades must target the same
 *    copy that is actually running — a different PM would install a second
 *    copy and leave the running one stale)
 * 3. `which` availability: npm → bun → pnpm
 */
export function detectPackageManager(scriptPath?: string): PackageManager | null {
  // 1. Env override (highest priority)
  const env = process.env.LARK_REMOTE_MANAGED_BY;
  if (env === 'npm' || env === 'bun' || env === 'pnpm') return env;

  // 2. Infer from where this process was loaded from
  const raw = scriptPath ?? process.argv[1];
  if (raw) {
    let resolved = raw;
    try {
      resolved = fs.realpathSync(raw);
    } catch {
      // Keep raw path (e.g. synthetic path in tests)
    }
    const inferred = inferPackageManagerFromPath(resolved);
    if (inferred) return inferred;
  }

  // 3. availability fallback: 纯 Node PATH 解析（win32 PATHEXT），不再依赖外部 which
  //    （Windows 无 which）；win32 再用 where.exe 兜底罕见的解析失败场景（v2 §4.3）
  const candidates: PackageManager[] = ['npm', 'bun', 'pnpm'];
  for (const cmd of candidates) {
    if (resolveExecutable(cmd)) return cmd;
    if (isWin32(currentPlatform)) {
      const res = spawnProcessSync('where.exe', [cmd], { stdio: 'pipe', timeout: 3000 });
      if (!res.error && res.status === 0) return cmd;
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
 * @param opts.execFn - Override exec for testing; default routes through
 *   platform/spawn.ts (cross-spawn, win32 .cmd shim safe)
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
  const execFn = opts?.execFn ?? execViaSpawnProcess;
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
            // bun/pnpm install into the user dir — sudo is wrong advice there
            // (it would install into root's global dir instead).
            const hint =
              pm === 'npm'
                ? `权限不足，尝试 sudo ${cmd} ${args.join(' ')}`
                : `权限不足，请检查 ${cmd} 全局安装目录的写权限`;
            resolve({ success: false, error: hint });
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
