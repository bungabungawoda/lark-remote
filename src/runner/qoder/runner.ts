/**
 * Qoder Runner 实现
 *
 * QoderRunner 是 workspace-lifetime 的薄包装，进程与协议细节在 QoderSession
 * （src/runner/qoder/session.ts，复用 ClaudeSession 的长驻 stream-json 会话
 * 机制）。每次 run() 委托 session：确保进程（可 --resume）→ 写 user 消息 →
 * 消费事件直到本 turn result。
 *
 * 结构镜像 ClaudeRunner（src/runner/claude/runner.ts）：审批响应、runCompact
 * （/compact 经 stdin）与生命周期都薄委托给 ClaudeSession / QoderSession，
 * 差异只有 kind、默认模型口径（无 model-catalog 别名表，模型名原样上报）
 * 与 spawn 输入。审批动作映射归 stream-json 通道 owner（ClaudeSession）。
 */
import type { AgentSessionReader } from '../../session-contract.js';
import {
  type AgentEvent,
  type SpawnOptions,
  type AgentRunner,
  type AgentStatusInfo,
} from '../types.js';
import { QoderSession } from './session.js';

/**
 * Qoder 内建压缩命令。与 claude 同源：stream-json 输入模式下该文本会被 CLI
 * 本地拦截为 slash 命令（不会作为模型提示词转发），压缩 turn 以普通 result
 * 收尾。
 */
const COMPACT_COMMAND = '/compact';

/**
 * result.usage 里参与「是否全零」判定的 token 字段（claude 原生命名）。
 */
interface ZeroCheckUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * 剥掉全零 usage：qoder 的 usage token 字段实测恒为 0（真实数字只有
 * credits，2026-11-05 探针），保留它会让 done 卡渲染
 * 「Input token - 0 / Total token - 0」这类误导行；剥掉后 bridge 走
 * jsonl 兜底（reader 判 0 → usage 整体缺席，卡片诚实缺省）。
 * 压缩 result（/compact）携带真实 usage，不受影响。
 */
function stripZeroUsageResult(event: AgentEvent): AgentEvent {
  const usage = (event as { usage?: ZeroCheckUsage }).usage;
  if (!usage) return event;
  const tokens = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  ];
  if (tokens.every((n) => n === undefined || n === 0)) {
    const { usage: _stripped, ...rest } = event as AgentEvent & { usage?: ZeroCheckUsage };
    return rest;
  }
  return event;
}

export class QoderRunner implements AgentRunner {
  readonly kind = 'qoder' as const;
  readonly lifetime = 'workspace' as const;
  readonly sessionReader: AgentSessionReader;

  private readonly session: QoderSession;
  private readonly defaultModel?: string;
  private readonly defaultEffort?: string;
  private readonly permissionMode: string;

  constructor(opts: {
    model?: string;
    reasoningEffort?: string;
    settings?: string;
    stopGraceMs?: number;
    pidDir?: string;
    cwd: string;
    spawnHeartbeatMs?: number;
    /** CLI 二进制名（CN 版 `qodercn` / 国际版 `qoder`，来自 config cli.binary）。 */
    binary?: string;
    /**
     * 由组合根（`src/index.ts`）注入，与 sessionReaderRegistry 里的**同一个**
     * 实例（runner 不自己 new reader：runner ↔ session 循环依赖）。
     */
    sessionReader: AgentSessionReader;
    /** Qoder 权限模式（官方 snake_case 枚举；'default'=省略参数）。 */
    permissionMode?: string;
    /** 显式上下文窗口（tokens）；缺省 = 跟随 CLI/模型默认。 */
    contextWindow?: number;
    /** 会话级空闲回收 TTL（ms）；0=禁用。 */
    idleTtlMs?: number;
  }) {
    this.defaultModel = opts.model;
    this.defaultEffort = opts.reasoningEffort;
    this.permissionMode = opts.permissionMode ?? 'default';
    this.sessionReader = opts.sessionReader;
    this.session = new QoderSession({
      pidDir: opts.pidDir,
      cwd: opts.cwd,
      stopGraceMs: opts.stopGraceMs,
      spawnHeartbeatMs: opts.spawnHeartbeatMs,
      binary: opts.binary,
      permissionMode: this.permissionMode,
      settings: opts.settings,
      effort: this.defaultEffort,
      contextWindow: opts.contextWindow,
      idleTtlMs: opts.idleTtlMs,
    });
  }

  get isRunning(): boolean {
    return this.session.isRunning;
  }

  get pid(): number | undefined {
    return this.session.pid;
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: 'qoder',
      model: this.defaultModel ?? '(qoder)',
      reasoning: this.defaultEffort,
      extras: { permissionMode: this.permissionMode },
    };
  }

  /** 每 turn 入口：委托 QoderSession（确保进程 → 写消息 → 消费到 result）。 */
  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    for await (const event of this.session.run(message, opts)) {
      yield event.type === 'result' ? stripZeroUsageResult(event) : event;
    }
  }

  /**
   * 压缩当前会话：`/compact` 作为一条 user 消息写入 stream-json 通道
   * （与 ClaudeRunner.runCompact 契约一致，bridge 按能力声明门控）。
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (!opts.sessionId) {
      throw new Error('compact requires a sessionId');
    }
    // 与 run 同过全零剥离：小会话压缩的回包可能 token 全 0（真实压缩统计
    // 来自磁盘 compact_boundary，不走 live usage）。
    for await (const event of this.session.run(COMPACT_COMMAND, opts)) {
      yield event.type === 'result' ? stripZeroUsageResult(event) : event;
    }
  }

  /**
   * 审批响应：委托 ClaudeSession（stream-json 通道的 owner，claude / qoder
   * 共用同一份 ApprovalAction → control 协议映射）。
   */
  async respondApproval(requestId: number | string, response: unknown): Promise<void> {
    await this.session.respondApproval(requestId, response);
  }

  async stop(opts?: { immediate?: boolean }): Promise<void> {
    await this.session.stop(opts);
  }

  killOrphan(): void {
    this.session.killOrphan();
  }

  registerExitHandlers(): void {
    this.session.registerExitHandlers();
  }

  unregisterExitHandlers(): void {
    this.session.unregisterExitHandlers();
  }

  /**
   * 进程级退出清理（SIGINT/SIGTERM/exit 分发器最终调 session.cleanupOnExit）。
   * 暴露为委托 seam 供测试直接触发；生产路径由注册到分发器的 session 触发。
   */
  cleanupOnExit(): void {
    this.session.cleanupOnExit();
  }

  /** 释放会话（bridge 淘汰槽位时调用，进程组终止）。 */
  async dispose(): Promise<void> {
    await this.session.dispose();
  }
}
