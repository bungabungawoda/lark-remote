import { CardSession, type CardChannel, type StreamSettleResult } from './card-session.js';
import { renderBashCard, type BashState, type BashRenderOptions } from './bash-renderer.js';

/**
 * Store-time 输出上限（字符，P1-3 层①）。§P1-3 建议「store-time 截断，
 * 保留尾部，上限如 24~64KB」——取区间下界 24_000 字符（字符上限 ×4 字节最坏
 * ~96KB/字段）。渲染层本就只展示尾部（bash-renderer 截断到 12KB 字节），store 截断
 * 不影响显示内容，只保证内存有界：!yes / !cat 大文件不再把全部输出驻留在 session
 * state 与 bridge 局部变量。
 */
export const BASH_OUTPUT_STORE_CAP = 24_000;

/** 字符级 tail 保留（与 run-state.keepLatest 的 slice(-maxChars) 语义一致）。 */
function keepTail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

/**
 * Store-time 截断入口（P1-3 层①/层④共用）。bridge 本地 output/stderr 与 session
 * state 都走它，保证任意路径驻留的字符串 ≤ BASH_OUTPUT_STORE_CAP 字符。
 * 调用方传入的 value 通常已 ≤ CAP（增量场景 output 恒 ≤ CAP，+chunk 后 ≤ CAP+chunk），
 * slice(-CAP) 成本 O(CAP+chunk)，不会把 O(n²) 截断问题带回桥接循环。
 */
export function capBashOutput(value: string): string {
  return keepTail(value, BASH_OUTPUT_STORE_CAP);
}

/**
 * Streaming card session for `!` bash commands — the bash analogue of
 * RunCardSession. Holds a single BashState, renders renderBashCard, and
 * patches ONE card via connector.streamCard across the run's lifetime
 * (initial running → output updates → terminal), instead of sending many
 * independent cards.
 */
export class BashCardSession extends CardSession<BashState, BashRenderOptions> {
  /**
   * P1-3 层③：push 合批窗口（ms），与 RunCardSession 同语义。连续 update 各触发
   * 一次全卡 render + patch 是 PATCH 风暴主源；窗口内多个事件复用同一次延迟 flush。
   * 窗口大小可通过 constructor 覆盖（测试用小窗口/0 禁用）。
   */
  private readonly coalesceMs: number;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushInFlight = false;
  /** in-flight flush 期间到达的 update 标记：flush 完成后需重新调度（防 stale 帧）。 */
  private pendingReschedule = false;
  /** 当前 in-flight flush 的 promise：finish 在终态 patch 前 await 它保证顺序。 */
  private flushP: Promise<void> | undefined;

  constructor(opts: {
    connector: CardChannel;
    chatId: string;
    replyTo?: string;
    runId: string;
    command: string;
    renderOptions?: BashRenderOptions;
    startTimeoutMs?: number;
    settleTimeoutMs?: number;
    /** update 合批窗口，默认 100ms（0 = 禁用合批，每 update 立即 flush）。 */
    coalesceMs?: number;
  }) {
    super(
      {
        runId: opts.runId,
        terminal: 'running',
        output: '',
        stderr: '',
        exitCode: null,
        command: opts.command,
      },
      {
        connector: opts.connector,
        chatId: opts.chatId,
        replyTo: opts.replyTo,
        renderOptions: opts.renderOptions,
        startTimeoutMs: opts.startTimeoutMs,
        settleTimeoutMs: opts.settleTimeoutMs,
      },
    );
    this.coalesceMs = opts.coalesceMs ?? 100;
  }

  protected get logPrefix(): string {
    return '[bash-card]';
  }

  protected get errorPrefix(): string {
    return 'bash card';
  }

  protected renderCard(state: BashState, options: BashRenderOptions): object {
    return renderBashCard(state, options);
  }

  protected hasOwnBudgetProtection(): boolean {
    // renderBashCard 自带 stringify 级 degraded/extreme fallback 预算保护
    // （与 renderRunCard 对称），保证返回卡 ≤28KB 且保留 command/exitCode。
    // enforceCardBudget 是会话事件面板专用的静态裁剪层，对 bash 卡的普通
    // markdownDiv output 是 misfit（超限时极端降级丢 command/exitCode），bash
    // 卡应跳过它，靠自身 renderer 保护。
    return true;
  }

  /** Patch the card with updated bash state (e.g. new stdout/stderr). */
  async update(patch: Partial<BashState>): Promise<void> {
    this.state = this.applyCap(patch);
    if (this.coalesceMs <= 0) {
      await this.flush();
      return;
    }
    this.scheduleFlush();
  }

  /** Transition to a terminal state and patch the card. */
  async finish(
    terminal: Exclude<BashState['terminal'], 'running'>,
    meta: { exitCode?: number | null; stderr?: string; output?: string } = {},
  ): Promise<void> {
    this.cancelPendingFlush();
    // 若有 in-flight flush 正在 await updateCard，必须等它完成后再发终态 patch，
    // 保证顺序（pre-terminal 先落地 → terminal 后落地 → terminal 胜出）。
    if (this.flushP) await this.flushP;
    this.state = {
      ...this.state,
      terminal,
      ...(meta.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
      ...(meta.stderr !== undefined ? { stderr: capBashOutput(meta.stderr) } : {}),
      ...(meta.output !== undefined ? { output: capBashOutput(meta.output) } : {}),
    };
    await this.updateCard();
    this.release();
  }

  /**
   * 调度一次延迟 flush：已有 pending 调度则复用（合批核心）；flushInFlight 期间
   * 不再起 timer（防重入叠加），但置 pendingReschedule 让 in-flight 完成后补渲染。
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

  /** 执行一次 render + updateCard（合批窗口到期或 finish 即时 flush 时调用）。 */
  private async flush(): Promise<void> {
    if (this.flushInFlight) return;
    // 终态守卫：finish 已把 state 转终态后，in-flight/延迟 flush 不再用旧 state patch
    if (this.state.terminal !== 'running') return;
    this.flushInFlight = true;
    const flushPromise = (async () => {
      try {
        await this.updateCard();
      } finally {
        this.flushInFlight = false;
        this.flushP = undefined;
        // in-flight 期间若有 update 到达（pendingReschedule），重新调度一次渲染
        if (this.pendingReschedule) {
          this.pendingReschedule = false;
          this.scheduleFlush();
        }
      }
    })();
    this.flushP = flushPromise;
    return flushPromise;
  }

  /** 取消待 flush 的合批调度（finish/settle 前清理，避免延迟 update 与终态竞争）。 */
  private cancelPendingFlush(): boolean {
    this.pendingReschedule = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      return true;
    }
    return false;
  }

  /** settle 前兜底取消合批调度，避免 release 后 dangling timer 更新已释放的 stream。 */
  override async settle(): Promise<StreamSettleResult> {
    this.cancelPendingFlush();
    return super.settle();
  }

  /**
   * 合并 patch 并对 output/stderr 做 store-time 截断（P1-3 层①）。
   * 截断发生在入口（store 时），渲染层无需再为大 state 付代价。
   */
  private applyCap(patch: Partial<BashState>): BashState {
    return {
      ...this.state,
      ...patch,
      ...(patch.output !== undefined ? { output: capBashOutput(patch.output) } : {}),
      ...(patch.stderr !== undefined ? { stderr: capBashOutput(patch.stderr) } : {}),
    };
  }
}
