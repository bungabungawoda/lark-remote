/**
 * KimiAcpRunner: workspace-lifetime runner using the Kimi ACP protocol
 * (`kimi acp`, JSON-RPC over stdio).
 *
 * Flow per run: acquire persistent connection → session/new or session/resume
 * → synthetic init → session/prompt → consume session/update notifications
 * until prompt settles → result event.
 *
 * Turn/connection/compact/approval orchestration lives in BaseAcpRunner.
 * Kimi-specific parts:
 * - compaction is a BACKGROUND task: after the compact prompt settles, poll
 *   wire.jsonl for a NEW terminal compaction record (§5.2, never fake success)
 * - terminal/* reverse RPC: kimi delegates Bash execution to the client —
 *   this runner spawns one-shot local bash processes (handleTerminalRequest)
 * - terminal-backed Bash tool notifications are filtered (bashToolCallIds) so
 *   the run card doesn't get duplicate output-less Bash panels
 * - AskUserQuestion flows through elicitation forms + a request_permission
 *   question bridge (buildQuestionResponse)
 */

import type { AgentKind, AgentSessionReader, AgentStatusInfo, SpawnOptions } from '../../types.js';
import type { ChildProcess } from 'node:child_process';
import { spawnProcess, mergeProcessEnv } from '../../../platform/spawn.js';

import { StringDecoder } from 'node:string_decoder';
import {
  ConnectionManager,
  type ConnectionManagerOptions,
} from '../../common/jsonrpc/connection-manager.js';
import { JsonRpcClient } from '../../common/jsonrpc/client.js';
import { KimiAcpTranslator } from './translator.js';
import {
  type AcpMode,
  type SessionPromptResult,
  type SessionSetModeParams,
  type RequestPermissionParams,
  type RequestPermissionResponse,
  type ElicitationCreateResponse,
  type TerminalCreateParams,
  type TerminalOutputParams,
  type TerminalWaitForExitParams,
  type TerminalKillParams,
  type TerminalReleaseParams,
  NotificationMethod,
  RpcErrorCode,
  ServerRequestMethod,
} from '../../common/acp/protocol-types.js';
import {
  KIMI_APPROVAL_KINDS,
  type AcpPendingApproval,
  buildAcpPermissionOutcome,
} from '../../common/acp/protocol-helpers.js';
import { mapAnswersByIndex } from '../../question-common.js';
import { getLogger } from '../../../logger/index.js';
import { BaseAcpRunner } from '../../common/acp/base-acp-runner.js';
import { ProcessStopper } from '../../common/process-stopper.js';

// =============================================================================
// Configuration
// =============================================================================

export interface KimiAcpRunnerOptions {
  kind: AgentKind;
  sessionReader: AgentSessionReader;
  /** Path to the kimi binary. Defaults to `kimi`. */
  binary?: string;
  /** Environment variables. */
  env?: Record<string, string | undefined>;
  /** Args to spawn the ACP server with. Defaults to `['acp']`. */
  acpArgs?: string[];
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Idle TTL for connection manager. */
  idleTtlMs?: number;
  /** How long to wait for turn output before failing. Defaults to 10 min. */
  turnIdleTimeoutMs?: number;
  /** §5.2: compaction 等待的沉默超时——距上次观察到任何新 compaction 记录
   *  （begin/terminal）超过该时长仍未终态才放弃（outcome unknown，卡片 error，
   *  不再「超时=成功」）。默认 10 分钟（对齐 turnIdleTimeoutMs）。压缩是完整
   *  LLM 请求（引擎带重试），时长无上限，旧的固定 30s 轮询超时已删除。 */
  compactIdleTimeoutMs?: number;
  model?: string;
  /** Kimi permission mode (user-facing: manual/auto/yolo). */
  permissionMode?: 'manual' | 'auto' | 'yolo';
}

/** §5.2: compaction 等待的默认沉默超时（对齐 turnIdleTimeoutMs 默认值）。 */
const COMPACT_IDLE_TIMEOUT_MS = 10 * 60_000;
/** Poll interval for the wire.jsonl compaction record. */
const COMPACT_POLL_INTERVAL_MS = 1_000;

// =============================================================================
// kimi terminal 工具（Bash 执行下放客户端）
// 契约：kimi-code/packages/acp-server/src/acp-terminal/acpTerminalRunner.ts
//   一次性 bash -c <script>，非交互 PTY、无 stdin；服务端每 250ms 轮询
//   terminal/output，客户端只回累计 stdout。创建/轮询/等待/杀/释放五个
//   reverse RPC 全部由本 runner 本地 spawn 子进程实现。
// =============================================================================

