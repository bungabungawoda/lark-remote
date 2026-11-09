/**
 * CodebuddyAcpRunner: workspace-lifetime runner using CodeBuddy's ACP mode
 * (`codebuddy --acp`, JSON-RPC over stdio). Registered as the codebuddy
 * agent's runner.
 *
 * Flow per run: acquire persistent connection → session/new or session/resume
 * → applyTurnSettings → session/prompt → consume session/update notifications
 * until prompt settles → result event.
 *
 * Turn/connection/compact/approval orchestration lives in BaseAcpRunner;
 * CodeBuddy-specific parts:
 * - clientCapabilities 只声明 fs:false / terminal:false：官方文档明确「客户端
 *   声明 fs/terminal 能力时代理到客户端执行」——我们不实现该面，声明 false
 *   让 CodeBuddy 本地自执行（同 opencode 的口径）。
 * - Agent Teams 私有扩展过滤：`session_info_update._meta['codebuddy.ai/
 *   teamUpdate']` 与成员消息的 `_meta['codebuddy.ai/memberEvent']` 不进主
 *   事件流（§9.27 codex 子线程污染的同源教训）。
 * - /compact 按 opencode 的同步口径处理（prompt 结算即结果；CodeBuddy 的
 *   压缩后台态无类似 kimi wire.jsonl 的观察通道，待真机验证后再加）。
 * - 用量：ACP `usage_update` 的 `_meta.usage` 带每次模型请求的 input/output，
 *   translator 按 turn 累加（`used/size` 恒为 0，只作上下文水位兜底）；flow
 *   走 live（getUsageAuthority()='live'），context/cumulative 走 reader。
 */

import type { AgentKind } from '../../../agent-kinds.js';
import type { AgentSessionReader } from '../../../session-contract.js';
import type { AgentStatusInfo } from '../../types.js';
import {
  ConnectionManager,
  type ConnectionManagerOptions,
} from '../../common/jsonrpc/connection-manager.js';
import { JsonRpcClient } from '../../common/jsonrpc/client.js';
import { CodebuddyAcpTranslator } from './translator.js';
import {
  type SessionResumeResult,
  type SessionNewResult,
  type SessionSetModeParams,
  type AcpMode,
  NotificationMethod,
} from '../../common/acp/protocol-types.js';
import { CODEBUDDY_CLIENT_CAPABILITIES } from '../../../acp-protocol.js';
import { CODEBUDDY_APPROVAL_KINDS, type AcpApprovalKinds } from '../../common/acp/acp-approval.js';
import { getLogger } from '../../../logger/index.js';
import { BaseAcpRunner } from '../../common/acp/base-acp-runner.js';

export interface CodebuddyAcpRunnerOptions {
  kind: AgentKind;
  sessionReader: AgentSessionReader;
  /** Path to the codebuddy binary. Defaults to `codebuddy`. */
  binary?: string;
  /** Environment variables（如 CN 版的 CODEBUDDY_INTERNET_ENVIRONMENT）。 */
  env?: Record<string, string | undefined>;
  /** Args to spawn the ACP server with. Defaults to `['--acp']`. */
  acpArgs?: string[];
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Idle TTL for connection manager. */
  idleTtlMs?: number;
  /** How long to wait for turn output before failing. Defaults to 30 min. */
  turnIdleTimeoutMs?: number;
  model?: string;
  /** CodeBuddy permission mode（官方 modes 枚举；'default' 省略下发）。 */
  permissionMode?: string;
  /** 思考档位（ACP thought_level；undefined = 不下发）。 */
  thinkingLevel?: string;
  /** 沙箱（ACP sandbox；undefined = 不下发）。 */
  sandbox?: boolean;
}

/** session/new|resume 回读到的会话当前配置（只保留桥接会下发的三项）。 */
export interface SessionCurrent {
  model?: string;
  thinkingLevel?: string;
  sandbox?: boolean;
}

/**
 * 会话配置回读（纯函数）。model 主通道是 `models.currentModelId`，
 * configOptions 的 `model` 仅在主通道缺席时兜底；sandbox 的 wire 值是
 * 'true'/'false' 字符串。未知字段保持缺失 → applyTurnSettings 按需下发
 * （fail open）。
 */
interface SessionConfigOption {
  id?: unknown;
  currentValue?: unknown;
}

