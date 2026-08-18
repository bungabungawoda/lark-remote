/**
 * JSONL-RPC transport shared by JSON-line-RPC agent servers
 * (codex app-server, kimi acp, and future ACP-style integrations).
 *
 * Wraps a child process with JSON-line-based bidirectional communication:
 * each line on stdout is a JSON message from the server; each `write()`
 * sends a JSON line to stdin.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { ProcessStopper } from '../process-stopper.js';
import { getLogger } from '../../../logger/index.js';

/** Max bytes for a single line before we disconnect (10MB). */
const MAX_LINE_BYTES = 10 * 1024 * 1024;

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
    // agent 是用户自己的可信二进制，provider 认证依赖 API key /
    // 自定义 provider 的 env_key，代理环境依赖 HTTP(S)_PROXY、TMPDIR 等；
    // 任何白名单收窄都会打断认证或网络。调用方 this.env 覆盖 process.env 同名键。
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...this.env };

    const proc = spawn(this.binary, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: childEnv,
    });
    this.proc = proc;

    if (proc.pid === undefined) {
      // ENOENT early check
      const err = await new Promise<Error | undefined>((resolve) => {
        proc.once('error', (e: Error) => resolve(e));
        setTimeout(() => resolve(undefined), 5000);
      });
      this._closed = true;
      const reason = err ? `ENOENT: ${this.binary} not found` : `spawn failed: ${this.binary}`;
      events.onClose(reason);
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
    });

    // Stdout: line-split with 10MB line limit
    let remainder = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      remainder += chunk.toString('utf-8');
      const lines = remainder.split('\n');
      // Lines except the last (incomplete) one
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) continue;
        if (line.length > MAX_LINE_BYTES) {
          getLogger().error(
            `[jsonrpc-transport] line exceeds ${MAX_LINE_BYTES} bytes, disconnecting`,
          );
          this.handleClose('parse_error');
          return;
        }
        try {
          const msg = JSON.parse(line);
          events.onMessage(msg);
        } catch (err) {
          getLogger().warn(
            `[jsonrpc-transport] failed to parse JSON: ${(err as Error).message} line=${line.slice(0, 200)}`,
          );
        }
      }
    });

    // Handle process exit
    const onExit = (code: number | null, signal: string | null) => {
      this._closed = true;
      this.proc = null;
      // Flush remaining buffer
      if (remainder.length > 0) {
        try {
          const msg = JSON.parse(remainder);
          events.onMessage(msg);
        } catch {
          // ignore trailing incomplete line
        }
      }
      const reason = signal ? `signal:${signal}` : `exit:${code}`;
      events.onClose(reason);
      getLogger().info(
        `[jsonrpc-transport] process exited pid=${proc.pid} code=${code} signal=${signal}`,
      );
    };
    proc.once('exit', onExit);
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
    // Remove the exit listener to avoid double-firing
    if (this.proc) {
      this.proc.removeAllListeners('exit');
      this.proc.removeAllListeners('error');
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
      // 异常路径（EPIPE/超长行/进程 error）也要收掉子进程，避免孤儿进程
      // 继续运行（如超长行场景子进程还在往 stdout 灌数据）。
      void this.stopper.stop(proc).catch((err: unknown) => {
        getLogger().warn(
          `[jsonrpc-transport] failed to stop process during close: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    // 统一关闭出口：EPIPE/超长行/进程 error 都必须通知上层（connection-manager
    // 靠 onClose 删除 slot、client 靠它 failPending），否则 slot 悬挂死连接。
    this.events?.onClose(reason);
    getLogger().info(`[jsonrpc-transport] closed: ${reason}`);
  }
}
