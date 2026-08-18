import type { CardStreamController, CardStreamProducer } from '@larksuite/channel';
import { getLogger } from '../logger/index.js';
import { enforceCardBudget } from './card-budget.js';

/**
 * Unified channel interface for streaming card sessions.
 */
export interface CardChannel {
  streamCard(
    chatId: string,
    initial: object,
    producer: CardStreamProducer,
    opts?: { replyTo?: string },
  ): Promise<string>;
  updateCard(messageId: string, card: object): Promise<void>;
}

export type StreamSettleResult = 'streamed' | 'updated' | 'unsent';

/**
 * Base class for single-card streaming sessions (RunCardSession, BashCardSession).
 * Provides the shared lifecycle: start → (push/update) → finish → settle.
 *
 * Subclasses must implement `renderCard()` to produce the card JSON for their
 * specific state type, and `logPrefix` / `errorPrefix` for differentiated
 * log and error messages.
 */
export abstract class CardSession<S, RO = unknown> {
  protected readonly connector: CardChannel;
  protected readonly chatId: string;
  protected readonly replyTo?: string;
  protected readonly renderOptions: RO;
  protected readonly startTimeoutMs: number;
  protected readonly settleTimeoutMs: number;
  protected state: S;
  protected controller?: CardStreamController;
  protected messageId?: string;
  protected streamOutcome?: Promise<{ ok: true } | { ok: false; error: unknown }>;
  private releaseProducer!: () => void;
  private readonly producerReleased: Promise<void>;
  private resolveController!: () => void;
  private rejectController!: (error: unknown) => void;
  private readonly controllerReady: Promise<void>;
  private released = false;

  /** Log prefix for differentiated messages (e.g. '[card]' vs '[bash-card]'). */
  protected abstract get logPrefix(): string;

  /** Prefix for timeout error messages (e.g. 'card' vs 'bash card'). */
  protected abstract get errorPrefix(): string;

  /** Render the current state into a card JSON object. */
  protected abstract renderCard(state: S, options: RO): object;

  constructor(
    initialState: S,
    opts: {
      connector: CardChannel;
      chatId: string;
      replyTo?: string;
      renderOptions?: RO;
      startTimeoutMs?: number;
      settleTimeoutMs?: number;
      /** update/push 合批窗口，默认 100ms（0 = 禁用合批，每事件立即 flush）。 */
      coalesceMs?: number;
    },
  ) {
    this.state = initialState;
    this.connector = opts.connector;
    this.chatId = opts.chatId;
    this.replyTo = opts.replyTo;
    this.renderOptions = opts.renderOptions ?? ({} as RO);
    this.startTimeoutMs = opts.startTimeoutMs ?? 5_000;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 5_000;
    this.producerReleased = new Promise<void>((resolve) => {
      this.releaseProducer = resolve;
    });
    this.controllerReady = new Promise<void>((resolve, reject) => {
      this.resolveController = resolve;
      this.rejectController = reject;
    });
    this.coalesceMs = opts.coalesceMs ?? 100;
  }