/** terminal/create 未显式给 outputByteLimit 时的缓冲上限（对齐服务端默认 4MB）。 */
const TERMINAL_DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;

/** 一个存活 terminal 的本地句柄：子进程 + 累计输出缓冲 + 退出状态。 */
interface TerminalHandle {
  proc: ChildProcess;
  /** stdout(+stderr) 累计输出（服务端自行按 emitted 偏移切片，客户端回全量）。 */
  output: string;
  /** 已喂给缓冲的字节数（截断按字节算，不能按 UTF-16 单元算）。 */
  outputBytes: number;
  /** 缓冲字节上限（outputByteLimit）。 */
  outputLimit: number;
  /** 缓冲达到上限后置 true（后续 chunk 丢弃，不再 append）。 */
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  /** 进程退出（或 spawn 失败）时 resolve；wait_for_exit 未退出时 await 它。 */
  exitPromise: Promise<void>;
}

/** Minimal shape of a wire.jsonl compaction record (full source of truth:
 *  kimi-code wire-manifest — context.apply_compaction carries
 *  compactedCount/tokensBefore/tokensAfter; full_compaction.complete is
 *  {type, time} only). */
interface CompactionRecordLike {
  type: string;
  source?: string;
  compactedCount?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  time: number;
}

/** 压缩终态记录：complete / apply_compaction 完成，cancel 为失败或取消（共用）。 */
function isCompactionTerminalLike(record: CompactionRecordLike): boolean {
  return (
    record.type === 'full_compaction.complete' ||
    record.type === 'context.apply_compaction' ||
    record.type === 'full_compaction.cancel'
  );
}

