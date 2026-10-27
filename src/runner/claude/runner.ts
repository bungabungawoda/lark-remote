/**
 * Claude Runner 实现
 *
 * ClaudeRunner 从「一次一跑」（claude -p <msg> --permission-mode
 * bypassPermissions）升级为长驻交互会话（--input-format stream-json 双向
 * 通道），同时复用本项目已有的 ApprovalCoordinator + run 卡审批区。
 *
 * 架构：ClaudeRunner 是 workspace-lifetime 的薄包装，进程与协议细节在
 * ClaudeSession（src/runner/claude/session.ts，extends SpawningRunner 复用
 * pid 文件/killOrphan/Terminator/心跳/退出分发器机制）。每次 run() 委托
 * session：确保进程（可 --resume）→ 写 user 消息 → 消费事件直到本 turn result。
 */
import type { AgentSessionReader } from '../../session-contract.js';
import {
  type AgentEvent,
  type SpawnOptions,
  type AgentRunner,
  type AgentStatusInfo,
  type ApprovalAction,
} from '../types.js';
import { ClaudeSession } from './session.js';
import { MODEL_ID_TO_ALIAS } from '../../model-catalog.js';

/**
 * Claude 内建压缩命令。stream-json 输入模式下该文本会被 CLI 本地拦截为
 * slash 命令（不会作为模型提示词转发），压缩 turn 以普通 result 收尾
 * （真实 claude 2.1.233 实测：小会话返回 "Not enough messages to compact."，
 * 有内容则返回摘要文本 + result success）。
 */
const COMPACT_COMMAND = '/compact';

/**
 * Claude Agent Runner（长驻交互模式）。
 *
 * 权限模式（permissionMode）在 spawn 时经 --permission-mode 生效：
 * - 默认 auto：低风险操作自动放行，高风险操作的 control_request 上抛 →
 *   bridge ApprovalCoordinator → run 卡审批区；
 * - bypassPermissions：claude 内部全部放行，无 control_request（无审批卡）。
 */
export class ClaudeRunner implements AgentRunner {
  readonly kind = 'claude' as const;
  readonly lifetime = 'workspace' as const;
  readonly sessionReader: AgentSessionReader;

  private readonly session: ClaudeSession;
  private readonly defaultModel: string;
  private readonly defaultEffort: string;
  private readonly permissionMode: string;

  constructor(opts: {
    model?: string;
    effort?: string;
    settings?: string;
    stopGraceMs?: number;
    pidDir?: string;
    cwd: string;
    spawnHeartbeatMs?: number;
    /**
     * 由组合根（`src/index.ts`）注入，与 sessionReaderRegistry 里的**同一个**实例。
     * claude 不在此处自己 new：那会让 runner 反向依赖 session 层（runner ↔ session
     * 循环的一半）；其余 agent 从一开始就是注入的。
     */
    sessionReader: AgentSessionReader;
    /** Claude 权限模式（官方 --permission-mode 枚举；'default'=省略参数）。 */
    permissionMode?: string;
    /** 会话级空闲回收 TTL（ms）；0=禁用。 */
    idleTtlMs?: number;
  }) {
    this.defaultModel = opts.model ?? 'claude-opus-4-8';
    this.defaultEffort = opts.effort ?? 'medium';
    this.permissionMode = opts.permissionMode ?? 'auto';
    this.sessionReader = opts.sessionReader;
    this.session = new ClaudeSession({
      pidDir: opts.pidDir,
      cwd: opts.cwd,
      stopGraceMs: opts.stopGraceMs,
      spawnHeartbeatMs: opts.spawnHeartbeatMs,
      permissionMode: this.permissionMode,
      settings: opts.settings,
      effort: this.defaultEffort,
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
    const alias = MODEL_ID_TO_ALIAS[this.defaultModel] ?? this.defaultModel;
    const isHaiku = this.defaultModel.includes('haiku');
    return {
      kind: 'claude',
      model: alias,
      reasoning: isHaiku ? 'off' : this.defaultEffort,
      extras: { permissionMode: this.permissionMode },
    };
  }

  /**
   * 每 turn 入口：委托 ClaudeSession（确保进程 → 写消息 → 消费到 result）。
   */
  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    yield* this.session.run(message, opts);
  }

  /**
   * 压缩当前会话：把 CLI 内建 `/compact` 命令作为一条 user 消息写入
   * stream-json 通道，复用 run() 的进程回收/长驻逻辑消费到 turn 终态。
   * bridge 通过鸭子类型（`'runCompact' in runner`）探测该能力，与 codex
   * app-server / kimi ACP 的 runCompact 契约一致。
   */
  async *runCompact(_message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (!opts.sessionId) {
      throw new Error('compact requires a sessionId');
    }
    yield* this.session.run(COMPACT_COMMAND, opts);
  }

  /**
   * 审批响应（bridge ApprovalCoordinator → runner）：映射 ApprovalAction 到
   * Claude 控制协议的 allow/deny（accept_all = allow + 本会话自动放行）。
   */
  async respondApproval(requestId: number | string, response: unknown): Promise<void> {
    const action = (response as ApprovalAction | { action?: string })?.action ?? 'decline';
    switch (action) {
      case 'accept':
        await this.session.respondPermission(requestId, { behavior: 'allow' });
        return;
      case 'accept_all':
        this.session.setAutoApprove(true);
        await this.session.respondPermission(requestId, { behavior: 'allow' });
        return;
      case 'accept_with_feedback': {
        // 计划审批「批准并采纳修改」：allow + updatedInput.plan（改写过的新计划），
        // 触发 Claude 侧 planWasEdited → tool_result 回显 edited plan 并写回文件。
        const plan = (response as { plan?: string }).plan;
        if (!plan || !plan.trim()) {
          throw new Error('approval accept_with_feedback missing plan payload');
        }
        await this.session.respondPermission(requestId, {
          behavior: 'allow',
          updatedInput: { plan },
        });
        return;
      }
      case 'decline_with_feedback': {
        // 计划审批「拒绝并附意见」：deny + message，Claude 留在 plan 模式修订。
        const message = (response as { message?: string }).message?.trim();
        if (!message) {
          throw new Error('approval decline_with_feedback missing message payload');
        }
        await this.session.respondPermission(requestId, { behavior: 'deny', message });
        return;
      }
      case 'decline':
        await this.session.respondPermission(requestId, { behavior: 'deny' });
        return;
      case 'cancel': {
        // 审批超时/取消：deny 送达后中断 turn（对齐「审批超时未响应，
        // 已自动取消」终态；仅 deny 会让 claude 继续回合导致卡片 done）。
        await this.session.respondPermission(requestId, {
          behavior: 'deny',
          message: '审批超时未响应，已自动取消。',
        });
        await this.session.stop({ immediate: true });
        return;
      }
      case 'answer': {
        const answers = (response as { answers?: Record<string, string | string[]> }).answers;
        if (!answers) {
          throw new Error('approval answer missing answers payload');
        }
        await this.session.respondAskUserQuestion(requestId, answers);
        return;
      }
      default:
        await this.session.respondPermission(requestId, { behavior: 'deny' });
    }
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
