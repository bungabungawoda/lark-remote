/**
 * Synchronous `session/cancel` for the process-exit path.
 *
 * A DSH turn does not live in a local child process: it runs inside the shared
 * `dsh web` host (`DshDaemon`). So the usual "kill my spawned child" exit
 * cleanup does nothing for it, and a bridge that exits mid-turn leaves the
 * turn running with no subscriber — an orphan turn that keeps consuming tokens
 * and mutating the workspace invisibly (2026-10-19: one ran 2h21m / 345 steps
 * after its bridge died).
 *
 * `process.on('exit')` cannot await, so this path uses the same synchronous
 * curl transport the session reader already uses: bounded by `timeoutMs` and
 * never throws.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogger } from '../../logger/index.js';
import { isWin32 } from '../../platform/select.js';
import { spawnProcessSync } from '../../platform/spawn.js';
import {
  DSH_COOKIE_LIFETIME_MS,
  mintDshBrowserCookie,
  readDshBrowserSecretSync,
  resolveDshCredentialsFile,
} from './auth.js';

/** Upper bound on the exit-path cancel:退出不能被一个卡住的 host 拖住。 */
const EXIT_CANCEL_TIMEOUT_MS = 2_000;

export interface SyncCancelOptions {
  baseUrl: string;
  sessionId: string;
  /** Configured `agents.dsh.dshHome` (selects `.credentials.yaml`). */
  dshHome?: string;
  /** Explicit credentials file; wins over `dshHome`/`$DSH_HOME`. */
  credentialsFile?: string;
  timeoutMs?: number;
}

/**
 * Fire one `session/cancel` synchronously. Never throws: a failed cancel must
 * not block the exit path or mask the real exit reason.
 *
 * @returns true when the host accepted the request.
 */
export function cancelSessionSync(opts: SyncCancelOptions): boolean {
  const logger = getLogger();
  const timeoutMs = opts.timeoutMs ?? EXIT_CANCEL_TIMEOUT_MS;
  let cookie: string;
  try {
    const file =
      opts.credentialsFile?.trim() || resolveDshCredentialsFile(process.env, opts.dshHome);
    cookie = mintDshBrowserCookie(
      opts.baseUrl,
      readDshBrowserSecretSync(file),
      Date.now(),
      DSH_COOKIE_LIFETIME_MS,
    );
  } catch (err) {
    // 没有持久密钥就签不出 cookie；此时只能记一笔，放弃取消（启动 token 的
    // /connect 换 cookie 是异步的，退出路径上等不起）。
    logger.warn(`[dsh] exit-cancel skipped: cannot mint cookie (${(err as Error).message})`);
    return false;
  }

  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `rpc-exit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    method: 'session/cancel',
    payload: { args: { request: { sessionId: opts.sessionId } } },
  });

  // Cookie 不走 argv（`-H "Cookie: …"` 会在 curl 运行期间对本机任何进程的
  // ps 可见——1 小时有效的 v1 凭据泄露面）：写 0600 临时文件用 `-H @file`
  // 传入，用完即删。临时目录必须用 mkdtemp（0700、随机名）：Linux 的 /tmp
  // 所有用户可写，固定名（如 `<pid>.hdr`）可被本地用户预建软链，而
  // writeFileSync 会跟随软链把 cookie 写进攻击者可读的文件；后续 chmod
  // 也救不回已被打开的 fd。文件写失败时回退 argv——退出路径的 cancel
  // 不能因此放弃。
  let headerDir: string | undefined;
  let cookieHeaderArgs: string[];
  try {
    headerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-exit-cancel-'));
    const headerFile = path.join(headerDir, 'cookie.hdr');
    fs.writeFileSync(headerFile, `Cookie: ${cookie}\n`, { mode: 0o600, flag: 'wx' });
    cookieHeaderArgs = ['-H', `@${headerFile}`];
  } catch (err) {
    logger.warn(`[dsh] exit-cancel header file unavailable: ${(err as Error).message}`);
    removeDir(headerDir);
    headerDir = undefined;
    cookieHeaderArgs = ['-H', `Cookie: ${cookie}`];
  }

  try {
    const res = spawnProcessSync(
      'curl',
      [
        '-s',
        '-o',
        isWin32() ? 'NUL' : '/dev/null',
        '-w',
        '%{http_code}',
        '-X',
        'POST',
        `${opts.baseUrl.replace(/\/$/, '')}/api/session/cancel`,
        '-H',
        'content-type: application/json',
        ...cookieHeaderArgs,
        '--max-time',
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        '--data',
        body,
      ],
      { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );

    const status = String(res.stdout ?? '').trim();
    const ok = status === '200';
    if (!ok) {
      logger.warn(
        `[dsh] exit-cancel failed for ${opts.sessionId}: ${res.error?.message ?? `http ${status || 'n/a'}`}`,
      );
    }
    return ok;
  } finally {
    removeDir(headerDir);
  }
}

/** 删除 cookie 临时目录（best-effort）；目录未创建时是空操作。 */
function removeDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}
