/**
 * JSONL-RPC transport shared by JSON-line-RPC agent servers
 * (codex app-server, kimi acp, and future ACP-style integrations).
 *
 * Wraps a child process with JSON-line-based bidirectional communication:
 * each line on stdout is a JSON message from the server; each `write()`
 * sends a JSON line to stdin.
 */

import type { ChildProcess } from 'node:child_process';
import {
  spawnProcess,
  mergeProcessEnv,
  isWindowsCommandNotFoundLine,
  useDetachedProcessGroup,
} from '../../../platform/spawn.js';
import { ProcessStopper } from '../process-stopper.js';
import { getLogger } from '../../../logger/index.js';

// Max bytes for a single line before we drop the line and resync at the next
// newline. Bumped 10MB -> 64MB
// (2026-09-27): real codex app-server sessions doing large file reads /
// long tool outputs were tripping the old 10MB cap and getting
// hard-disconnected with no viable retry (the retried request emits the
// same oversized line again, so the respawn-and-retry-once logic in the
// callers can never succeed). 64MB keeps the same unbounded-memory-growth
// protection while giving normal large-output turns room to finish. If
// this still trips in practice, the real fix is likely to have the
// upstream agent stream/truncate large tool results rather than raising
// this further.
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** Max bytes retained from stderr for diagnostics (64KB). */
const MAX_STDERR_BYTES = 64 * 1024;

export interface TransportEvents {
  onMessage(msg: unknown): void;
  onClose(reason: string): void;
}

export class JsonlRpcTransport {
  private proc: ChildProcess | null = null;
  private _closed = false;
  private events: TransportEvents | null = null;
  private stopper: ProcessStopper;
  private readonly binary: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  /** JSON lines buffered while stdin is under backpressure (bounded by callers). */
  private writeQueue: Buffer[] = [];
  private flushing = false;
  /** §4.4 win32 嗅探嫌疑标记（双条件定性见下方 onExit）。 */
  private commandNotFoundSeen = false;
  private clearReadBuffer: (() => void) | undefined;
  private closeNotified = false;

  constructor(opts: {
    binary: string;
    args: string[];
    cwd: string;
    env?: Record<string, string | undefined>;
  }) {
    this.binary = opts.binary;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.env = opts.env ?? {};
    this.stopper = new ProcessStopper({ graceMs: 5000 });
  }

  get closed(): boolean {
    return this._closed;
  }

  /**
   * Spawn the child process and start reading its stdout.
   * Returns when the process closes (or immediately if spawn fails).
   */
  async start(events: TransportEvents): Promise<void> {
    this.events = events;
    this.commandNotFoundSeen = false;
    // agent 是用户自己的可信二进制，provider 认证依赖 API key /
    // 自定义 provider 的 env_key，代理环境依赖 HTTP(S)_PROXY、TMPDIR 等；
    // 任何白名单收窄都会打断认证或网络。调用方 this.env 覆盖 process.env 同名键。
    // env 覆盖必须大小写不敏感合并（win32 PATH/Path 双键防护，v2 §8.3）
    const childEnv: NodeJS.ProcessEnv = mergeProcessEnv(process.env, this.env);

    const proc = spawnProcess(this.binary, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // posix 建新进程组（负 PID 组杀）；win32 不 detached（`.cmd` 垫片丢 stdio）
      detached: useDetachedProcessGroup(),
      windowsHide: true,
      env: childEnv,
    });
    this.proc = proc;

