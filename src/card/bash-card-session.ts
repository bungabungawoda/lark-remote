import { CardSession, type CardChannel } from './card-session.js';
import { renderBashCard, type BashState, type BashRenderOptions } from './bash-renderer.js';
import { keepTail } from '../common/truncate.js';

/**
 * Store-time 输出上限（字符，P1-3 层①）。§P1-3 建议「store-time 截断，
 * 保留尾部，上限如 24~64KB」——取区间下界 24_000 字符（字符上限 ×4 字节最坏
 * ~96KB/字段）。渲染层本就只展示尾部（bash-renderer 截断到 12KB 字节），store 截断
 * 不影响显示内容，只保证内存有界：!yes / !cat 大文件不再把全部输出驻留在 session
 * state 与 bridge 局部变量。
 */
export const BASH_OUTPUT_STORE_CAP = 24_000;

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
        coalesceMs: opts.coalesceMs,
      },
    );
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

  protected isFlushableState(): boolean {
    // finish() 已把 state 转终态后，in-flight/延迟 flush 不再用旧 state patch。
    return this.state.terminal === 'running';
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
