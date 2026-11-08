/**
 * QoderAcpRunner: workspace-lifetime runner using Qoder's ACP mode
 * (`qodercn --acp`, JSON-RPC over stdio；1.1.84 initialize 握手实测通过).
 *
 * Flow per run: acquire persistent connection → session/new or session/resume
 * → applyTurnSettings（session/set_mode）→ session/prompt → consume
 * session/update notifications until prompt settles → result event.
 *
 * Turn/connection/compact/approval orchestration lives in BaseAcpRunner;
 * Qoder-specific parts:
 * - clientCapabilities 与 CodeBuddy 同口径（fs/terminal false → CLI 本地自执行，
 *   见 acp-protocol.ts）。
 * - model / reasoningEffort / contextWindow 无 ACP 协议内通道（session/new 的
 *   configOptions 只见 mode），沿用 stream-json 时代验证过的 spawn 旗标随连接
 *   下发；/config 变更后 runner 实例由桥重建（clearRunners），新连接生效。
 * - 权限模式走 session/set_mode（无条件下发，codebuddy 的「热切回 default 不
 *   下发会滞留旧模式」教训同源）；配置词汇兼容 stream-json 时代的 snake_case
 *   旧值（normalizeQoderPermissionMode 归一）。
 * - /compact 按 codebuddy/opencode 的同步口径（prompt 结算即结果；qoder ACP
 *   是否拦截 slash 命令待真机验证）。
 * - 审批 option kind 未真机验证，按 ACP 标准词汇（allow_once/allow_always/
 *   reject_once，与 mock-acp-server 同形）。
 */

import type { AgentSessionReader } from '../../../session-contract.js';
import type { AgentStatusInfo } from '../../types.js';
import {
  ConnectionManager,
  type ConnectionManagerOptions,
} from '../../common/jsonrpc/connection-manager.js';
import { JsonRpcClient } from '../../common/jsonrpc/client.js';
import { QoderAcpTranslator } from './translator.js';
import {
  type SessionNewResult,
  type SessionResumeResult,
  type SessionSetModeParams,
  type AcpMode,
} from '../../common/acp/protocol-types.js';
import { QODER_CLIENT_CAPABILITIES } from '../../../acp-protocol.js';
import type { AcpApprovalKinds } from '../../common/acp/acp-approval.js';
import { normalizeQoderPermissionMode } from '../../../config/index.js';
import { getLogger } from '../../../logger/index.js';
import { BaseAcpRunner } from '../../common/acp/base-acp-runner.js';

export interface QoderAcpRunnerOptions {
  kind: 'qoder';
  sessionReader: AgentSessionReader;
  /** CLI 二进制名（CN 版 `qodercn` / 国际版 `qoder`，config cli.binary）。 */
  binary?: string;
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Idle TTL for connection manager（config idleTtlMinutes）。 */
  idleTtlMs?: number;
  /** How long to wait for turn output before failing. */
  turnIdleTimeoutMs?: number;
  model?: string;
  /** 推理强度（--reasoning-effort；undefined = 不下发）。 */
  reasoningEffort?: string;
  /** 显式上下文窗口 tokens（--context-window；undefined = 不下发）。 */
  contextWindow?: number;
  /** 权限模式（卡片词汇或 stream-json 旧值，下发前归一为 ACP modeId）。 */
  permissionMode?: string;
}

/** ACP 标准审批 option kind（qoder 未真机验证，与 mock-acp-server 同形）。 */
export const QODER_APPROVAL_KINDS: AcpApprovalKinds = {
  accept: ['allow_once', 'allow_always'],
  acceptForSession: ['allow_always'],
  decline: ['reject_once', 'reject'],
};

/**
 * ACP 连接的 spawn 参数：`--acp` + 模型/推理强度/上下文窗口旗标（stream-json
 * 时代验证过的下发通道），未配置不下发。纯函数（测试钉住 wire 形状）。
 */
export function qoderAcpSpawnArgs(opts: {
  model?: string;
  reasoningEffort?: string;
  contextWindow?: number;
}): string[] {
  const args = ['--acp'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.reasoningEffort) args.push('--reasoning-effort', opts.reasoningEffort);
  if (opts.contextWindow) args.push('--context-window', String(opts.contextWindow));
  return args;
}

export class QoderAcpRunner extends BaseAcpRunner<QoderAcpTranslator> {
  private readonly effort?: string;
  private readonly contextWindow?: number;
  private permissionMode: string;

  constructor(opts: QoderAcpRunnerOptions) {
    const managerOpts: ConnectionManagerOptions = {
      binary: opts.binary ?? 'qodercn',
      args: qoderAcpSpawnArgs(opts),
      requestTimeoutMs: opts.requestTimeoutMs,
      idleTtlMs: opts.idleTtlMs,
      initializeParams: {
        protocolVersion: 1,
        clientCapabilities: QODER_CLIENT_CAPABILITIES,
      },
      onConnected: (result) => {
        const version = (result as { agentInfo?: { version?: string } } | undefined)?.agentInfo
          ?.version;
        if (version) {
          getLogger().info(`[qoder-acp-runner] connected to Qoder ${version}`);
        }
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
    this.effort = opts.reasoningEffort;
    this.contextWindow = opts.contextWindow;
    this.permissionMode = normalizeQoderPermissionMode(opts.permissionMode ?? 'default');
  }

  protected get logTag(): string {
    return 'qoder-acp-runner';
  }

  protected get turnTimeoutErrorMessage(): string {
    return 'Qoder ACP turn timed out';
  }

  protected get turnInterruptedErrorMessage(): string {
    return 'Qoder ACP turn interrupted';
  }

  protected get connectionClosedMessage(): string {
    return 'Qoder ACP connection closed';
  }

  protected shouldDeferStop(): boolean {
    return !this.promptSent;
  }

  protected createTranslator(): QoderAcpTranslator {
    return new QoderAcpTranslator();
  }

  /**
   * 权限模式下发：无条件发（含 'default'，防止长驻连接滞留旧模式——codebuddy
   * 同源教训）。失败非致命（warn only，下一轮 setupTurn 重试）。
   */
  protected async applyTurnSettings(client: JsonRpcClient, sessionId: string): Promise<void> {
    const modeParams: SessionSetModeParams = {
      sessionId,
      modeId: this.permissionMode as AcpMode,
    };
    try {
      await client.request('session/set_mode', modeParams);
    } catch (err) {
      getLogger().warn(
        `[${this.logTag}] session/set_mode failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  /** qoder ACP 的审批 option kind 未真机验证，按 ACP 标准词汇。 */
  protected override get approvalKinds(): AcpApprovalKinds {
    return QODER_APPROVAL_KINDS;
  }

  protected override onSessionEstablished(_result: SessionResumeResult | SessionNewResult): void {
    // session/new|resume 的 configOptions/modes 回读当前未消费（mode 已按配置
    // 无条件下发；models.availableModels 目录暂走既有 --list-models 探针）。
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: this.kind,
      model: this.model ?? '(qoder-acp)',
      reasoning: this.effort,
      extras: {
        mode: 'acp',
        permissionMode: this.permissionMode,
        ...(this.contextWindow !== undefined ? { contextWindow: String(this.contextWindow) } : {}),
      },
    };
  }

  // =========================================================================
  // Notification dispatch（server-request 兜底走 BaseAcpRunner 默认实现）
  // =========================================================================

  protected override handleNotification(method: string, params: unknown): void {
    const events = this.currentTranslator?.handleNotification(method, params) ?? [];
    this.pushEvents(events);
  }
}
