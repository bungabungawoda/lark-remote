/**
 * Global DSH Web Host lifecycle.
 *
 * One machine runs one DSH per `DSH_HOME`. lark-remote reuses an existing
 * process, or starts `dsh web` detached when none is running. The child is
 * deliberately independent: lark-remote exiting must not stop the shared DSH.
 *
 * Authentication is separate. DSH's `/api` and `/api/remote.mux` require a
 * signed browser cookie; lark-remote mints a v1 cookie from the durable
 * `client-connection/browser-session` secret in `$DSH_HOME/.credentials.yaml`,
 * so a DSH restart never needs a copied launch token.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_DSH_HOST } from '../../config/index.js';
import { mergeProcessEnv, spawnProcess } from '../../platform/spawn.js';
import { getLogger } from '../../logger/index.js';
import { resolveDshHome } from '../../dsh/home.js';

const DEFAULT_START_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;

/** Configuration providers are read on every resolve so `/config` hot edits land. */
export interface DshDaemonOptions {
  readonly host: () => string | undefined;
  readonly dshHome?: () => string | undefined;
  readonly dshCommand?: () => string | undefined;
  readonly manageProcess?: () => boolean;
  readonly startTimeoutMs?: () => number | undefined;
}

export type DshDaemonErrorCode = 'stopped' | 'start-lock' | 'spawn' | 'start-timeout';

/** User-facing daemon failure; the bridge renders `message` in the chat card. */
export class DshDaemonError extends Error {
  readonly code: DshDaemonErrorCode;

  constructor(code: DshDaemonErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DshDaemonError';
    this.code = code;
  }
}

interface SpawnedDaemon {
  failure(): Error | undefined;
  exited(): boolean;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** True only for the loopback HTTP address this process may start and probe. */
export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return false;
    return (
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1'
    );
  } catch {
    return false;
  }
}

/**
 * Build `dsh web` arguments for one managed base URL.
 *
 * `--host` takes one concrete IP literal, so `localhost` becomes 127.0.0.1.
 * The port is always explicit: a managed DSH must be reachable at the address
 * lark-remote probes, and `--port 0` would make rediscovery impossible.
 */