  /**
   * 调度一次延迟 flush。已有 pending 调度则复用（合批核心）；否则起一个
   * coalesceMs 定时器。flushInFlight 期间不再起 timer（避免重入叠加），但置
   * pendingReschedule 以便 in-flight flush 完成后重新调度——否则 in-flight 期间
   * 到达的 push/update 会停留为 stale 中间帧（P2-1）。
   */
  protected scheduleFlush(): void {
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
   * 执行一次 render + updateCard。合批窗口到期或 finish 即时 flush 时调用。
   * flushInFlight 防止 timer 回调与 finish 的即时 flush 重入。
   *
   * 终态守卫：若 finish() 已把 state 转为终态，跳过本次 patch——避免 in-flight flush
   * 用 pre-terminal state 覆盖 finish 已发的终态卡。finish() 自身会 await 任何
   * in-flight flush 保证顺序，此守卫是双保险。
   */
  protected async flush(): Promise<void> {
    if (this.flushInFlight) return;
    if (!this.isFlushableState()) return;
    this.flushInFlight = true;
    const flushPromise = (async () => {
      try {
        await this.updateCard();
      } finally {
        this.flushInFlight = false;
        // flushInFlight 守卫保证同一时刻只有一个 in-flight flush，故可无条件清空。
        this.flushP = undefined;
        // P2-1：in-flight 期间若有 push/update 到达（pendingReschedule），重新调度一次
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
   * Whether the current state still permits a flush (i.e. is not yet terminal).
   * Subclasses define their terminal set. Run treats 'finalizing' as non-terminal.
   */
  protected abstract isFlushableState(): boolean;

  /**
   * 取消待 flush 的合批调度（finish/settle 前清理，避免延迟 update 与终态
   * 渲染竞争）。返回是否有被取消的 pending 调度。同时清掉 pendingReschedule，
   * 防止 in-flight flush 的 finally 在 finish await 之后又起 dangling timer
   * （finish 自身会渲染含累积事件的终态卡，无需 follow-up）。
   */
  protected cancelPendingFlush(): boolean {
    this.pendingReschedule = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      return true;
    }
    return false;
  }

  get currentState(): S {
    return this.state;
  }

  /** The messageId of the streaming card, available after `start()` resolves. */
  get cardMessageId(): string | undefined {
    return this.messageId;
  }

  /**
   * P1-3 合批窗口（ms）。连续事件各触发一次全卡 render + patch 是流式 CPU 主要
   * 来源；窗口内多个事件复用同一次延迟 flush。窗口大小可通过 constructor 覆盖
   * （测试用小窗口/0 禁用）。run/bash 子类共用的 flush 骨架（scheduleFlush/flush/
   * cancelPendingFlush/settle）下沉到基类。
   */
  protected readonly coalesceMs: number;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushInFlight = false; /** P2-1：in-flight flush 期间到达的 push/update 标记。scheduleFlush 在
   *  flushInFlight 时早退不调度新 timer，但事件已 reduce 进 state；若无此标志，
   *  in-flight flush 完成后该事件无 follow-up render，停留为 stale 中间帧。
   *  finally 检查此标志后重新 scheduleFlush，保证 in-flight 期间累积的事件最终被渲染。 */
  private pendingReschedule = false;
  /** 当前 in-flight flush 的 promise（若 flush 正在 await updateCard）。
   *  finish() 在终态 patch 前 await 它，保证 in-flight 的 pre-terminal patch 先落地、
   *  terminal patch 后落地——否则两条 controller.update 并发无 FIFO，
   *  pre-terminal 可能在 terminal 之后 resolve 留下"思考中"终帧（P2）。 */
  protected flushP: Promise<void> | undefined;

  async start(): Promise<void> {
    if (this.streamOutcome) {
      // 二次调用也套 timeout 保护：若 controllerReady 永不 settle（首次超时失败），
      // 不能永久挂起。复用同样的 startTimeoutMs 超时。streamOutcome 已存在，
      // 不重复创建 stream。
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${this.errorPrefix} stream start timeout`)),
          this.startTimeoutMs,
        );
      });
      try {
        await Promise.race([this.controllerReady, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return;
    }
    // NOTE: the two renderCard calls below are NOT redundant. The streamCard
    // `initial` payload is evaluated EAGERLY (at start time, before any event
    // has arrived), while the producer's `controller.update` runs LAZILY after
    // the controller is ready — by which time events pushed before the
    // producer ran (see test_anchor_events_before_controller_ready_...) have
    // already updated `this.state`. Reusing the initial card here would drop
    // those early events. The P3-7 "reuse first render" optimization was
    // rejected for this reason (premise "two renders with identical input"
    // does not hold).
    const stream = this.connector.streamCard(
      this.chatId,
      this.safeRenderCard(),
      async (controller) => {
        this.controller = controller;
        this.messageId = controller.messageId;
        try {
          await controller.update(this.safeRenderCard());
        } catch (error) {
          getLogger().warn(`${this.logPrefix} initial controller update failed:`, error);
        }
        this.resolveController();
        await this.producerReleased;
      },
      { replyTo: this.replyTo },
    );
    this.streamOutcome = stream.then(
      () => ({ ok: true as const }),
      (error) => {
        if (!this.controller) this.rejectController(error);
        return { ok: false as const, error };
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${this.errorPrefix} stream start timeout`)),
        this.startTimeoutMs,
      );
    });
    try {
      await Promise.race([this.controllerReady, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async settle(): Promise<StreamSettleResult> {
    this.release();
    if (!this.streamOutcome) return 'unsent';
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ ok: false; error: Error }>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: new Error(`${this.errorPrefix} stream settle timeout`) }),
        this.settleTimeoutMs,
      );
    });
    const outcome = await Promise.race([this.streamOutcome, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome.ok) return 'streamed';
    getLogger().warn(`${this.logPrefix} stream did not complete cleanly:`, outcome.error);
    if (!this.messageId) return 'unsent';
    try {
      await this.connector.updateCard(this.messageId, this.safeRenderCard());
      return 'updated';
    } catch (error) {
      getLogger().error(`${this.logPrefix} failed to finalize original card:`, error);
      return 'unsent';
    }
  }

  /**
   * Whether renderCard() already enforces a size budget (so updateCard can
   * skip enforceCardBudget). Subclasses whose renderer has its own
   * stringify-level budget protection (e.g. RunCardSession via degraded/
   * extreme fallback) should override this to return true.
   */
  protected hasOwnBudgetProtection(): boolean {
    return false;
  }

  /**
   * Render the current card and apply stringify-level budget enforcement unless
   * the subclass renderer has its own budget protection. Centralizes the budget
   * decision so start()/updateCard()/settle() stay symmetric — previously only
   * updateCard() guarded, while start() producer and settle() fallback sent bare
   * renderCard output (risking >28KB for BashCardSession, which has no own
   * stringify-level safety net).
   */
  protected safeRenderCard(): object {
    const card = this.renderCard(this.state, this.renderOptions);
    return this.hasOwnBudgetProtection() ? card : enforceCardBudget(card).card;
  }

  /**
   * Push an update to the card. Tries controller.update first, falls back to
   * connector.updateCard if the controller is unavailable or fails.
   */
  protected async updateCard(): Promise<void> {
    const safeCard = this.safeRenderCard();

    if (this.controller) {
      try {
        await this.controller.update(safeCard);
        return;
      } catch (error) {
        getLogger().warn(
          `${this.logPrefix} controller update failed; finalization will retry:`,
          error,
        );
      }
    }
    // Fallback: try updateCard when controller is unavailable or update failed
    if (this.messageId) {
      try {
        await this.connector.updateCard(this.messageId, safeCard);
      } catch (error) {
        getLogger().warn(`${this.logPrefix} updateCard fallback failed:`, error);
      }
    }
  }

  protected release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseProducer();
  }
}