/** 单条 configOption 折叠进 current；值必须是字符串，未知 id 忽略。 */
function mergeConfigOption(current: SessionCurrent, option: SessionConfigOption | null): void {
  if (!option) return;
  const value = option.currentValue;
  if (typeof value !== 'string') return;
  if (option.id === 'model' && current.model === undefined) current.model = value;
  if (option.id === 'thought_level') current.thinkingLevel = value;
  if (option.id === 'sandbox') current.sandbox = value === 'true';
}

export function sessionCurrentFrom(result: unknown): SessionCurrent {
  const rec = result as {
    models?: { currentModelId?: unknown };
    configOptions?: Array<SessionConfigOption | null>;
  };
  const current: SessionCurrent = {};
  const modelId = rec.models?.currentModelId;
  if (typeof modelId === 'string') current.model = modelId;
  for (const option of rec.configOptions ?? []) {
    mergeConfigOption(current, option);
  }
  return current;
}

export class CodebuddyAcpRunner extends BaseAcpRunner<CodebuddyAcpTranslator> {
  /** ACP `_meta.usage` 带逐请求 input/output：flow 用 live 的本 turn 累加。 */
  getUsageAuthority(): 'live' {
    return 'live';
  }

  private permissionMode: string;
  private readonly thinkingLevel?: string;
  private readonly sandbox?: boolean;
  /**
   * 会话当前配置（session/new|resume 的 configOptions 回读）。长驻连接跨 turn
   * 复用，三个 set_config_option 只在「目标 ≠ 会话当前」时下发；未回读到
   * （字段缺失）按需下发（fail open）。set_mode 不在此列——无条件下发。
   */
  private sessionCurrent?: SessionCurrent;

