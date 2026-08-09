import { CardSession, type CardChannel, type StreamSettleResult } from './card-session.js';
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
  /**
   * P1-3 push 合批窗口（ms）。连续 text delta 各触发一次全卡 render + patch 是
   * 流式 CPU 主要来源（§P1-3）。窗口内多个事件复用同一次
   * 延迟 flush，只 render + controller.update 一次。100ms 内人眼无感，且 text
   * 流式 patch 次数 -80%。窗口大小可通过 constructor 覆盖（测试用小窗口）。
   */
  private readonly coalesceMs: number;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushInFlight = false;
  /**
   * P2-1：in-flight flush 期间到达的 push 标记。scheduleFlush 在 flushInFlight
   * 时早退不调度新 timer，但事件已 reduce 进 state；若无此标志，in-flight flush
   * 完成后该事件无 follow-up render，停留为 stale 中间帧（生产 SDK 的
   * controller.update 经 throttle + setTimeout 异步 resolve，故 flush 与
   * 下一个 push 交叠是真实场景）。finally 检查此标志后重新 scheduleFlush，
   * 保证 in-flight 期间累积的事件最终被渲染。
   */
  private pendingReschedule = false;
  /**
   * 当前 in-flight flush 的 promise（若 flush 正在 await updateCard）。
   * finish() 在终态 patch 前 await 它，保证 in-flight 的 pre-terminal patch
   * 先落地、terminal patch 后落地——否则两条 controller.update 并发无 FIFO，
   * pre-terminal 可能在 terminal 之后 resolve 留下"思考中"终帧（P2）。
   */
  private flushP: Promise<void> | undefined;

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
    });
    this.coalesceMs = opts.coalesceMs ?? 100;
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

  /**
   * 调度一次延迟 flush。已有 pending 调度则复用（合批核心）；否则起一个
   * coalesceMs 定时器。flushInFlight 期间不再起 timer（避免重入叠加），但置
   * pendingReschedule 以便 in-flight flush 完成后重新调度——否则 in-flight 期间
   * 到达的 push 会停留为 stale 中间帧（P2-1）。
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    if (this.flushInFlight) {
      this.pendingReschedule = true;
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.coalesceMs);
  }

  /**
   * 执行一次 render + updateCard。合批窗口到期或 finish 立即 flush 时调用。
   * flushInFlight 防止 timer 回调与 finish 的即时 flush 重入。
   *
   * 终态守卫：若 finish() 已把 state 转为终态（done/error/interrupted/idle_timeout），
   * 跳过本次 patch——避免 in-flight flush 用 pre-terminal state 覆盖 finish 已发的
   * 终态卡。finish() 自身会 await 任何 in-flight flush 保证顺序，此守卫是双保险。
   */
  private async flush(): Promise<void> {
    if (this.flushInFlight) return;
    // finish() 已转终态：in-flight/延迟 flush 不再用旧 state patch
    if (this.state.terminal !== 'running' && this.state.terminal !== 'finalizing') {
      return;
    }
    this.flushInFlight = true;
    const flushPromise = (async () => {
      try {
        await this.updateCard();
      } finally {
        this.flushInFlight = false;
        // flushInFlight 守卫保证同一时刻只有一个 in-flight flush，故可无条件清空。
        this.flushP = undefined;
        // P2-1：in-flight 期间若有 push 到达（pendingReschedule），重新调度一次
        // flush 渲染累积事件，避免 stale 中间帧。终态守卫在 flush() 入口已拦截，
        // 故 finish 后不会误触发。
        if (this.pendingReschedule) {
          this.pendingReschedule = false;
          this.scheduleFlush();
        }
      }
    })();
    this.flushP = flushPromise;
    return flushPromise;
  }

  /**
   * 取消待 flush 的合批调度（finish/settle 前清理，避免延迟 update 与终态
   * 渲染竞争）。返回是否有被取消的 pending 调度。同时清掉 pendingReschedule，
   * 防止 in-flight flush 的 finally 在 finish await 之后又起 dangling timer
   * （finish 自身会渲染含累积事件的终态卡，无需 follow-up）。
   */
  private cancelPendingFlush(): boolean {
    this.pendingReschedule = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      return true;
    }
    return false;
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

  /**
   * settle 前兜底取消合批调度。bridge 正常流程 finish→settle，finish 已 cancel；
   * 但若未来有直调 settle（未经 finish）的路径，避免 dangling timer 在 release
   * 后触发 void flush() 去更新已释放的 stream（harmless 但无谓）。
   */
  override async settle(): Promise<StreamSettleResult> {
    this.cancelPendingFlush();
    return super.settle();
  }
}
