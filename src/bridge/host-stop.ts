import type { AgentKind } from '../agent-kinds.js';
import { isAgentKind } from '../agent-kinds.js';
import type { AppConfig } from '../config/index.js';
import type { HostStopOutcome, Runner } from '../runner/types.js';
import type { SessionReaderRegistry, SessionStore } from '../session/index.js';
import type { CommandContext, CommandResult } from './index.js';

/**
 * Stop 的宿主轮次入口（DSH）。
 *
 * 普通 run 的 stop 走 bridge.activeRuns：那是「本进程提交的 prompt」的登记表。
 * 恢复会话 / 上一个 bridge 实例 / DSH Web UI 起的 turn 没有本地 activeRun，
 * 但宿主仍然认 sessionId。这里把「按 sessionId 取消宿主 turn」收成一个入口，
 * /stop 的 fallback 与恢复卡按钮共用，避免两处各自拼 stop 语义。
 */
interface HostTurnStopDeps {
  sessionStore: SessionStore;
  sessionReaderRegistry: SessionReaderRegistry;
  /** live 取值：/config 会整体替换 config 引用。 */
  getConfig(): AppConfig;
  getRunner(cwd: string, kind?: AgentKind, opts?: { replaceStale?: boolean }): Runner;
  sendResult(result: CommandResult, ctx: CommandContext): Promise<boolean>;
}

interface HostTurnStopTarget {
  sessionId: string;
  cwd: string;
  agentKind: AgentKind;
}

export interface HostTurnStopResult {
  status: 'cancelled' | 'withdrawn' | 'unconfirmed' | 'noop' | 'unsupported';
  sessionId: string;
  agentKind: AgentKind;
  detail?: string;
  goalPhase?: HostStopOutcome['goalPhase'];
  goalActivation?: HostStopOutcome['goalActivation'];
}

type CancelCapableRunner = Runner & {
  cancelHostTurn(sessionId: string): Promise<HostStopOutcome>;
};

interface TargetError {
  error: string;
}

function hasCancelHostTurn(runner: Runner): runner is CancelCapableRunner {
  return (
    'cancelHostTurn' in runner &&
    typeof (runner as Partial<CancelCapableRunner>).cancelHostTurn === 'function'
  );
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
}

/** One formatter for /stop and card actions so the wording cannot drift. */
export function formatHostStopResult(result: HostTurnStopResult): string {
  const id = shortSessionId(result.sessionId);
  switch (result.status) {
    case 'cancelled': {
      const goal =
        result.goalPhase === 'paused'
          ? '\n目标已暂停。'
          : result.goalPhase === 'active' && result.goalActivation === 'armed'
            ? '\n目标状态仍为运行中；若 DSH 又起了下一轮，请再次终止。'
            : '';
      return `✅ 已终止 DSH 会话 ${id} 的当前轮次。${goal}`;
    }
    case 'withdrawn':
      return `✅ 已撤回 DSH 会话 ${id} 排队中的请求。`;
    case 'noop':
      return `该会话当前没有正在运行的轮次。`;
    case 'unconfirmed':
      return (
        `⚠️ 未能确认 DSH 会话 ${id} 的轮次已停止，它可能仍在后台运行。` +
        (result.detail ? `\n${result.detail}` : '') +
        '\n请在 DSH Web UI 检查；需要终止时再发一次 /stop。'
      );
    case 'unsupported':
      return '⚠️ 当前运行模式不支持终止宿主轮次。';
  }
}

export class HostTurnStop {
  private readonly deps: HostTurnStopDeps;

  constructor(deps: HostTurnStopDeps) {
    this.deps = deps;
  }

  /** 恢复/自动恢复卡上的「终止」按钮：目标由卡片显式携带。 */
  async handleCardAction(
    value: { sessionId?: string; agent?: string; cwd?: string },
    ctx: CommandContext,
  ): Promise<void> {
    const target = this.resolveExplicit(value, ctx.userId);
    if ('error' in target) {
      await this.deps.sendResult({ text: target.error }, ctx);
      return;
    }
    const result = await this.stop(target);
    await this.deps.sendResult({ text: formatHostStopResult(result) }, ctx);
  }

