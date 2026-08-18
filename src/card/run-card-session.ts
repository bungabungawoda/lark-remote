import { CardSession, type CardChannel } from './card-session.js';
import type { AgentEvent } from '../runner/index.js';
import {
  createInitialRunState,
  finishRun,
  reduceRunState,
  type FinishMeta,
  type RunState,
  type RunTerminal,
} from './run-state.js';
import { renderRunCard, type RunCardRenderOptions } from './run-renderer.js';

export type { CardChannel as RunCardChannel };

export class RunCardSession extends CardSession<RunState, RunCardRenderOptions> {
  constructor(opts: {
    connector: CardChannel;
    chatId: string;
    replyTo?: string;
    runId: string;
    renderOptions?: RunCardRenderOptions;
    startTimeoutMs?: number;
    settleTimeoutMs?: number;
    /** push 合批窗口，默认 100ms（0 = 禁用合批，每事件立即 flush）。 */
    coalesceMs?: number;
  }) {
    super(createInitialRunState(opts.runId), {
      connector: opts.connector,
      chatId: opts.chatId,
      replyTo: opts.replyTo,
      renderOptions: opts.renderOptions,
      startTimeoutMs: opts.startTimeoutMs,
      settleTimeoutMs: opts.settleTimeoutMs,
      coalesceMs: opts.coalesceMs,
    });
  }

  protected get logPrefix(): string {
    return '[card]';
  }

  protected get errorPrefix(): string {
    return 'card';
  }

  protected renderCard(state: RunState, options: RunCardRenderOptions): object {
    return renderRunCard(state, options);
  }

  protected hasOwnBudgetProtection(): boolean {
    // renderRunCard has 3-tier degraded/extreme fallback budget protection
    // that guarantees the returned card is <= 28KB, so the base-class
    // enforceCardBudget stringify pass is redundant for run cards.
    return true;
  }

  protected isFlushableState(): boolean {
    // finish() 已转终态（done/error/interrupted/idle_timeout）时不再 patch；
    // 'finalizing' 是非终态，in-flight/延迟 flush 仍可渲染累积事件。
    return this.state.terminal === 'running' || this.state.terminal === 'finalizing';
  }

  async push(event: AgentEvent): Promise<void> {
    // state 每事件立即 reduce（始终最新），但 updateCard 延迟到合批窗口末尾。
    // 窗口内多次 push 复用同一 flushTimer，只 render + controller.update 一次
    // （P1-3）。push 立即 resolve（fire-and-forget render）—— bridge 串行
    // await 不被 render 阻塞，循环快速灌入事件，多个事件落进同一窗口被合并。
    //
    // 首 push 也走窗口（无 immediate-first-flush）：start() 已发初始卡（streaming
    // footer），用户立即看到活动；首 text delta 落进 100ms 窗口后人眼无感。
    this.state = reduceRunState(this.state, event);
    if (this.coalesceMs <= 0) {
      // 合批禁用：立即同步 flush，保留 push 后立即生效的既有契约（错误处理
      // 测试依赖此）。await 确保 flush 完成（含 fallback）后再 resolve。
      await this.flush();
      return;
    }
    this.scheduleFlush();
  }

  async finish(
    terminal: Exclude<RunTerminal, 'running' | 'finalizing'>,
    meta: FinishMeta = {},
  ): Promise<void> {
    // 终态必须即时显示（spec）：取消合批窗口，不等延迟 flush 调度。
    this.cancelPendingFlush();
    // 若有 in-flight flush 正在 await updateCard，必须等它完成后再发终态 patch。
    // 否则两条并发 controller.update 无 FIFO 保证，in-flight 的 pre-terminal
    // patch 可能在终态 patch 之后 resolve → 用户看到"思考中"终帧（P2）。
    // await 保证顺序：pre-terminal 先落地 → terminal 后落地 → terminal 胜出。
    if (this.flushP) await this.flushP;
    this.state = finishRun(this.state, terminal, meta);
    await this.updateCard();
    this.release();
  }
}
