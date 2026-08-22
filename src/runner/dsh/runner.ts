/**
 * DshRunner — workspace-lifetime runner bridging to the DSH Web Host
 * (DeepSeek Harness) over plain HTTP. No local subprocess is spawned.
 *
 * Flow per run: session.create(cwd) (when no sessionId) → synthetic system/init
 * (DSH has no init event) → open per-session mux subscription → session.prompt
 * (mode:'queue') → consume subscription until turn/end → result event.
 *
 * stop() → session.cancel + abort the mux subscription. killOrphan /
 * registerExitHandlers are no-ops (no local process). approval/requested is
 * surfaced as a WARN log + an assistant text prompt pointing to the DSH Web UI
 * (never silently parked — the turn stays live until the user resolves it in
 * the UI or the turn is cancelled/times out).
 */

import type { AgentEvent, AgentSessionReader, AgentStatusInfo, SpawnOptions } from '../types.js';
import type { AgentRunner } from '../types.js';
import { DshClient, type WebSocketFactory } from './client.js';
import { DshTranslator } from './translator.js';
import { getLogger } from '../../logger/index.js';

/** DSH selectModel provider（deepseek-official 是 rc.7 模型目录的 provider）。 */
export const DSH_MODEL_PROVIDER = 'deepseek-official';

export interface DshRunnerOptions {
  kind: 'dsh';
  sessionReader: AgentSessionReader;
  /** DSH Web Host base URL, e.g. http://127.0.0.1:3080. */
  host?: string;
  /** Session preset（agentPreset）固定于 session 创建时；undefined = 服务端默认。 */
  agentPreset?: string;
  /** Display model name. */
  model?: string;
  /** 推理强度（off/low/high/max）；undefined = 服务端默认。 */
  reasoningEffort?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable WebSocket factory (defaults to global WebSocket). */
  webSocketImpl?: WebSocketFactory;
}

export class DshRunner implements AgentRunner {
  readonly kind = 'dsh' as const;
  readonly sessionReader: AgentSessionReader;
  readonly client: DshClient;
  /** 用户配置的模型 ID（run 前 selectModel 对齐用）；undefined = 服务端默认。 */
  private readonly configuredModel: string | undefined;
  private readonly agentPreset: string | undefined;
  private readonly reasoningEffort: string | undefined;

  private activeAbort: AbortController | null = null;
  private activeSessionId: string | null = null;
  private running = false;
  /**
   * 已对齐模型的 session 集合：同一 session 二次 run 不再重发 selectModel
   * （session.selectModel 会写服务端全局默认，每次 run 都写是写放大）。
   * configuredModel 在实例生命周期内不变（/config 改模型会 clearRunners
   * 重建实例 + 换新 sessionId），故「每 session 对齐一次」足以覆盖配置变化。
   */
  private readonly alignedSessions = new Set<string>();

  constructor(opts: DshRunnerOptions) {
    this.sessionReader = opts.sessionReader;
    this.configuredModel = opts.model;
    this.agentPreset = opts.agentPreset;
    this.reasoningEffort = opts.reasoningEffort;
    this.client = new DshClient(
      opts.host ?? 'http://127.0.0.1:3080',
      opts.fetchImpl,
      opts.webSocketImpl,
    );
  }

  get isRunning(): boolean {
    return this.running;
  }

  getStatusInfo(): AgentStatusInfo {
    const extras: Record<string, string> = { host: this.client.baseUrl };
    if (this.agentPreset) extras.preset = this.agentPreset;
    if (this.reasoningEffort) extras.reasoning = this.reasoningEffort;
    return {
      kind: this.kind,
      model: this.configuredModel ?? 'DSH',
      extras,
    };
  }

  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    if (this.running) {
      throw new Error('DshRunner is already running');
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    this.running = true;

    let sessionId = opts.sessionId;
    let terminalEmitted = false;
    try {
      // CC-03: session.create 必须包进同一 try/finally，否则创建失败（服务端不可达/报错）
      // 会在进入旧 try 之前抛异常，finally 不执行 → running 恒 true、activeAbort 残留。
      if (!sessionId) {
        const created = await this.client.createSession({
          cwd: opts.cwd,
          ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}),
        });
        sessionId = created.sessionId;
      }
      this.activeSessionId = sessionId;

