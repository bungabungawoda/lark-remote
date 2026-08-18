/**
 * ClaudeSession: 长驻交互式 Claude Code 会话（stream-json 双向通道）。
 *
 * 协议（本机 claude 2.1.233 真实 spike 验证）：
 * - spawn 参数：
 *     --output-format stream-json --input-format stream-json
 *     --permission-prompt-tool stdio --replay-user-messages [--verbose]
 *     [--permission-mode <mode>] [--resume <sessionId>]
 * - 用户消息（stdin）：
 *     {"type":"user","message":{"role":"user","content":"..."}}
 * - 压缩（stdin）：content 为 "/compact" 时 CLI 本地拦截为 slash 命令（不会
 *   作为模型提示词），压缩 turn 以普通 result 收尾（真实 claude 2.1.233 实测）。
 * - 权限请求（stdout）：
 *     {"type":"control_request","request_id":"...","request":{
 *       "subtype":"can_use_tool","tool_name":"Bash","input":{...}}}
 * - 审批响应（stdin）：
 *     {"type":"control_response","response":{"subtype":"success",
 *       "request_id":"...","response":{"behavior":"allow","updatedInput":{...}}}}
 *   deny 时 response={"behavior":"deny","message":"..."}
 * - AskUserQuestion 走同一通道（tool_name="AskUserQuestion"），选项在
 *   input.questions[]；答案回填 input.answers 后 allow。
 * - result 事件 subtype 为 compact/compaction 是 turn 中途压缩，不是 turn 结束；
 *   其余 subtype（success/error/...）才是 turn 终态。
 *
 * 生命周期：一个 workspace 一个长驻进程（lifetime='workspace'）。每次
 * run(message) = 写一条 user 消息 + 消费 stdout 事件直到本 turn 的 result；
 * 进程在 turn 之间保持存活（stdin 不关闭），/stop / /new / /cd / 看门狗超时
 * 时经 ProcessStopper 组杀，下条消息按 SessionStore 的 sessionId --resume。
 */

import type { ChildProcess } from 'node:child_process';
import { silentlyUnlink } from '../../common/fs.js';
import { getLogger } from '../../logger/index.js';
import { SpawningRunner } from '../common/spawning-runner.js';
import { pipeAllStdio } from '../common/runner-utils.js';
import { authErrorEvent, syntheticInitEvent } from '../common/runner-utils.js';
import type { AgentEvent, ApprovalView, ClaudeUserQuestion, SpawnOptions } from '../types.js';

/** 拒绝权限时的默认提示（进入 claude 上下文，中文用户可读）。 */
const DENY_MESSAGE = '用户拒绝了此工具调用，请停止并等待用户指令。';

/** 会话级空闲回收默认 TTL（对齐 codex appServer.idleTtlMs 默认 30 分钟）。 */
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

/** result 事件里表示「turn 中途压缩」的 subtype（不是 turn 结束）。 */
const COMPACTION_RESULT_SUBTYPES = new Set(['compact', 'compaction']);

/** Claude 用户消息在 stdout 回显（--replay-user-messages）时 content 为 string。 */
interface ReplayedUserEvent {
  type: 'user';
  message: { content: unknown };
}

export interface ClaudeSessionOptions {
  pidDir?: string;
  workspace: string;
  stopGraceMs?: number;
  spawnHeartbeatMs?: number;
  /** Claude 权限模式（官方 --permission-mode 枚举；'default' 省略该参数）。 */
  permissionMode?: string;
  settings?: string;
  model?: string;
  effort?: string;
  /** 会话级空闲回收 TTL（ms）：turn 之间无活动超过该窗口则停止进程。0=禁用。 */
  idleTtlMs?: number;
}

/** 审批响应结果（behavior allow/deny）。 */
export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
}