  constructor(opts: CodebuddyAcpRunnerOptions) {
    const managerOpts: ConnectionManagerOptions = {
      binary: opts.binary ?? 'codebuddy',
      args: opts.acpArgs ?? ['--acp'],
      env: opts.env,
      requestTimeoutMs: opts.requestTimeoutMs,
      idleTtlMs: opts.idleTtlMs,
      initializeParams: {
        protocolVersion: 1,
        clientCapabilities: CODEBUDDY_CLIENT_CAPABILITIES,
      },
      onConnected: (result) => {
        const version = (result as { agentInfo?: { version?: string } } | undefined)?.agentInfo
          ?.version;
        if (version) {
          getLogger().info(`[codebuddy-acp-runner] connected to CodeBuddy ${version}`);
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
    this.permissionMode = opts.permissionMode ?? 'default';
    this.thinkingLevel = opts.thinkingLevel;
    this.sandbox = opts.sandbox;
  }

  protected get logTag(): string {
    return 'codebuddy-acp-runner';
  }

  /**
   * 回读会话当前配置（session/new|resume 都带 configOptions，真机实测字段
   * 为 currentValue；model 另有 models.currentModelId）。未知字段保持缺失
   * → applyTurnSettings 按需下发（fail open）。
   */
  protected override onSessionEstablished(result: SessionResumeResult | SessionNewResult): void {
    this.sessionCurrent = sessionCurrentFrom(result);
  }

  protected get turnTimeoutErrorMessage(): string {
    return 'CodeBuddy ACP turn timed out';
  }

  protected get turnInterruptedErrorMessage(): string {
    return 'CodeBuddy ACP turn interrupted';
  }

  protected get connectionClosedMessage(): string {
    return 'CodeBuddy ACP connection closed';
  }

  protected shouldDeferStop(): boolean {
    return !this.promptSent;
  }

  protected createTranslator(): CodebuddyAcpTranslator {
    return new CodebuddyAcpTranslator();
  }

  /**
   * model / thought_level / sandbox 三段 set_config_option 的同构目标表。
   * 语义：目标未配置（undefined）→ 跳过；会话当前已等于目标 → 跳过；
   * 失败仅告警不阻断（fail open，下一轮重试）。sandbox 的官方 option value
   * 是字符串 'true'/'false'，故单独给 toWire。
   */
  private configOptionTargets(): Array<{
    configId: 'model' | 'thought_level' | 'sandbox';
    key: 'model' | 'thinkingLevel' | 'sandbox';
    current: string | boolean | undefined;
    target: string | boolean | undefined;
    toWire: (v: string | boolean) => unknown;
  }> {
    return [
      {
        configId: 'model',
        key: 'model',
        current: this.sessionCurrent?.model,
        target: this.model || undefined,
        toWire: (v) => v,
      },
      {
        configId: 'thought_level',
        key: 'thinkingLevel',
        current: this.sessionCurrent?.thinkingLevel,
        target: this.thinkingLevel || undefined,
        toWire: (v) => v,
      },
      {
        configId: 'sandbox',
        key: 'sandbox',
        current: this.sessionCurrent?.sandbox,
        target: this.sandbox,
        toWire: (v) => (v ? 'true' : 'false'),
      },
    ];
  }

  protected async applyTurnSettings(client: JsonRpcClient, sessionId: string): Promise<void> {
    for (const { configId, key, current, target, toWire } of this.configOptionTargets()) {
      if (target === undefined || current === target) continue;
      try {
        await client.request('session/set_config_option', {
          sessionId,
          configId,
          value: toWire(target),
        });
        Object.assign((this.sessionCurrent ??= {}), { [key]: target });
      } catch (err) {
        getLogger().warn(
          `[${this.logTag}] set_config_option ${configId} failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }

    // 权限模式下发：无条件发（含 'default'）。'default' 是官方 availableModes
    // 的合法 modeId；长驻连接跨 turn 复用，热切回 default 若跳过下发，旧模式
    // 会一直滞留在活会话上（kimi 的「无条件下发」教训同源）。真机实测
    // set_mode(acceptEdits) 接受并回推 current_mode_update；失败非致命。
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

  /** CodeBuddy 的 option kind 候选表；默认 buildApprovalOutcome 消费它。 */
  protected override get approvalKinds(): AcpApprovalKinds {
    return CODEBUDDY_APPROVAL_KINDS;
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: this.kind,
      model: this.model ?? '(codebuddy-acp)',
      // 与 /config 卡片同口径：未配置时显示卡片哨兵 `default`（跟随 CodeBuddy
      // 默认），不把「会话回读的当前值」混进来——/status 反映配置态，与
      // model / permissionMode 一致。
      reasoning: this.thinkingLevel || 'default',
      extras: {
        mode: 'acp',
        permissionMode: this.permissionMode,
      },
    };
  }

  /**
   * Hot-apply a permission-mode change to the live ACP session.
   * 本地缓存始终更新（/s 立即反映新值）；会话在连时重发 session/set_mode。
   * 失败非致命：下一次 setupTurn 会重新套用缓存模式。
   */
  async updateApprovalMode(settings: { permissionMode?: string }): Promise<void> {
    if (settings.permissionMode !== undefined) {
      this.permissionMode = settings.permissionMode;
    }
    // 无条件重发（含 'default'）：'default' 是官方合法 modeId，热切回默认也
    // 必须到达活会话，否则旧模式滞留到连接回收。
    await this.sendApprovalModeUpdate(this.permissionMode);
  }

  // =========================================================================
  // Notification dispatch（server-request 兜底走 BaseAcpRunner 默认实现）
  // =========================================================================

  protected override handleNotification(method: string, params: unknown): void {
    // CodeBuddy 私有扩展先过滤（Agent Teams 的团队状态/成员消息走 _meta 标记，
    // 属于成员时间线而非主对话；不滤会在 run 卡上出现无关面板）。
    if (method === NotificationMethod.SESSION_UPDATE && isCodebuddyMetaNoise(params)) {
      return;
    }
    const events = this.currentTranslator?.handleNotification(method, params) ?? [];
    this.pushEvents(events);
  }
}

/**
 * CodeBuddy 私有扩展噪声判定：`update._meta` 带 `codebuddy.ai/teamUpdate`
 * （团队状态推送）或 `codebuddy.ai/memberEvent`（成员消息标记）即不进主事件流。
 */
function isCodebuddyMetaNoise(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  const update = (params as { update?: Record<string, unknown> }).update;
  if (!update || typeof update !== 'object') return false;
  const meta = (update as { _meta?: Record<string, unknown> })._meta;
  if (!meta || typeof meta !== 'object') return false;
  return 'codebuddy.ai/teamUpdate' in meta || 'codebuddy.ai/memberEvent' in meta;
}