      // Startup abort：createSession 挂起期间 stop() 已 abort（此时 sessionId 尚
      // 未知，stop() 无法 cancel）。createSession 返回后立即检查——已 abort 则
      // cancel 这个刚建的 session 并中断，不让启动流程继续（selectModel/prompt）。
      // 必须 yield interrupted result（不能裸 return）：调用方依赖 result 收尾
      // run 卡，否则 for-await 自然结束后无终态、卡片停留「运行中」。
      if (abort.signal.aborted) {
        try {
          await this.client.unary('session.cancel', { sessionId });
        } catch {
          /* 取消失败仅告警，session 已 abort 无需继续 */
        }
        getLogger().info(`[dsh] run aborted during startup, cancelled session ${sessionId}`);
        terminalEmitted = true;
        yield {
          type: 'result',
          subtype: 'interrupted',
          session_id: sessionId,
          errorMessage: 'run stopped',
        };
        return;
      }

      // 模型/推理强度对齐（§4.3）：会话首次 run 时 selectModel 一次
      // （该调用同时写服务端全局默认，故不重复写）；同一 session 后续 run
      // 跳过。失败仅告警不阻断 run（模型校验由 DSH 负责）。
      if (this.configuredModel && !this.alignedSessions.has(sessionId)) {
        try {
          await this.client.selectModel({
            sessionId,
            provider: DSH_MODEL_PROVIDER,
            model: this.configuredModel,
            ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
          });
          this.alignedSessions.add(sessionId);
        } catch (err) {
          getLogger().warn(
            `[dsh] selectModel failed for session ${sessionId} (run continues): ${(err as Error).message}`,
          );
        }
      }

      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        cwd: opts.cwd,
        model: this.configuredModel ?? 'DSH',
      };

      try {
        // Snapshot the pre-prompt high-water mark before mutating the session.
        // DSH session.history returns the whole session, so starting from seq 0
        // would replay the first completed turn on every follow-up prompt.
        const prePromptSeq = await this.client.latestEventSeq(sessionId);

        await this.client.unary('session.prompt', {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: message }],
        });

        const translator = new DshTranslator();
        try {
          for await (const item of this.client.sessionEvents(
            sessionId,
            opts.cwd,
            abort.signal,
            prePromptSeq,
          )) {
            if (abort.signal.aborted) break;

            if (item.kind === 'approval') {
              getLogger().warn(
                `[dsh] approval requested approvalId=${item.approvalId} tool=${item.toolName} — resolve in DSH Web UI`,
              );
              yield {
                type: 'assistant',
                message: {
                  content: [
                    {
                      type: 'text',
                      text: `⚠️ 需要授权（${item.toolName}）：请在 DSH Web UI 处理 ${this.client.baseUrl}`,
                    },
                  ],
                },
              };
              continue;
            }

            for (const ev of translator.eventToAgentEvents(item.event, sessionId)) {
              yield ev;
              if (ev.type === 'result') {
                terminalEmitted = true;
                return;
              }
            }
          }
        } catch (err) {
          if (abort.signal.aborted) throw err;
          getLogger().error(`[dsh] run consume error: ${(err as Error).message}`);
          yield {
            type: 'result',
            subtype: 'error',
            session_id: sessionId,
            errorMessage: `DSH stream error: ${(err as Error).message}`,
          };
          terminalEmitted = true;
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          yield {
            type: 'result',
            subtype: 'error',
            session_id: sessionId,
            errorMessage: `DSH run failed: ${(err as Error).message}`,
          };
          terminalEmitted = true;
        }
      }
    } catch (err) {
      // CC-03: createSession 等启动期失败也产出 error result（而非抛异常），
      // 由本 catch 统一转 error result；state 清理在 finally。
      if (!abort.signal.aborted) {
        yield {
          type: 'result',
          subtype: 'error',
          session_id: sessionId ?? '',
          errorMessage: `DSH run failed: ${(err as Error).message}`,
        };
        terminalEmitted = true;
      }
    } finally {
      this.running = false;
      this.activeSessionId = null;
      this.activeAbort = null;
    }

    if (!terminalEmitted) {
      yield {
        type: 'result',
        subtype: abort.signal.aborted ? 'interrupted' : 'error',
        session_id: sessionId ?? '',
        errorMessage: abort.signal.aborted ? 'run stopped' : 'turn ended without a terminal event',
      };
    }
  }

  async stop(_opts?: { immediate?: boolean }): Promise<void> {
    const sessionId = this.activeSessionId;
    const abort = this.activeAbort;
    if (abort && !abort.signal.aborted) abort.abort();
    if (sessionId) {
      try {
        await this.client.unary('session.cancel', { sessionId });
        getLogger().info(`[dsh] cancelled session ${sessionId}`);
      } catch (err) {
        getLogger().warn(`[dsh] session.cancel failed: ${(err as Error).message}`);
      }
    }
  }

  killOrphan(): void {
    // No local subprocess for DSH — nothing to reap.
  }

  registerExitHandlers(): void {
    // No local subprocess for DSH — nothing to register.
  }

  unregisterExitHandlers(): void {
    // No-op (see registerExitHandlers).
  }
}
