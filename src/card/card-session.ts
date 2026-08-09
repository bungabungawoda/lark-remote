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
  }

  get currentState(): S {
    return this.state;
  }

  /** The messageId of the streaming card, available after `start()` resolves. */
  get cardMessageId(): string | undefined {
    return this.messageId;
  }

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