/**
 * ClaudeSession extends SpawningRunner 复用其 spawn/pid 文件/killOrphan/
 * ProcessStopper/SpawnHeartbeat/退出分发器机制（P1-1/P1-10/P1-11 契约保持），
 * 但 run() 覆盖为「长驻 + 按 turn 消费」：进程跨 turn 存活，turn 结束以
 * stream-json result 事件（非 compact）为界，而不是进程退出。
 */
export class ClaudeSession extends SpawningRunner {
  private readonly permissionMode: string;
  private readonly settings?: string;
  private readonly defaultModel?: string;
  private readonly defaultEffort?: string;
  private readonly idleTtlMs: number;

  /** 当前 turn 是否在途（防止并发 run 写乱 stdin）。 */
  private turnActive = false;
  /** 本进程是否已收到 system/init（--resume 会先重放上一轮旧 result）。 */
  private sawInit = false;
  /** stdout 流是否已结束（进程退出/崩溃）。 */
  private streamEnded = false;
  /** 最近一次 spawn 的工作目录（control_request 视图用）。 */
  private cwd = '';
  /** 最近一次 init 报告的 session_id（错误结果与视图摘要用）。 */
  private sessionId = '';

  /** 已翻译事件队列（turn 消费循环读取；turn 之间清空）。 */
  private eventQueue: AgentEvent[] = [];
  private waitResolve: (() => void) | null = null;
  /** 待审批的 control_request 原始 input（回写 updatedInput 需要）。 */
  private pendingToolInputs = new Map<number | string, unknown>();
  /** 允许所有：后续 control_request 自动 allow（本会话进程生命周期内有效）。 */
  private autoApprove = false;
  /** 串行化 stdin 写入（用户消息与审批响应交错到达）。 */
  private stdinQueue: Promise<unknown> = Promise.resolve();
  private startPromise: Promise<string | null> | null = null;
  /**
   * 进程代际 token：stop()/dispose() 会先把 currentProcess 置 null，流 reader
   * 的 finally 不能再用 `currentProcess === proc` 判断归属（会漏掉 streamEnded
   * 唤醒，turn 循环永久挂起）。每次 spawn 递增，旧代际 reader 的残留事件与
   * 收尾一律跳过。
   */
  private processGeneration = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 进程退出登记（'close' 事件后 exitCode 才可靠；流结束错误路径 await 它）。 */
  private processExitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> =
    Promise.resolve({ code: null, signal: null });