/** 沉默窗口的展示文案（测试用小窗口显示秒，生产默认显示分钟）。 */
function formatIdleWindow(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** Duck-typed capability on the session reader for R2 polling. */
interface CompactionRecordReader {
  readCompactionRecords?(sessionId: string, cwd: string): CompactionRecordLike[];
}

/**
 * Map user-facing permission mode to ACP mode id.
 *
 * ACP layer mode ids (acp-server/src/modes.ts:49):
 *   default → permission manual
 *   auto    → permission auto
 *   yolo    → permission yolo
 *   plan    → not exposed in v1
 *
 * This is not self-invented naming — both are official enums at their
 * respective layers. The mapping happens only at the ACP boundary.
 */
function toAcpMode(mode: 'manual' | 'auto' | 'yolo'): AcpMode {
  switch (mode) {
    case 'manual':
      return 'default';
    case 'auto':
      return 'auto';
    case 'yolo':
      return 'yolo';
  }
}

/**
 * AskUserQuestion 回编（kind === 'question'）：
 * - elicitation form：answer → {action:'accept', content:{q0..qn}}（多选数组/
 *   单选字符串，key 按问题顺序）；decline → {action:'decline'}；cancel →
 *   {action:'cancel'}。
 * - request_permission 兜底桥：answer → 按 label 回显 q0_opt_{i} optionId；
 *   decline → q0_skip optionId（无则 cancelled）；cancel → cancelled。
 * 答案以 {问题文本: 值} 回传，先按问题顺序展开再协议编码。
 */
function buildQuestionResponse(
  action: string,
  pending: AcpPendingApproval,
  response: unknown,
): RequestPermissionResponse | ElicitationCreateResponse {
  if (pending.proto === 'elicitation') {
    if (action === 'answer') {
      const answers = (response as { answers?: Record<string, string | string[]> }).answers;
      const questions = pending.view.questions ?? [];
      const byIndex = mapAnswersByIndex(questions, answers ?? {});
      const content: Record<string, string | string[]> = {};
      questions.forEach((q, i) => {
        const value = byIndex[i];
        if (value === undefined) return;
        if (q.multiSelect) {
          const values = Array.isArray(value) ? value : [value];
          const cleaned = values.filter((v) => typeof v === 'string' && v.length > 0);
          if (cleaned.length > 0) content[`q${i}`] = cleaned;
        } else {
          const single = Array.isArray(value) ? value[0] : value;
          if (typeof single === 'string' && single.length > 0) content[`q${i}`] = single;
        }
      });
      return { action: 'accept', content };
    }
    if (action === 'decline') return { action: 'decline' };
    return { action: 'cancel' };
  }

  // request_permission 兜底桥（单题单选）
  if (action === 'answer') {
    const answers = (response as { answers?: Record<string, string | string[]> }).answers;
    const first = pending.view.questions?.[0];
    const value = first ? answers?.[first.question] : undefined;
    const label = Array.isArray(value) ? value[0] : value;
    const option = (pending.options ?? []).find(
      (opt) => /^q\d+_opt_\d+$/.test(opt.optionId) && opt.name === label,
    );
    if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
    return { outcome: { outcome: 'cancelled' } };
  }
  if (action === 'decline') {
    const skip = (pending.options ?? []).find((opt) => /^q\d+_skip$/.test(opt.optionId));
    if (skip) return { outcome: { outcome: 'selected', optionId: skip.optionId } };
    return { outcome: { outcome: 'cancelled' } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

// =============================================================================
// Runner
// =============================================================================

export class KimiAcpRunner extends BaseAcpRunner<KimiAcpTranslator> {
  private permissionMode: 'manual' | 'auto' | 'yolo';
  private readonly compactIdleTimeoutMs: number;
  /**
   * §5.2 compaction baseline: wire.jsonl records sampled by compactBaseline()
   * BEFORE the compact prompt fires (reset per compact run). onCompactPromptFired
   * derives both the terminal-count baseline and the total-count probe from it.
   */
  private compactBaselineRecords: CompactionRecordLike[] = [];

  /** 存活 terminal（kimi 把 Bash 执行下放客户端）：terminalId → 本地句柄。 */
  private terminals = new Map<string, TerminalHandle>();
  /** terminalId 自增序号（term-1, term-2, …）。 */
  private terminalSeq = 0;
  /**
   * kimi 服务端对 Bash 工具的 tool_call/tool_call_update 通知（title='Bash'）。
   * Bash 的真实执行走 terminal/* reverse RPC 下放客户端，tool 事件由本 runner
   * 自产（tool_use 带命令、tool_result 带本地输出）；这些通知必须过滤，否则
   * 卡片出现双份 Bash 面板（通知版无 rawInput、terminal embed 无 rawOutput，
   * 只能渲染「_无输出_」）。收集到的 toolCallId 用于过滤对应的 update。
   */
  private bashToolCallIds = new Set<string>();
  /** 当前 run 的 session cwd（terminal/create 未给 cwd 时回退用）。 */
  private activeCwd: string | null = null;
  private readonly processStopper = new ProcessStopper({ graceMs: 2_000 });

  constructor(opts: KimiAcpRunnerOptions) {
    const managerOpts: ConnectionManagerOptions = {
      binary: opts.binary ?? 'kimi',
      args: opts.acpArgs ?? ['acp'],
      env: opts.env,
      requestTimeoutMs: opts.requestTimeoutMs,
      idleTtlMs: opts.idleTtlMs,
      initializeParams: {
        protocolVersion: 1,
        clientCapabilities: {
          // fs 保持关闭：kimi 服务端在 fs 能力为 false 时走本地磁盘兜底
          // （acpFsService.ts AcpHostFileSystem.inner），kimi 是本地子进程，
          // 本地盘即工作区盘，读写正常；声明 true 则服务端改发 fs/* reverse
          // RPC，lark-remote 未实现该面，文件读写会 METHOD_NOT_FOUND 失败。
          fs: { readTextFile: false, writeTextFile: false },
          // terminal 常开：yolo/auto 自主跑命令；manual 走 session/request_permission 审批。
          terminal: true,
          // AskUserQuestion 走 elicitation form（原生多题+多选；form 失败时
          // kimi 服务端自动回退 request_permission 桥，客户端两者都处理）。
          // 注意：ACP SDK 对 elicitation.form 的 zod schema 是对象
          // （z.record(z.string(), z.any())），布尔 true 会被 kimi 服务端静默
          // 丢弃 → elicitationForm=false → 多选回退成 request_permission 单选
          // 桥（勾一个选项即提交）。必须用空对象 {}。
          elicitation: { form: {} },
        },
      },
    };
    super(
      {
        kind: opts.kind,
        sessionReader: opts.sessionReader,
        turnIdleTimeoutMs: opts.turnIdleTimeoutMs,
      },
      new ConnectionManager(managerOpts),
    );
    this.model = opts.model;
    this.permissionMode = opts.permissionMode ?? 'manual';
    this.compactIdleTimeoutMs = opts.compactIdleTimeoutMs ?? COMPACT_IDLE_TIMEOUT_MS;
  }

  protected get logTag(): string {
    return 'kimi-acp-runner';
  }

  protected get turnTimeoutErrorMessage(): string {
    return 'Kimi ACP turn timed out';
  }

  protected get turnInterruptedErrorMessage(): string {
    return 'Kimi ACP turn interrupted';
  }

  protected get connectionClosedMessage(): string {
    return 'Kimi ACP connection closed';
  }

  protected shouldDeferStop(): boolean {
    return !this.promptSettled;
  }

  protected createTranslator(): KimiAcpTranslator {
    return new KimiAcpTranslator();
  }

  protected async applyTurnSettings(client: JsonRpcClient, sessionId: string): Promise<void> {
    // CC-07: 下发配置的模型（provider/model）。session/new|resume 只带 cwd/mcpServers，
    // 不带 model；不主动下发则实际跑 kimi 服务端默认模型。
    // 仿 opencode 用 session/set_config_option。失败仅告警不阻断。
    if (this.model) {
      try {
        await client.request('session/set_config_option', {
          sessionId,
          configId: 'model',
          value: this.model,
        });
      } catch (err) {
        getLogger().warn(
          `[${this.logTag}] set_config_option model failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }

    // Set permission mode (§5.1): EVERY fresh ACP session starts in
    // 'default' (= manual approvals, acp-server modes.ts DEFAULT_MODE_ID),
    // so the mode must be sent unconditionally — skipping yolo leaves the
    // session in manual and tool calls stall on unanswered approvals
    // (live dark-test repro: approval_requested → idle timeout).
    const modeParams: SessionSetModeParams = {
      sessionId,
      modeId: toAcpMode(this.permissionMode),
    };
    try {
      await client.request('session/set_mode', modeParams);
    } catch (err) {
      getLogger().warn(
        `[${this.logTag}] session/set_mode failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  /**
   * §5.2: compaction is a BACKGROUND task — the prompt settles before the
   * wire.jsonl terminal record lands. Baselines are captured BEFORE the
   * compact prompt fires (see compactBaseline override — a begin record
   * landing after the fire must count as new activity, not baseline), then
   * wait for a NEW terminal (complete/apply → completed; cancel → cancelled)
   * before producing the result. There is NO total timeout — silence beyond
   * compactIdleTimeoutMs yields 'unknown' (never a fake success). Keeps the
   * connection alive while the background compaction finishes — otherwise
   * dispose/exit kills it and the record never lands (S5/S6 打回复现 /
   * 2026-08-31 事故).
   */
  protected override compactBaseline(sessionId: string, opts: SpawnOptions): number {
    const compactionReader = (this.sessionReader as CompactionRecordReader).readCompactionRecords;
    this.compactBaselineRecords = compactionReader
      ? compactionReader.call(this.sessionReader, sessionId, opts.cwd)
      : [];
    return this.compactBaselineRecords.length;
  }

  protected onCompactPromptFired(
    promptPromise: Promise<SessionPromptResult>,
    translator: KimiAcpTranslator,
    sessionId: string,
    opts: SpawnOptions,
    baselineTotalCount: number,
  ): void {
    const compactionReader = (this.sessionReader as CompactionRecordReader).readCompactionRecords;
    // Derived from the pre-fire snapshot captured by compactBaseline() —
    // re-reading here would race the prompt fire and misclassify new records.
    const baselineTerminalCount =
      this.compactBaselineRecords.filter(isCompactionTerminalLike).length;

    promptPromise.then(
      async (result) => {
        this.promptSettled = true;
        if (this.stopRequested) return; // already cancelled
        if (compactionReader) {
          // §5.4 可选防线（日志探针）：prompt settle 后既无新 begin 也无新
          // terminal → compact 未被引擎接受（可能已在跑或被拒绝）。不解析
          // "already running" 文本、不影响卡片。
          const totalNow = compactionReader.call(this.sessionReader, sessionId, opts.cwd).length;
          if (totalNow === baselineTotalCount) {
            getLogger().warn(
              `[${this.logTag}] compact 未被引擎接受（无新 begin/terminal 记录，可能已在跑或被拒绝）`,
            );
          }
          const outcome = await this.waitForCompactionTerminal(
            compactionReader,
            opts,
            baselineTerminalCount,
          );
          if (this.forceFinish) return; // stopped while polling
          if (outcome === 'completed') {
            // 压缩完成：正常翻译 prompt 结果（subtype success）。
            const resultEvent = translator.handlePromptResponse(sessionId, result);
            this.pushEvents([resultEvent]);
          } else if (outcome === 'cancelled') {
            this.pushEvents([
              translator.produceErrorResult(
                sessionId,
                '压缩未完成：已被取消或压缩请求失败（可重试）',
              ),
            ]);
          } else if (outcome === 'unknown') {
            this.pushEvents([
              translator.produceErrorResult(
                sessionId,
                `压缩状态未知：超过 ${formatIdleWindow(this.compactIdleTimeoutMs)} 未观察到完成/取消记录，压缩可能仍在后台进行`,
              ),
            ]);
          }
          // outcome === 'stopped'：不推 result，由 consumeTurn 的 interrupted 兜底。
        } else {
          const resultEvent = translator.handlePromptResponse(sessionId, result);
          this.pushEvents([resultEvent]);
        }
      },
      (err) => this.handlePromptRejected(err, translator, sessionId, 'compact'),
    );
  }

  protected buildApprovalOutcome(
    action: string,
    pending: AcpPendingApproval,
    response: unknown,
  ): unknown {
    return pending.kind === 'question'
      ? buildQuestionResponse(action, pending, response)
      : buildAcpPermissionOutcome(action, pending.options, KIMI_APPROVAL_KINDS);
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: this.kind,
      model: this.model ?? '(kimi-acp)',
      extras: {
        mode: 'acp',
        permissionMode: this.permissionMode,
      },
    };
  }

  /**
   * Hot-apply a permission-mode change to the live ACP session (§P5).
   *
   * The local cache is always updated so `getStatusInfo()` (and therefore
   * `/s`) reflects the new mode immediately. When a session is connected,
   * re-sends `session/set_mode` so the running session picks up the new mode
   * without waiting for the runner to be evicted/recreated. Failure is
   * non-fatal: the next setupTurn re-applies the cached mode unconditionally.
   */
  async updateApprovalMode(settings: {
    permissionMode?: 'manual' | 'auto' | 'yolo';
  }): Promise<void> {
    if (settings.permissionMode !== undefined) {
      this.permissionMode = settings.permissionMode;
    }
    await this.sendApprovalModeUpdate(toAcpMode(this.permissionMode));
  }

  // =========================================================================
  // Internal
  // =========================================================================

  /**
   * §5.2: 等 wire.jsonl 出现 NEW 压缩终态记录，返回判别结果而非 void。
   *
   * 压缩是完整 LLM 请求（引擎 ≤5 次重试 + overflow 收缩重试），时长无上限；
   * 旧「固定 30s 超时 = 成功」已删除。出口：
   *   completed — 观察到 full_compaction.complete / context.apply_compaction；
   *   cancelled — 观察到 full_compaction.cancel（API 失败/abort 与用户取消共用，
   *               绝不当成功）；
   *   stopped   — 等待中 stop()/forceFinish（consumeTurn 产 interrupted 兜底）；
   *   unknown   — 距上次观察到任何新 compaction 记录（begin/terminal）超过
   *               compactIdleTimeoutMs（沉默超时，压缩可能仍在后台进行）。
   * 观察到新记录即重置沉默时钟，并顺带重置 turn idle 时钟（lastEventAt +
   * wakeWaiters），避免数分钟的压缩被 consumeTurn 滚动空闲看门狗误杀。
   */
  private async waitForCompactionTerminal(
    reader: (sessionId: string, cwd: string) => CompactionRecordLike[],
    opts: SpawnOptions,
    baselineTerminalCount: number,
  ): Promise<'completed' | 'cancelled' | 'stopped' | 'unknown'> {
    const sessionId = this.activeSessionId ?? opts.sessionId ?? '';
    let lastActivityAt = Date.now();
    let lastTotalCount = reader.call(this.sessionReader, sessionId, opts.cwd).length;
    while (true) {
      if (this.forceFinish || this.stopRequested) return 'stopped';
      const records = reader.call(this.sessionReader, sessionId, opts.cwd);
      if (records.length !== lastTotalCount) {
        lastTotalCount = records.length;
        lastActivityAt = Date.now();
        // 压缩仍在活动（新 begin / 重试 / terminal）：重置 turn idle 时钟，
        // 让 consumeTurn 重新计算滚动截止时间。
        this.lastEventAt = Date.now();
        this.wakeWaiters();
      }
      const terminalRecords = records.filter(isCompactionTerminalLike);
      if (terminalRecords.length > baselineTerminalCount) {
        const newest = terminalRecords[terminalRecords.length - 1];
        getLogger().info(
          `[${this.logTag}] compaction terminal observed (${newest.type}, ${terminalRecords.length} > baseline ${baselineTerminalCount})`,
        );
        return newest.type === 'full_compaction.cancel' ? 'cancelled' : 'completed';
      }
      if (Date.now() - lastActivityAt >= this.compactIdleTimeoutMs) {
        getLogger().warn(
          `[${this.logTag}] no compaction terminal within ${this.compactIdleTimeoutMs}ms of last activity (baselineTerminal=${baselineTerminalCount}); reporting unknown`,
        );
        return 'unknown';
      }
      await new Promise((resolve) => setTimeout(resolve, COMPACT_POLL_INTERVAL_MS));
    }
  }

  protected override handleNotification(method: string, params: unknown): void {
    // Terminal-backed Bash 的通知走 runner 自产事件（见 bashToolCallIds），
    // 不交给 translator；其余通知（Read/Edit/text/thinking）正常翻译。
    if (method === NotificationMethod.SESSION_UPDATE && this.filterBashNotifications(params)) {
      return;
    }
    const events = this.currentTranslator?.handleNotification(method, params) ?? [];
    this.pushEvents(events);
  }

  /**
   * Filter kimi's own Bash tool notifications so the run card doesn't get a
   * duplicate, output-less Bash panel alongside the runner-produced one.
   *
   * - tool_call title='Bash' → remember the toolCallId, drop the notification
   *   (the tool_use comes from terminal/create with the real command).
   * - tool_call_update for a remembered id → drop (streaming args deltas and
   *   the terminal embed final update; the tool_result is emitted locally).
   * Returns true when the notification should be swallowed.
   */
  private filterBashNotifications(params: unknown): boolean {
    if (typeof params !== 'object' || params === null) return false;
    const update = (params as { update?: Record<string, unknown> }).update;
    if (!update || typeof update !== 'object') return false;
    if (update.sessionUpdate === 'tool_call') {
      if (update.title === 'Bash') {
        if (typeof update.toolCallId === 'string') {
          this.bashToolCallIds.add(update.toolCallId);
        }
        return true;
      }
      return false;
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const toolCallId = update.toolCallId;
      if (typeof toolCallId === 'string' && this.bashToolCallIds.has(toolCallId)) {
        // 终态后清掉 id，避免集合随会话无限增长（漏清无碍：id 全局唯一）。
        if (update.status === 'completed' || update.status === 'failed') {
          this.bashToolCallIds.delete(toolCallId);
        }
        return true;
      }
      return false;
    }
    return false;
  }

  protected override handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    // kimi terminal 工具：Bash 执行下放客户端（acp-terminal reverse RPC）。
    // 请求本身是纯 request/response I/O，不交给 translator（避免落入下方
    // 「空事件 → 拒绝」兜底）；对应的 tool_use/tool_result 事件由
    // handleTerminalCreate 自产（带本地命令与输出，见 bashToolCallIds）。
    if (method.startsWith('terminal/')) {
      void this.handleTerminalRequest(id, method, params);
      return;
    }

    const events = this.currentTranslator?.handleServerRequest(id, method, params) ?? [];

    if (events.length === 0) {
      // Unhandled/unsupported server request must be explicitly responded to
      // (error = "rejected"), otherwise the server hangs waiting for a
      // response. For question elicitation (§5.4), auto-respond cancelled.
      const rpParams = params as RequestPermissionParams;
      if (
        method === ServerRequestMethod.REQUEST_PERMISSION &&
        (rpParams.isQuestion || !rpParams.toolCall)
      ) {
        this.currentClient?.respond(id, { outcome: { outcome: 'cancelled' } });
        getLogger().info(
          `[${this.logTag}] auto-responded cancelled to question elicitation requestId=${id}`,
        );
      } else {
        this.currentClient?.respondError(
          id,
          RpcErrorCode.METHOD_NOT_FOUND,
          `Unsupported server request: ${method}`,
        );
      }
      return;
    }

    this.registerApprovalEvents(
      events,
      (params as RequestPermissionParams).options,
      method === ServerRequestMethod.ELICITATION_CREATE ? 'elicitation' : 'permission',
    );
    this.pushEvents(events);
  }

  /**
   * Handle a kimi terminal/* reverse RPC by spawning a one-shot local process.
   *
   * 契约（kimi-code acp-terminal/acpTerminalRunner.ts）：
   *   create → 立即回 {terminalId}，进程异步跑，不阻塞 RPC；
   *   output → 回累计 stdout（非增量，服务端按 emitted 偏移切片）；
   *   wait_for_exit → 未退出则等 exit 再回 {exitCode, signal}；
   *   kill/release → 杀进程并回 {}。
   */
  private async handleTerminalRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      switch (method) {
        case ServerRequestMethod.TERMINAL_CREATE:
          this.handleTerminalCreate(id, params as TerminalCreateParams);
          return;
        case ServerRequestMethod.TERMINAL_OUTPUT:
          this.handleTerminalOutput(id, params as TerminalOutputParams);
          return;
        case ServerRequestMethod.TERMINAL_WAIT_FOR_EXIT:
          await this.handleTerminalWaitForExit(id, params as TerminalWaitForExitParams);
          return;
        case ServerRequestMethod.TERMINAL_KILL:
          await this.handleTerminalKill(id, params as TerminalKillParams);
          return;
        case ServerRequestMethod.TERMINAL_RELEASE:
          await this.handleTerminalRelease(id, params as TerminalReleaseParams);
          return;
        default:
          this.currentClient?.respondError(
            id,
            RpcErrorCode.METHOD_NOT_FOUND,
            `Unsupported server request: ${method}`,
          );
      }
    } catch (err) {
      getLogger().warn(
        `[${this.logTag}] terminal request failed method=${method}: ${(err as Error).message}`,
      );
      this.currentClient?.respondError(
        id,
        RpcErrorCode.INTERNAL_ERROR,
        `Terminal request failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * terminal/create: spawn 一次性进程（bash -c <script>），流式累积
   * stdout(+stderr) 到缓冲，立即回 {terminalId}。
   */
  private handleTerminalCreate(id: number | string, params: TerminalCreateParams): void {
    const env = params.env
      ? Object.fromEntries(params.env.map((e) => [e.name, e.value]))
      : undefined;
    const cwd = params.cwd ?? this.activeCwd ?? undefined;
    const outputLimit = params.outputByteLimit ?? TERMINAL_DEFAULT_OUTPUT_LIMIT;

    const proc = spawnProcess(params.command, params.args ?? [], {
      cwd,
      // env 覆盖大小写不敏感合并（win32 PATH/Path 双键防护，v2 §8.3）
      env: env ? mergeProcessEnv(process.env, env) : undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      // ProcessStopper 用负 PID 杀进程组（kill(-pgid)）；子进程必须是组长
      // 才能命中，否则 kill(-pid) 抛 ESRCH 被吞 → kill/release/清理全失效。
      // 与 JsonlRpcTransport / spawning-runner 的 detached:true 同模式。
      detached: true,
    });

    // 每个流独立 decoder：多字节字符跨 chunk 拆分时由 decoder 保留不完整
    // 序列，避免按 chunk 单独 toString 产生 U+FFFD 替换符。
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const append = (chunk: Buffer, decoder: StringDecoder) => {
      if (handle.truncated) return;
      const remaining = handle.outputLimit - handle.outputBytes;
      if (remaining > 0 && chunk.length <= remaining) {
        handle.output += decoder.write(chunk);
        handle.outputBytes += chunk.length;
      } else if (remaining > 0) {
        // 只喂 remaining 字节；decoder 内部保留末尾不完整序列，不会在字节
        // 边界产生替换符。outputBytes 按「喂入字节」计，保证不超过上限。
        handle.output += decoder.write(chunk.subarray(0, remaining));
        handle.outputBytes += remaining;
      }
      // 契约（手册）：truncated = 缓冲 >= limit——恰好填满也标 true。
      if (handle.outputBytes >= handle.outputLimit) handle.truncated = true;
    };
    proc.stdout?.on('data', (chunk) => append(chunk, stdoutDecoder));
    proc.stderr?.on('data', (chunk) => append(chunk, stderrDecoder));

    // spawn 失败（如 ENOENT）只发 'error' 不发 'exit'——一并 resolve，防止
    // wait_for_exit 永久挂起（runner 层 ENOENT 兜底红线）。
    // 用 resolveExit 承接，避免回调在 handle 初始化前引用它（TDZ）。
    let resolveExit: (() => void) | undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    // 与 resolveExit 同款 TDZ 规避：tool_result 发射闭包在 terminalId 初始化
    // 后赋值，exit/error 回调执行时经 emitResult 间接调用。
    let emitTerminalResult: (() => void) | undefined = undefined;
    const emitResult = () => {
      emitTerminalResult?.();
    };
    const handle: TerminalHandle = {
      proc,
      output: '',
      outputBytes: 0,
      outputLimit,
      truncated: false,
      exitCode: null,
      signal: null,
      exitPromise,
    };
    proc.once('exit', (code, signal) => {
      handle.exitCode = code;
      handle.signal = signal;
      resolveExit?.();
      emitResult();
    });
    proc.once('error', (err) => {
      getLogger().warn(`[${this.logTag}] terminal process error: ${err.message}`);
      if (handle.exitCode === null && handle.signal === null) {
        handle.exitCode = 1;
        handle.signal = null;
      }
      resolveExit?.();
      emitResult();
    });

    const terminalId = `term-${++this.terminalSeq}`;
    this.terminals.set(terminalId, handle);
    // Bash 工具事件由本 runner 自产（kimi 通知已过滤）：create 即推 tool_use
    // 带真实命令，让 run 卡立刻出现可识别的 Bash 面板。
    const script =
      Array.isArray(params.args) && params.args.length > 1 ? params.args[1] : params.command;
    let resultEmitted = false;
    emitTerminalResult = () => {
      if (resultEmitted) return;
      resultEmitted = true;
      this.pushEvents([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: terminalId,
                content: handle.output,
                is_error: handle.exitCode !== 0,
              },
            ],
          },
          timestamp: new Date().toISOString(),
        },
      ]);
    };
    this.pushEvents([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: terminalId,
              name: 'Bash',
              input: { command: script, cwd },
            },
          ],
        },
        timestamp: new Date().toISOString(),
      },
    ]);
    getLogger().info(
      `[${this.logTag}] terminal created id=${terminalId} command=${params.command} args=${JSON.stringify(params.args ?? [])}`,
    );
    this.currentClient?.respond(id, { terminalId });
  }

  /** terminal/output: 回累计全量输出 + truncated + 当前退出状态（可未退出）。 */
  private handleTerminalOutput(id: number | string, params: TerminalOutputParams): void {
    const handle = this.terminals.get(params.terminalId);
    if (!handle) {
      this.currentClient?.respondError(
        id,
        RpcErrorCode.INVALID_PARAMS,
        `Unknown terminal: ${params.terminalId}`,
      );
      return;
    }
    this.currentClient?.respond(id, {
      output: handle.output,
      truncated: handle.truncated,
      exitStatus: { exitCode: handle.exitCode, signal: handle.signal },
    });
  }

  /** terminal/wait_for_exit: 未退出则等 exit promise 再回 {exitCode, signal}。 */
  private async handleTerminalWaitForExit(
    id: number | string,
    params: TerminalWaitForExitParams,
  ): Promise<void> {
    const handle = this.terminals.get(params.terminalId);
    if (!handle) {
      this.currentClient?.respondError(
        id,
        RpcErrorCode.INVALID_PARAMS,
        `Unknown terminal: ${params.terminalId}`,
      );
      return;
    }
    await handle.exitPromise;
    this.currentClient?.respond(id, { exitCode: handle.exitCode, signal: handle.signal });
  }

  /** terminal/kill: 立即杀进程组，回 {}。 */
  private async handleTerminalKill(id: number | string, params: TerminalKillParams): Promise<void> {
    const handle = this.terminals.get(params.terminalId);
    if (!handle) {
      this.currentClient?.respondError(
        id,
        RpcErrorCode.INVALID_PARAMS,
        `Unknown terminal: ${params.terminalId}`,
      );
      return;
    }
    await this.processStopper.stop(handle.proc, { immediate: true });
    this.currentClient?.respond(id, {});
  }

  /** terminal/release: 从 map 删除；进程仍在则一并杀，回 {}。 */
  private async handleTerminalRelease(
    id: number | string,
    params: TerminalReleaseParams,
  ): Promise<void> {
    const handle = this.terminals.get(params.terminalId);
    if (!handle) {
      this.currentClient?.respondError(
        id,
        RpcErrorCode.INVALID_PARAMS,
        `Unknown terminal: ${params.terminalId}`,
      );
      return;
    }
    this.terminals.delete(params.terminalId);
    // stop 对已退出进程是 no-op；仍在跑则立即 SIGTERM+SIGKILL。
    await this.processStopper.stop(handle.proc, { immediate: true });
    this.currentClient?.respond(id, {});
  }

  /** Kill every live terminal (dispose/connection-close 清理钩子)。 */
  private async cleanupTerminals(): Promise<void> {
    const handles = [...this.terminals.values()];
    this.terminals.clear();
    for (const handle of handles) {
      await this.processStopper.stop(handle.proc, { immediate: true });
    }
  }

  // =========================================================================
  // BaseAcpRunner hooks
  // =========================================================================

  protected override onConnectionAcquired(opts: SpawnOptions): void {
    this.activeCwd = opts.cwd;
  }

  protected override onConnectionClosed(): void {
    void this.cleanupTerminals();
  }

  protected override onClearTurnState(): void {
    this.activeCwd = null;
  }

  protected override async beforeDisposeConnections(): Promise<void> {
    // 关闭前 kill/release 所有存活 terminal，避免孤儿 bash 进程。
    await this.cleanupTerminals();
  }
}
