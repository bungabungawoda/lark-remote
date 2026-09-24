/**
 * JSONL-RPC transport shared by JSON-line-RPC agent servers
 * (codex app-server, kimi acp, and future ACP-style integrations).
 *
 * Wraps a child process with JSON-line-based bidirectional communication:
 * each line on stdout is a JSON message from the server; each `write()`
 * sends a JSON line to stdin.
 */

import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  spawnProcess,
  mergeProcessEnv,
  isWindowsCommandNotFoundLine,
  useDetachedProcessGroup,
} from '../../../platform/spawn.js';
import { binaryName } from '../../../platform/identity.js';
import { createTerminator, type Terminator } from '../../../platform/terminator.js';
import {
  AgentStopperRegistry,
  agentStopperRegistry,
  type AgentStopper,
} from '../../../platform/agent-stopper.js';
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
  private terminator: Terminator;
  private readonly binary: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  /** 协议停止通道查找键（与 Terminator 用的 agent key 同一来源，见构造函数）。 */
  private readonly agent: string;
  private readonly stoppers: AgentStopperRegistry;
  private readonly stopperFactory?: (pid: number) => AgentStopper | undefined;
  /** 已登记的通道（agent+pid 键）；null = 本连接没有可用通道或已注销。 */
  private registration: { pid: number; stopper: AgentStopper } | null = null;
  /** JSON lines buffered while stdin is under backpressure (bounded by callers). */
  private writeQueue: Buffer[] = [];
  private flushing = false;
  /** §4.4 win32 嗅探嫌疑标记（双条件定性见下方 onExit）。 */
  private commandNotFoundSeen = false;

  constructor(opts: {
    binary: string;
    args: string[];
    cwd: string;
    env?: Record<string, string | undefined>;
    /** win32 查协议停止通道用的 agent key；缺省取 binary 名（'kimi'/'codex'/…） */
    agent?: string;
    /** 终止器注入（测试用）；默认按平台建实现 */
    terminator?: Terminator;
    /**
     * 协议停止通道工厂（design §3.3）：spawn 成功后按 pid 建通道并登记到
     * AgentStopperRegistry，进程退出/关闭时注销。返回 undefined = 无通道。
     */
    stopper?: (pid: number) => AgentStopper | undefined;
    /** 协议通道注册表注入（测试隔离）；默认进程级单例 */
    stoppers?: AgentStopperRegistry;
  }) {
    this.binary = opts.binary;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.env = opts.env ?? {};
    // 协议停止通道按 agent key 索引：调用方（connection-manager）只给 binary，
    // 这里用 binaryName 归一（含 win32 的 `.cmd` 垫片与全路径两种形态），
    // 免得每个协议 runner 都要重复传一遍 agent 名。
    this.agent = opts.agent ?? binaryName(opts.binary);
    this.stoppers = opts.stoppers ?? agentStopperRegistry;
    this.stopperFactory = opts.stopper;
    // Terminator 与注册表共用同一个 agent key 和同一张表：两边任一取错来源，
    // 查表就静默失配（优雅段退化回树杀还不报错），所以都从这里下传。
    this.terminator =
      opts.terminator ??
      createTerminator({ graceMs: 5000, agent: this.agent, stoppers: this.stoppers });
  }

  /** 子进程 pid（spawn 前/退出后为 undefined）；供测试与连接层按 pid 定位。 */
  get pid(): number | undefined {
    return this.proc?.pid;
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
        proc.once('error', (e: Error) => resolve(e));
        setTimeout(() => resolve(undefined), 5000);
      });
      this._closed = true;
      const reason = err ? `ENOENT: ${this.binary} not found` : `spawn failed: ${this.binary}`;
      events.onClose(reason);
      return;
    }

    getLogger().info(`[jsonrpc-transport] spawned pid=${proc.pid} binary=${this.binary}`);
    // 子进程起来后立刻登记协议停止通道：win32 上 graceful stop 没有信号可拦，
    // 只有这条通道能让 agent server 自己收摊（关 stdin / 取消在途 turn）。
    this.registerStopper(proc.pid);
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

    // Stdout: line-split with 10MB line limit
    // decoder 跨 chunk 缓冲半个多字节字符：逐 chunk toString 会把中文/emoji 打成
    // 不可逆的 U+FFFD，且 remainder 拼接后无法复原
    const decoder = new StringDecoder('utf8');
    let remainder = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      remainder += decoder.write(chunk);
      const lines = remainder.split('\n');
      // Lines except the last (incomplete) one
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) continue;
        // 上限量的是 UTF-8 字节：中文 1 单元 = 3 字节，用 line.length 会低估 2-3×
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
          getLogger().error(
            `[jsonrpc-transport] line exceeds ${MAX_LINE_BYTES} bytes, disconnecting`,
          );
          this.handleClose('parse_error');
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          getLogger().warn(
            `[jsonrpc-transport] failed to parse JSON: ${(err as Error).message} line=${line.slice(0, 200)}`,
          );
          continue;
        }
        // handler 抛错是消费方故障，与协议解码无关；单独捕获以免掩盖真实故障点，
        // 且不能打断同一 chunk 里后续的帧
        try {
          events.onMessage(msg);
        } catch (err) {
          getLogger().error(
            `[jsonrpc-transport] onMessage handler threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    });

    // Handle process exit
    const onExit = (code: number | null, signal: string | null) => {
      this._closed = true;
      // 进程已经没了：留着旧 pid 的通道只会在 pid 复用后指向无关进程。
      this.unregisterStopper();
      this.proc = null;
      // Flush remaining buffer（decoder.end() 吐出最后半个多字节字符）
      remainder += decoder.end();
      if (remainder.length > 0) {
        try {
          const msg = JSON.parse(remainder);
          events.onMessage(msg);
        } catch {
          // ignore trailing incomplete line
        }
      }
      // §4.4 双条件定性：嫌疑标记 + 非零正常退出 → command-not-found。
      // reason 仅供日志/诊断，消费方不解析该字符串（baseOnClose 无参）。
      let reason = signal ? `signal:${signal}` : `exit:${code}`;
      if (this.commandNotFoundSeen && signal === null && code !== null && code !== 0) {
        getLogger().error(
          `[jsonrpc-transport] command not found confirmed (win32 shim): exit=${code} stderr=${stderrBuf.slice(-512)}`,
        );
        reason = `command_not_found:${reason}`;
      }
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
        await this.terminator.stop(proc, { immediate: false });
      } catch {
        // Ignore stop errors — process may already be dead
      }
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
    }
    // 注销必须在 stop() 之后：Terminator 就是在上面那次调用里查表取通道的。
    this.unregisterStopper();
  }

  /**
   * 按 pid 登记协议停止通道（工厂返回 undefined = 该 agent 无通道）。
   * pid 是归属键：同一 agent 的多条长驻连接各有自己的通道，不能互相顶替。
   */
  private registerStopper(pid: number): void {
    const stopper = this.stopperFactory?.(pid);
    if (!stopper) return;
    this.stoppers.register(this.agent, pid, stopper);
    this.registration = { pid, stopper };
  }

  /** 注销自己登记的那条通道（幂等；带身份校验，防误删同 pid 上的新通道）。 */
  private unregisterStopper(): void {
    const reg = this.registration;
    if (!reg) return;
    this.registration = null;
    this.stoppers.unregister(this.agent, reg.pid, reg.stopper);
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
      void this.terminator
        .stop(proc, { immediate: false })
        .catch((err: unknown) => {
          getLogger().warn(
            `[jsonrpc-transport] failed to stop process during close: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        })
        .finally(() => {
          // 通道查表发生在上面这次 stop() 里，注销必须等它落定。
          this.unregisterStopper();
        });
    }
    // 统一关闭出口：EPIPE/超长行/进程 error 都必须通知上层（connection-manager
    // 靠 onClose 删除 slot、client 靠它 failPending），否则 slot 悬挂死连接。
    this.events?.onClose(reason);
    getLogger().info(`[jsonrpc-transport] closed: ${reason}`);
  }
}