export function dshDaemonArgs(baseUrl: string): string[] {
  const url = new URL(baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const host = hostname === 'localhost' ? '127.0.0.1' : hostname;
  return ['web', '--host', host, '--port', url.port || '3080', '--no-open'];
}

/**
 * One process-wide DSH resolver shared by the DSH runner and startup warmup.
 * Concurrent callers share one in-flight start.
 */
export class DshDaemon {
  private inFlight: Promise<string> | undefined;

  constructor(private readonly options: DshDaemonOptions) {}

  /** The configured base URL, always without a trailing slash. */
  baseUrl(): string {
    return stripTrailingSlash(this.options.host()?.trim() || DEFAULT_DSH_HOST);
  }

  /** The configured Harness home, used for the start lock and DSH log. */
  home(): string {
    return resolveDshHome(this.options.dshHome?.());
  }

  /** The detached DSH stderr log for start diagnostics. */
  logFile(): string {
    return path.join(this.home(), 'lark-remote', 'dsh-web.log');
  }

  dshCommand(): string {
    return this.options.dshCommand?.()?.trim() || 'dsh';
  }

  /**
   * Return a reachable DSH base URL, starting it when needed.
   *
   * A successful probe always wins. Only a genuinely unreachable loopback
   * address is started, so a DSH already running on the configured port is
   * never duplicated.
   */
  async ensure(): Promise<string> {
    const baseUrl = this.baseUrl();
    if (await this.probe(baseUrl)) return baseUrl;
    if (this.inFlight === undefined) {
      const pending = this.resolve(baseUrl);
      this.inFlight = pending;
      pending
        .finally(() => {
          if (this.inFlight === pending) this.inFlight = undefined;
        })
        .catch(() => {
          // The racing caller observes the same failure.
        });
    }
    return this.inFlight;
  }

  private async resolve(baseUrl: string): Promise<string> {
    if (!isLoopbackHttpUrl(baseUrl) || !this.manageProcess()) {
      throw new DshDaemonError(
        'stopped',
        `DSH 未运行（${baseUrl}），且当前配置不会由 lark-remote 启动它。` +
          `请先启动：\n  ${this.dshCommand()} web --port ${portOf(baseUrl)} --no-open`,
      );
    }
    return this.withStartLock(baseUrl, async () => {
      if (await this.probe(baseUrl)) return baseUrl;
      let spawned: SpawnedDaemon;
      try {
        spawned = this.spawnDaemon(baseUrl);
      } catch (error) {
        throw new DshDaemonError(
          'spawn',
          `DSH 启动失败：${(error as Error).message}\n日志：${this.logFile()}`,
          { cause: error },
        );
      }
      if (await this.waitUntilReady(baseUrl, this.startTimeoutMs(), spawned)) return baseUrl;

      const failure = spawned.failure();
      if (failure !== undefined) {
        throw new DshDaemonError(
          'spawn',
          `DSH 启动失败：${failure.message}\n日志：${this.logFile()}`,
          { cause: failure },
        );
      }
      if (spawned.exited()) {
        throw new DshDaemonError(
          'spawn',
          `DSH 启动进程提前退出（端口可能被其他进程占用），${baseUrl} 未就绪。\n` +
            `日志：${this.logFile()}`,
        );
      }
      throw new DshDaemonError(
        'start-timeout',
        `DSH 启动超时（${String(this.startTimeoutMs())}ms），${baseUrl} 仍不可达。\n` +
          `日志：${this.logFile()}`,
      );
    });
  }

  private async withStartLock(baseUrl: string, run: () => Promise<string>): Promise<string> {
    const lockDir = path.join(this.home(), 'lark-remote', 'start.lock');
    await fsp.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });
    await fsp.chmod(path.dirname(lockDir), 0o700).catch(() => {});
    const deadline = Date.now() + this.startTimeoutMs();
    while (true) {
      if (await this.probe(baseUrl)) return baseUrl;
      try {
        await fsp.mkdir(lockDir, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.lockIsStale(lockDir)) {
          await fsp.rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new DshDaemonError(
            'start-lock',
            `等待其他 lark-remote 启动 DSH 超时。锁文件：${lockDir}`,
          );
        }
        await this.sleep(READY_POLL_MS);
      }
    }
    try {
      return await run();
    } finally {
      await fsp.rm(lockDir, { recursive: true, force: true });
    }
  }

  private async lockIsStale(lockDir: string): Promise<boolean> {
    try {
      const stats = await fsp.stat(lockDir);
      return Date.now() - stats.mtimeMs > this.startTimeoutMs() * 2;
    } catch (err) {
      // ENOENT = 锁目录刚被持有者清掉（正常，等下一轮重查）。
      // 其余（EACCES/EPERM…）= 无法判断是否陈旧：保守判「不陈旧」继续等，
      // 但必须留痕，否则超时文案会误报成「等待其他 lark-remote」。
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLogger().warn(
          `[dsh] cannot stat start lock ${lockDir}: ${(err as Error)?.message ?? String(err)}`,
        );
      }
      return false;
    }
  }

  private async waitUntilReady(
    baseUrl: string,
    timeoutMs: number,
    spawned: SpawnedDaemon,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.probe(baseUrl)) return true;
      if (spawned.failure() !== undefined || spawned.exited()) return false;
      await this.sleep(READY_POLL_MS);
    }
    return this.probe(baseUrl);
  }

  protected startTimeoutMs(): number {
    const configured = this.options.startTimeoutMs?.();
    return configured !== undefined && configured > 0 ? configured : DEFAULT_START_TIMEOUT_MS;
  }

  protected manageProcess(): boolean {
    return this.options.manageProcess?.() ?? true;
  }

  /**
   * Probe the API prefix, not `/`: a listening server whose plugin tree has
   * not mounted yet answers 404 there, while a ready DSH answers 401 before
   * dispatch. Any other status still proves the listener is alive.
   */
  protected async probe(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/api/`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(1_500),
      });
      return response.status !== 404;
    } catch {
      return false;
    }
  }

  /**
   * Start one detached DSH. stdout is discarded because it carries the
   * tokenized startup URL; stderr goes to a 0600 log for failure diagnosis.
   */
  protected spawnDaemon(baseUrl: string): SpawnedDaemon {
    const home = this.home();
    const log = this.logFile();
    fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(path.dirname(log), 0o700);
    } catch {
      // Non-POSIX filesystems keep their native ACLs.
    }
    const fd = fs.openSync(log, 'a', 0o600);
    try {
      fs.chmodSync(log, 0o600);
    } catch {
      // Non-POSIX filesystems keep their native ACLs.
    }
    let failure: Error | undefined;
    let exited = false;
    try {
      const child = spawnProcess(this.dshCommand(), dshDaemonArgs(baseUrl), {
        detached: true,
        stdio: ['ignore', 'ignore', fd],
        cwd: home,
        env: mergeProcessEnv(process.env, { DSH_HOME: home }),
      });
      child.once('error', (error) => {
        failure = error;
      });
      child.once('exit', () => {
        exited = true;
      });
      child.unref();
      return { failure: () => failure, exited: () => exited };
    } finally {
      fs.closeSync(fd);
    }
  }

  protected async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function portOf(baseUrl: string): string {
  return new URL(baseUrl).port || '3080';
}
