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

import { getLogger } from '../../logger/index.js';
import { spawnProcessSync } from '../../platform/spawn.js';
import {
  DSH_COOKIE_LIFETIME_MS,
  mintDshBrowserCookie,
  readDshBrowserSecretSync,
  resolveDshCredentialsFile,
} from './auth.js';

/** Upper bound on the exit-path cancel:退出不能被一个卡住的 host 拖住。 */
export const EXIT_CANCEL_TIMEOUT_MS = 2_000;

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

  const res = spawnProcessSync(
    'curl',
    [
      '-s',
      '-o',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w',
      '%{http_code}',
      '-X',
      'POST',
      `${opts.baseUrl.replace(/\/$/, '')}/api/session/cancel`,
      '-H',
      'content-type: application/json',
      '-H',
      `Cookie: ${cookie}`,
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
}