  /**
   * `/stop` 在本地 activeRuns/bash 全部 miss 后调用：只针对当前用户、当前
   * cwd、默认 agent 的当前 session，不扫描别的会话。
   */
  async stopCurrent(userId: string): Promise<HostTurnStopResult | undefined> {
    const agentKind = this.deps.getConfig().defaultAgent;
    if (agentKind !== 'dsh') return undefined;
    const cwd = this.deps.sessionStore.getCwd(userId);
    const sessionId = this.deps.sessionStore.getSessionId(userId, agentKind);
    if (!cwd || !sessionId) return undefined;
    return this.stop({ sessionId, cwd, agentKind });
  }

  private resolveExplicit(
    value: { sessionId?: string; agent?: string; cwd?: string },
    userId: string,
  ): HostTurnStopTarget | TargetError {
    const agentKind: AgentKind =
      value.agent && isAgentKind(value.agent) ? value.agent : this.deps.getConfig().defaultAgent;
    if (agentKind !== 'dsh') {
      return { error: '⚠️ 当前 agent 不支持终止宿主轮次' };
    }
    const cwd = value.cwd ?? this.deps.sessionStore.getCwd(userId);
    if (!cwd) return { error: '⚠️ 未设置工作目录' };
    const sessionId = value.sessionId ?? this.deps.sessionStore.getSessionId(userId, agentKind);
    if (!sessionId) return { error: '⚠️ 没有可终止的会话' };

    // 卡片可能是旧快照：session 必须仍属于这个 cwd，不能按过期的卡片值
    // 去 cancel 一个别的目录/会话。读取失败按「找不到」处理并给出可见回执。
    try {
      const content = this.deps.sessionReaderRegistry
        .get(agentKind)
        .readSessionContent(sessionId, cwd);
      if (
        content.events.length === 0 &&
        !content.usage &&
        !content.aiTitle &&
        !content.recap &&
        !content.displayTitle
      ) {
        return { error: `⚠️ 未找到 session ${shortSessionId(sessionId)}（当前目录: ${cwd}）` };
      }
    } catch (err) {
      return {
        error: `⚠️ 读取 session ${shortSessionId(sessionId)} 失败: ${(err as Error).message}`,
      };
    }
    return { sessionId, cwd, agentKind };
  }

  private async stop(target: HostTurnStopTarget): Promise<HostTurnStopResult> {
    if (target.agentKind !== 'dsh') {
      return { status: 'unsupported', sessionId: target.sessionId, agentKind: target.agentKind };
    }
    let runner: Runner;
    try {
      // replaceStale：控制动作必须打到当前配置指向的宿主，别用 /config 之前
      // 的旧 client。getRunner 自身保证有本地 activeRun 时不替换实例。
      runner = this.deps.getRunner(target.cwd, target.agentKind, { replaceStale: true });
    } catch (err) {
      return {
        status: 'unconfirmed',
        sessionId: target.sessionId,
        agentKind: target.agentKind,
        detail: (err as Error).message,
      };
    }
    if (!hasCancelHostTurn(runner)) {
      return { status: 'unsupported', sessionId: target.sessionId, agentKind: target.agentKind };
    }
    try {
      const outcome = await runner.cancelHostTurn(target.sessionId);
      return {
        status: outcome.status,
        sessionId: target.sessionId,
        agentKind: target.agentKind,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(outcome.goalPhase ? { goalPhase: outcome.goalPhase } : {}),
        ...(outcome.goalActivation ? { goalActivation: outcome.goalActivation } : {}),
      };
    } catch (err) {
      return {
        status: 'unconfirmed',
        sessionId: target.sessionId,
        agentKind: target.agentKind,
        detail: (err as Error).message,
      };
    }
  }
}