    if (proc.pid === undefined) {
      // ENOENT early check
      const err = await new Promise<Error | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 5000);
        proc.once('error', (e: Error) => {
          clearTimeout(timer);
          resolve(e);
        });
      });
      this._closed = true;
      this.proc = null;
      const reason = err ? `ENOENT: ${this.binary} not found` : `spawn failed: ${this.binary}`;
      this.notifyClose(reason);
      return;
    }

    getLogger().info(`[jsonrpc-transport] spawned pid=${proc.pid} binary=${this.binary}`);
    proc.stdin?.on('error', (err) => {
      getLogger().warn(`[jsonrpc-transport] stdin error: ${err.message}`);
      this.handleClose('epipe');
    });

    // Stderr: rolling buffer, last 64KB retained, only log
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderrBuf = (stderrBuf + text).slice(-MAX_STDERR_BYTES);
      getLogger().debug(`[jsonrpc-transport] stderr: ${text.trimEnd()}`);
      // §4.4 win32 command-not-found 嗅探：命中只记嫌疑标记，不立即杀——
      // agent 正常输出可能引用该错误文本（调试 Windows 报错场景），见行即杀
      // 会误杀 run；定性由 onExit 的「标记 + 非零退出」双条件完成，真挂起由
      // 上层超时兜底
      if (isWindowsCommandNotFoundLine(text)) {
        this.commandNotFoundSeen = true;
        getLogger().error(
          `[jsonrpc-transport] command not found suspected (win32 shim): ${text.trimEnd()}`,
        );
      }
    });

    // Stdout: byte-based line split. Keeping bytes until the newline avoids
    // corrupting a UTF-8 code point split across Node Buffer chunks and makes
    // the limit match the actual wire size.
    let pieces: Buffer[] = [];
    let bufferedBytes = 0;
    let droppingOversizedLine = false;
    const clearReadBuffer = () => {
      pieces = [];
      bufferedBytes = 0;
      droppingOversizedLine = false;
    };
    this.clearReadBuffer = clearReadBuffer;
    const deliver = (line: Buffer): void => {
      if (!line.length || this._closed) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line.toString('utf8'));
      } catch (err) {
        getLogger().warn(
          `[jsonrpc-transport] failed to parse JSON: ${(err as Error).message}; bytes=${line.length}`,
        );
        return;
      }
      events.onMessage(msg);
    };
    proc.stdout?.on('data', (chunk: Buffer) => {
      let start = 0;
      while (!this._closed && start < chunk.length) {
        if (droppingOversizedLine) {
          const newline = chunk.indexOf(0x0a, start);
          if (newline < 0) return;
          droppingOversizedLine = false;
          start = newline + 1;
          continue;
        }
        const newline = chunk.indexOf(0x0a, start);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        const length = bufferedBytes + part.length;
        if (length > MAX_LINE_BYTES) {
          getLogger().warn(
            `[jsonrpc-transport] line exceeds ${MAX_LINE_BYTES} bytes (actual ${
              newline >= 0 ? length : `at least ${length}`
            } bytes), dropping line`,
          );
          clearReadBuffer();
          if (newline < 0) {
            droppingOversizedLine = true;
            return;
          }
          start = end + 1;
          continue;
        }
        if (part.length) pieces.push(part);
        bufferedBytes = length;
        if (newline >= 0) {
          const line = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, bufferedBytes);
          clearReadBuffer();
          deliver(line);
        }
        start = end + 1;
      }
    });

    // 'close' follows stdout EOF; 'exit' may arrive before its final data.
    const onExit = (code: number | null, signal: string | null) => {
      if (!this._closed && bufferedBytes) deliver(Buffer.concat(pieces, bufferedBytes));
      clearReadBuffer();
      this.clearReadBuffer = undefined;
      this._closed = true;
      if (this.proc === proc) this.proc = null;
      this.writeQueue = [];
      this.flushing = false;
      // §4.4 双条件定性：嫌疑标记 + 非零正常退出 → command-not-found。
      // reason 仅供日志/诊断，消费方不解析该字符串（baseOnClose 无参）。
      let reason = signal ? `signal:${signal}` : `exit:${code}`;
      if (this.commandNotFoundSeen && signal === null && code !== null && code !== 0) {
        getLogger().error(
          `[jsonrpc-transport] command not found confirmed (win32 shim): exit=${code} stderr=${stderrBuf.slice(-512)}`,
        );
        reason = `command_not_found:${reason}`;
      }
      this.notifyClose(reason);
      getLogger().info(
        `[jsonrpc-transport] process exited pid=${proc.pid} code=${code} signal=${signal}`,
      );
    };
    proc.once('close', onExit);
    proc.once('error', (err) => {
      getLogger().error(`[jsonrpc-transport] process error: ${err.message}`);
      this.handleClose(`error:${err.message}`);
    });
  }

  /**
   * Write a JSON message as a single line to the process's stdin.
   * On EPIPE, triggers onClose('epipe') without throwing.
   */
  write(msg: object): void {
    if (this._closed || !this.proc?.stdin) {
      return;
    }
    try {
      // 入队后顺序 flush；write() 返回 false（高水位）时暂停直到 drain，
      // 避免大消息/突发消息在 Node 内部无限缓冲（review P3-8）。
      this.writeQueue.push(Buffer.from(JSON.stringify(msg) + '\n', 'utf8'));
      this.flush();
    } catch {
      this.handleClose('epipe');
    }
  }

  /** Send queued lines to stdin, pausing on backpressure until drain. */
  private flush(): void {
    const stdin = this.proc?.stdin;
    if (this._closed || !stdin || this.flushing) return;
    this.flushing = true;
    const next = (): void => {
      if (this._closed) {
        this.writeQueue = [];
        this.flushing = false;
        return;
      }
      const chunk = this.writeQueue.shift();
      if (!chunk) {
        this.flushing = false;
        return;
      }
      try {
        const ok = stdin.write(chunk, (err) => {
          if (err) {
            this.handleClose('epipe');
          }
        });
        if (!ok) {
          // 流满：等待 drain 再发下一条，队列有界（调用方同步节奏）。
          stdin.once('drain', next);
        } else {
          next();
        }
      } catch {
        this.handleClose('epipe');
      }
    };
    next();
  }

  /**
   * Gracefully stop the child process: SIGTERM → grace → SIGKILL.
   * Idempotent — safe to call multiple times.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.clearReadBuffer?.();
    this.writeQueue = [];
    this.flushing = false;
    const proc = this.proc;
    if (proc) {
      try {
        await this.stopper.stop(proc);
      } catch {
        // Ignore stop errors — process may already be dead
      }
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
    }
  }

  private handleClose(reason: string): void {
    if (this._closed) return;
    this._closed = true;
    this.writeQueue = [];
    this.flushing = false;
    this.clearReadBuffer?.();
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
      // 异常路径（EPIPE/进程 error）也要收掉子进程，避免孤儿进程继续运行。
      void this.stopper.stop(proc).catch((err: unknown) => {
        getLogger().warn(
          `[jsonrpc-transport] failed to stop process during close: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    // 统一关闭出口：EPIPE/进程 error 都必须通知上层（connection-manager
    // 靠 onClose 删除 slot、client 靠它 failPending），否则 slot 悬挂死连接。
    this.notifyClose(reason);
    getLogger().info(`[jsonrpc-transport] closed: ${reason}`);
  }

  private notifyClose(reason: string): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.events?.onClose(reason);
  }
}