  constructor(opts: ClaudeSessionOptions) {
    super({
      pidDir: opts.pidDir,
      workspace: opts.workspace,
      stopGraceMs: opts.stopGraceMs,
      spawnHeartbeatMs: opts.spawnHeartbeatMs,
      pidFilePrefix: 'claude',
      logTag: 'claude-runner',
    });
    this.binary = 'claude';
    this.permissionMode = opts.permissionMode ?? 'bypassPermissions';
    this.settings = opts.settings;
    this.defaultModel = opts.model;
    this.defaultEffort = opts.effort;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  get pid(): number | undefined {
    return this.currentProcess?.pid;
  }

  /**
   * 每 turn 入口：确保进程已 spawn（可带 --resume）→ 写用户消息 → 消费事件
   * 直到本 turn 的 result。进程在 turn 结束后保持存活，供下一条消息复用。
   */
  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (this.turnActive) {
      getLogger().warn(`[${this.logTag}] run() called while a turn is active, refusing`);
      throw new Error('claude process already running');
    }
    // turnActive 必须在 startProcess 之前置位：进程 spawn 后 isRunning 即可见，
    // 若等 startProcess 完成才置位，第二个 run() 会在竞态窗口误入（线上由
    // bridge 串行队列保护，测试直接并发调用会踩到）。
    this.turnActive = true;
    try {
      // /new（sessionId 清空）或 /resume 切换到别的会话：请求的会话与当前
      // 长驻进程实际所在的会话不一致 → 回收旧进程，按请求重新 spawn（fresh
      // 或 --resume 目标会话）。比较进程当前 session（init 报告值）而非 spawn
      // 请求值：bridge 会把 init 的 session_id 写回 SessionStore，第二条消息
      // 带着它来；若拿 spawn 请求值（''）比较，每条消息都会误判切换、杀进程
      // 重启，长驻设计失效（2026-08-16 review P0）。
      if (this.isRunning && this.sessionId !== (opts.sessionId ?? '')) {
        getLogger().info(
          `[${this.logTag}] session mismatch: process=${this.sessionId || '(fresh)'} ` +
            `requested=${opts.sessionId ?? '(fresh)'}, recycling process`,
        );
        await this.stop();
      }
      this.stoppedByUser = false;
      const spawnError = await this.startProcess(opts);
      if (spawnError) {
        // §9.22 守卫：错误 result 前必须补 synthetic init，否则 bridge 的
        // pre-init result guard 与 run-state reducer 会静默丢弃错误信息。
        yield syntheticInitEvent(opts.sessionId);
        yield authErrorEvent(spawnError);
        return;
      }
      // turn 之间的 idle 噪音（如 prompt_suggestion）不属于本 turn，先清空。
      this.eventQueue.length = 0;
      try {
        await this.writeUserMessage(message);
      } catch (err) {
        // review：stop()/进程死亡与写 stdin 竞态（EPIPE/ENOTCONN）。用户
        // stop 已置 stoppedByUser（或进程已死/流已结束）时，写入失败不抛给
        // 调用方，交由 consumeTurn 按 interrupted/error 产出终态——否则
        // stop 在途的 run 会以裸 EPIPE 崩溃（2026-08-16 复现的 flaky）。
        if (this.stoppedByUser || !this.isRunning || this.streamEnded) {
          getLogger().warn(
            `[${this.logTag}] user message write failed, process stopping: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        } else {
          throw err;
        }
      }
      yield* this.consumeTurn();
    } finally {
      this.turnActive = false;
      this.armIdleTimer();
    }
  }

  /**
   * 写一条用户消息到 stdin（--input-format stream-json 的 user 事件）。
   */
  async sendUserMessage(message: string): Promise<void> {
    await this.writeUserMessage(message);
  }

  /**
   * 回写审批响应（允许/拒绝）。
   */
  async respondPermission(requestId: number | string, result: PermissionResult): Promise<void> {
    if (!this.isRunning) {
      getLogger().warn(
        `[${this.logTag}] respondPermission skipped: process not running requestId=${requestId}`,
      );
      return;
    }
    // review P2-2：requestId 不在待审批表（已 control_cancel / 进程回收）时
    // 丢弃响应，不能以空 updatedInput allow（claude 会拿空输入执行工具）。
    if (!this.pendingToolInputs.has(requestId)) {
      getLogger().warn(
        `[${this.logTag}] respondPermission dropped: unknown requestId=${requestId}`,
      );
      return;
    }
    const input = this.pendingToolInputs.get(requestId);
    if (result.behavior === 'allow') {
      await this.writeControlResponse(requestId, {
        behavior: 'allow',
        updatedInput: input ?? {},
      });
    } else {
      await this.writeControlResponse(requestId, {
        behavior: 'deny',
        message: result.message ?? DENY_MESSAGE,
      });
    }
    this.pendingToolInputs.delete(requestId);
    getLogger().info(
      `[${this.logTag}] permission response requestId=${requestId} behavior=${result.behavior}`,
    );
  }

  /**
   * 回写 AskUserQuestion 答案：updatedInput = 原 input + answers。
   */
  async respondAskUserQuestion(
    requestId: number | string,
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    if (!this.isRunning) return;
    // review P2-2：未知 requestId 时不能回写缺原始 questions 的 answers
    // （官方要求 updatedInput 必须包含原始 questions）。
    if (!this.pendingToolInputs.has(requestId)) {
      getLogger().warn(
        `[${this.logTag}] respondAskUserQuestion dropped: unknown requestId=${requestId}`,
      );
      return;
    }
    const input = (this.pendingToolInputs.get(requestId) ?? {}) as Record<string, unknown>;
    await this.writeControlResponse(requestId, {
      behavior: 'allow',
      updatedInput: { ...input, answers },
    });
    this.pendingToolInputs.delete(requestId);
    getLogger().info(
      `[${this.logTag}] AskUserQuestion response requestId=${requestId} questions=${Object.keys(answers).length}`,
    );
  }

  /** 允许所有：后续 control_request 自动 allow（本会话进程生命周期内有效）。 */
  setAutoApprove(value: boolean): void {
    this.autoApprove = value;
    getLogger().info(`[${this.logTag}] autoApprove=${value}`);
  }

  /** 释放会话：停止进程（优雅 SIGTERM→SIGKILL）。 */
  async dispose(): Promise<void> {
    getLogger().info(`[${this.logTag}] dispose session`);
    await this.stop();
  }

  /**
   * 停止会话（覆盖基类以先清空闲回收 timer）。
   */
  async stop(opts?: { immediate?: boolean }): Promise<void> {
    this.clearIdleTimer();
    await super.stop(opts);
  }

  // =========================================================================
  // SpawningRunner hooks
  // =========================================================================

  protected getStdio(): ('ignore' | 'pipe')[] {
    return pipeAllStdio();
  }

  protected buildArgv(opts: SpawnOptions): string[] {
    const args = [
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-prompt-tool',
      'stdio',
      '--replay-user-messages',
      '--verbose',
    ];

    // 'default' = Claude 的未设置模式（settings.json 官方值），等价于不传
    // --permission-mode（交互式默认：高风险工具逐个询问）。
    // 注：claude 拒绝 root + bypassPermissions（root 下需降级为 auto）；
    // 本项目是 macOS 单用户场景不做该降级。
    if (this.permissionMode && this.permissionMode !== 'default') {
      args.push('--permission-mode', this.permissionMode);
    }

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    const effort = opts.effort ?? this.defaultEffort;
    if (effort) {
      args.push('--effort', effort);
    }

    const settings = this.settings;
    if (settings) {
      args.push('--settings', settings);
    }

    return args;
  }

  // =========================================================================
  // Internal: process lifecycle
  // =========================================================================

  /**
   * 确保长驻进程已 spawn（首次或上次被停止后）。串行化并发调用。
   * 返回 null = 成功；返回 string = spawn 失败的错误消息（调用方 yield）。
   */
  private async startProcess(opts: SpawnOptions): Promise<string | null> {
    if (this.isRunning) {
      // review P3-4：复用进程（跨 turn 长驻）时清掉上一轮的空闲回收 timer——
      // 否则长 turn 中它会空转触发一次（回调因 turnActive 空转返回，无害但
      // 多余）；新一轮结束后的 armIdleTimer 会重新武装。
      this.clearIdleTimer();
      return null;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStartProcess(opts).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStartProcess(opts: SpawnOptions): Promise<string | null> {
    this.clearIdleTimer();
    this.sawInit = false;
    this.streamEnded = false;
    this.sessionId = opts.sessionId ?? '';
    this.cwd = opts.cwd;
    this.autoApprove = false;
    this.pendingToolInputs.clear();

    let proc: ChildProcess;
    try {
      proc = await this.spawnChild(opts);
    } catch (err) {
      this.currentProcess = null;
      return (err as Error).message;
    }
    const generation = ++this.processGeneration;

    // 永久 no-op error 兜底：写成功后 once 监听已移除，若子进程随后退出导致
    // stdin 管道 EPIPE，无监听器的 'error' 事件会把进程炸成 unhandled。
    // 写入失败由 writeStdin 的 once 监听 + write 回调收敛。
    proc.stdin?.on('error', () => {
      /* EPIPE 兜底：写路径已收敛，这里只防 EventEmitter 默认抛错 */
    });

    // 进程退出登记（组杀后 close 事件触发；供流结束错误路径读取 code/signal）。
    // Node 在 stdout 'close' 后一个 tick 才落 exitCode，直接读 proc.exitCode
    // 会竞态拿到 null；必须等 proc 'close' 事件。
    this.processExitPromise = new Promise((resolve) => {
      proc.once('close', (code, signal) => {
        this.spawnHeartbeat.clear();
        this.exitCode = code;
        this.exitSignal = signal;
        if (code !== null && code !== 0 && !this.stoppedByUser) {
          getLogger().error(
            `[${this.logTag}] non-zero exit code=${code} signal=${signal} stderr=${this.spawnStderr.slice(-500)}`,
          );
        }
        resolve({ code, signal });
      });
    });

    this.startStreamReader(proc, generation);
    return null;
  }

  /**
   * 后台消费 stdout JSONL → 翻译 → 入队。进程退出时清理 pid 文件并标记
   * streamEnded 唤醒等待中的 turn 循环。
   */
  private startStreamReader(proc: ChildProcess, generation: number): void {
    const stream = this.createStreamReader(proc.stdout!);
    void (async () => {
      try {
        for await (const raw of stream) {
          if (generation !== this.processGeneration) return; // 旧进程残留事件丢弃
          const events = this.translateEvent(raw);
          if (events.length > 0) {
            this.eventQueue.push(...events);
            this.wakeWaiters();
          }
        }
      } catch (err) {
        getLogger().error(`[${this.logTag}] stream error: ${err}`);
      } finally {
        if (generation === this.processGeneration) {
          this.streamEnded = true;
          this.currentProcess = null;
          silentlyUnlink(this.pidFilePath);
          this.wakeWaiters();
        }
      }
    })();
  }

  /** 最近一次进程退出的 code/signal（流结束错误结果构造用）。 */
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;

  // =========================================================================
  // Internal: turn consumption
  // =========================================================================

  /**
   * 消费事件队列直到本 turn 的 result 事件（非 compact/compaction）。
   * 消费者提前关闭生成器（bridge 循环体抛错）→ 杀进程防孤儿（P1-11 语义）。
   *
   * result = turn 终态（2026-08-16 真实 claude 实测：长驻模式下 result 之后
   * 不再有 stdout 事件，后台任务完成是静默的；旧 -p 流程「等进程退出再收尾」
   * 的 post-result drain 在长驻模式下无对应物）。
   */
  private async *consumeTurn(): AsyncGenerator<AgentEvent> {
    let active = true;
    try {
      while (true) {
        while (this.eventQueue.length > 0) {
          const ev = this.eventQueue.shift()!;
          yield ev;
          if (isTurnResultEvent(ev)) {
            active = false;
            return;
          }
        }
        if (this.streamEnded) {
          active = false;
          yield await this.buildStreamEndedError();
          return;
        }
        await new Promise<void>((resolve) => {
          this.waitResolve = resolve;
        });
      }
    } finally {
      if (active) {
        try {
          await this.stop({ immediate: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 构造进程退出且无终态 result 时的统一错误结果（对齐 SpawningRunner 语义）。 */
  private async buildStreamEndedError(): Promise<AgentEvent> {
    // 进程已死但 proc 'close' 事件可能略晚于 stdout 关闭：等退出登记拿可靠
    // code/signal。stdout 关闭 = 进程退出（claude 独占 stdout），'close' 必然
    // 随后触发，不会挂死 turn 循环。
    const exited = await this.processExitPromise;
    const stderrTail = this.spawnStderr ? this.spawnStderr.slice(-500) : '';
    let errorMessage: string;
    if (this.stoppedByUser) {
      errorMessage = `${this.binary} interrupted by user`;
    } else if (exited.signal !== null) {
      errorMessage = `${this.binary} killed by signal ${exited.signal}${stderrTail ? `: ${stderrTail}` : ''}`;
    } else if (exited.code !== null && exited.code !== 0) {
      errorMessage = `${this.binary} exited code=${exited.code}${stderrTail ? `: ${stderrTail}` : ''}`;
    } else {
      errorMessage = `${this.binary} 输出流已结束，但未收到 result 事件${stderrTail ? `: ${stderrTail}` : ''}`;
    }
    return {
      type: 'result',
      subtype: this.stoppedByUser ? 'interrupted' : 'error',
      session_id: this.sessionId,
      errorMessage,
      timestamp: new Date().toISOString(),
    } as AgentEvent;
  }

  private wakeWaiters(): void {
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve();
    }
  }

  /**
   * 会话级空闲回收：turn 结束后 idleTtlMs 无新消息则停止进程（对齐 codex
   * ConnectionManager 的 idle TTL；/cd 遗留的旧 cwd runner 靠它回收）。
   * turn 在途时永不触发；0 表示禁用。
   */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTtlMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.turnActive || !this.isRunning) return;
      getLogger().info(
        `[${this.logTag}] idle timeout ${this.idleTtlMs}ms, stopping session workspace=${this.cwd}`,
      );
      void this.stop().catch((err: Error) => {
        getLogger().warn(`[${this.logTag}] idle stop failed: ${err.message}`);
      });
    }, this.idleTtlMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // =========================================================================
  // Internal: stdin writes
  // =========================================================================

  private async writeUserMessage(message: string): Promise<void> {
    await this.writeStdin({
      type: 'user',
      message: { role: 'user', content: message },
    });
  }

  private async writeControlResponse(
    requestId: number | string,
    response: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string },
  ): Promise<void> {
    await this.writeStdin({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  /**
   * 串行化 stdin 写入（互斥）。进程未运行/管道已毁 → 抛错（调用方按需忽略）。
   */
  private writeStdin(obj: unknown): Promise<void> {
    const p = this.stdinQueue.then(async () => {
      const proc = this.currentProcess;
      if (!proc || proc.stdin === null || proc.stdin.destroyed) {
        throw new Error('claude process is not running');
      }
      const stdin = proc.stdin;
      const data = JSON.stringify(obj) + '\n';
      await new Promise<void>((resolve, reject) => {
        // 一次性 error 监听：write 回调与 'error' 事件都会携带 EPIPE，竞态下
        // 先到者 reject、后到者无操作；回调/事件触发后立即移除，避免监听器
        // 跨写入残留（进程死后旧监听器把后续错误派发给已完结的 promise）。
        const onError = (err: Error) => {
          stdin.removeListener('error', onError);
          reject(err);
        };
        stdin.once('error', onError);
        try {
          stdin.write(data, (err) => {
            stdin.removeListener('error', onError);
            if (err) reject(err);
            else resolve();
          });
        } catch (err) {
          // 同步 throw（如 socket 已 destroy 时的 ENOTCONN）：转成正常
          // rejection，避免逃逸为 unhandled rejection。
          stdin.removeListener('error', onError);
          reject(err as Error);
        }
      });
    });
    // 单次写失败不阻塞后续写（进程已死时后续写会各自快速失败）。
    this.stdinQueue = p.catch(() => {});
    return p;
  }

  // =========================================================================
  // Internal: event translation
  // =========================================================================

  private translateEvent(raw: unknown): AgentEvent[] {
    const event = raw as Record<string, unknown>;
    const type = event.type;

    // review P3-3：--resume 会先重放上一轮历史事件（旧 result 之外还可能有
    // 旧 assistant/user 内容）。init 之前除 init 本身外一律丢弃，避免历史
    // 内容混进当前卡片（result 分支的 sawInit 守卫升级为全类型守卫）。
    if (type !== 'system' && !this.sawInit) return [];

    if (type === 'control_request') {
      return this.translateControlRequest(event);
    }
    if (type === 'control_response') {
      // claude 会把我们写入的 control_response 回显到 stdout；非新事件，丢弃。
      return [];
    }
    if (type === 'control_cancel_request') {
      // claude 撤销了一个待审批请求（turn 结束/不再需要答案）→ 协调器移除条目。
      const requestId = event.request_id as number | string | null | undefined;
      if (requestId !== null && requestId !== undefined) {
        this.pendingToolInputs.delete(requestId);
        return [
          {
            type: 'approval_resolved',
            requestId,
            outcome: 'resolved',
            timestamp: new Date().toISOString(),
          } as AgentEvent,
        ];
      }
      return [];
    }
    if (type === 'user') {
      // --replay-user-messages 会把用户消息原样回显（content 为 string）。
      // 该事件不能进卡片：run-state 的 reduceToolResultEvent 会把 string 按
      // 字符迭代成伪 tool_result。真正的 tool_result 事件 content 是数组。
      const content = (event as unknown as ReplayedUserEvent).message?.content;
      if (!Array.isArray(content)) return [];
      return [this.withTimestamp(event)];
    }
    if (type === 'result') {
      // --resume 会先重放上一轮旧 result（早于 system/init）：丢弃，否则
      // consumeTurn 把历史结果误判为当前 turn 结束。bridge 有同款守卫（双保险）。
      if (!this.sawInit) return [];
      return [this.withTimestamp(event)];
    }
    if (type === 'system' && event.subtype === 'init') {
      this.sawInit = true;
      if (typeof event.session_id === 'string' && event.session_id) {
        this.sessionId = event.session_id;
      }
      return [this.withTimestamp(event)];
    }
    // assistant / system(其他) / 未知事件：透传（补 timestamp），未知类型由
    // 下游 reducer 忽略，保留诊断价值。
    return [this.withTimestamp(event)];
  }

  private translateControlRequest(raw: Record<string, unknown>): AgentEvent[] {
    const requestId = raw.request_id as number | string | null;
    if (requestId === null || requestId === undefined) {
      getLogger().warn(`[${this.logTag}] control_request missing request_id, dropping`);
      return [];
    }
    const request = (raw.request ?? {}) as Record<string, unknown>;
    const subtype = request.subtype;
    if (subtype !== 'can_use_tool') {
      // review P3-1：未知 subtype 不能静默丢弃——claude 在等 control_response，
      // 不回应 turn 会永久挂起（无审批卡、无超时）。deny 兜底让 claude 继续。
      getLogger().warn(
        `[${this.logTag}] unknown control request subtype=${String(subtype)} requestId=${requestId}`,
      );
      void this.writeControlResponse(requestId, {
        behavior: 'deny',
        message: `不支持的审批请求类型: ${String(subtype)}`,
      }).catch((err: Error) => {
        getLogger().warn(
          `[${this.logTag}] unknown-subtype deny write failed requestId=${requestId}: ${err.message}`,
        );
      });
      return [];
    }

    const toolName = String(request.tool_name ?? '');
    const input = (request.input ?? {}) as Record<string, unknown>;
    this.pendingToolInputs.set(requestId, input);

    // review P1：允许所有只放行工具权限；AskUserQuestion 不能被空 answers
    // 自动放行（claude 会把空答案当作已作答），必须继续上抛卡片让用户回答。
    if (this.autoApprove && toolName !== 'AskUserQuestion') {
      getLogger().info(`[${this.logTag}] auto-approving requestId=${requestId} tool=${toolName}`);
      void this.writeControlResponse(requestId, {
        behavior: 'allow',
        updatedInput: input,
      }).catch((err: Error) => {
        getLogger().warn(
          `[${this.logTag}] auto-approve write failed requestId=${requestId}: ${err.message}`,
        );
      });
      // review P2-1：自动放行不经过协调器/respondPermission，条目不会随
      // 响应被删除——立即释放，否则长会话（允许所有）下 Map 无界增长。
      this.pendingToolInputs.delete(requestId);
      return [];
    }

    const now = new Date().toISOString();
    if (toolName === 'AskUserQuestion') {
      const questions = parseUserQuestions(input);
      if (questions.length === 0) {
        // 解析失败：拒绝请求，避免 claude 无限等待审批。
        getLogger().warn(
          `[${this.logTag}] AskUserQuestion parse failed, denying requestId=${requestId}`,
        );
        void this.writeControlResponse(requestId, {
          behavior: 'deny',
          message: '无法解析 AskUserQuestion 选项',
        }).catch(() => {});
        // review P2-1：解析失败 deny 后同样释放条目（不经过 respondPermission）。
        this.pendingToolInputs.delete(requestId);
        return [];
      }
      const view: ApprovalView = {
        requestId,
        kind: 'question',
        questions,
        availableDecisions: [],
      };
      return [
        {
          type: 'approval_requested',
          requestId,
          kind: 'question',
          threadId: this.sessionId,
          turnId: '',
          itemId: '',
          view,
          timestamp: now,
        } as unknown as AgentEvent,
      ];
    }

    const command = typeof input.command === 'string' ? input.command : JSON.stringify(input ?? {});
    const view: ApprovalView = {
      requestId,
      kind: 'command',
      command: command.slice(0, 500),
      commandCwd: this.cwd,
      reason: typeof request.description === 'string' ? request.description : undefined,
      // 允许所有（acceptAll）= 允许当前 + 本会话后续自动放行。
      availableDecisions: ['accept', 'decline', 'acceptAll'],
    };
    getLogger().info(`[${this.logTag}] permission request requestId=${requestId} tool=${toolName}`);
    return [
      {
        type: 'approval_requested',
        requestId,
        kind: 'command',
        threadId: this.sessionId,
        turnId: '',
        itemId: '',
        view,
        timestamp: now,
      } as unknown as AgentEvent,
    ];
  }

  /** 统一方案：所有 runner 自己生成 timestamp（缺失时补）。 */
  private withTimestamp(event: Record<string, unknown>): AgentEvent {
    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }
    return event as unknown as AgentEvent;
  }
}

/** 是否为 turn 终态 result（compact/compaction 是中途压缩，不是结束）。 */
function isTurnResultEvent(ev: AgentEvent): boolean {
  if (ev.type !== 'result') return false;
  const subtype = (ev as { subtype?: string }).subtype;
  return !(subtype !== undefined && COMPACTION_RESULT_SUBTYPES.has(subtype));
}

/** 解析 AskUserQuestion input.questions。 */
function parseUserQuestions(input: Record<string, unknown>): ClaudeUserQuestion[] {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions)) return [];

  const questions: ClaudeUserQuestion[] = [];
  const seenQuestions = new Set<string>();
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question : '';
    if (!question) continue;
    // review P3-2：answers 字典以问题文本为 key，重复文本会互相覆盖——
    // 视为解析失败（调用方 deny 兜底），不把坏问题上抛给用户。
    if (seenQuestions.has(question)) return [];
    seenQuestions.add(question);
    const options: ClaudeUserQuestion['options'] = [];
    if (Array.isArray(q.options)) {
      for (const rawOption of q.options) {
        if (!rawOption || typeof rawOption !== 'object') continue;
        const o = rawOption as Record<string, unknown>;
        const label = typeof o.label === 'string' ? o.label : '';
        if (!label) continue;
        options.push({
          label,
          ...(typeof o.description === 'string' && o.description
            ? { description: o.description }
            : {}),
        });
      }
    }
    // review P3-2：零选项问题无法作答（多选连自定义答案都没有），视为
    // 解析失败（调用方 deny 兜底），不把坏问题上抛给用户。
    if (options.length === 0) return [];
    questions.push({
      question,
      ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return questions;
}
