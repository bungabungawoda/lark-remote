import { randomUUID } from 'node:crypto';
import type { SessionStore } from '../session/index.js';
import { BashProcessRunner, type BashRunner } from '../runner/index.js';
import { BashCardSession, capBashOutput } from '../card/bash-card-session.js';
import { renderBashCard } from '../card/bash-renderer.js';
import type { RunTerminal } from '../card/run-state.js';
import { getLogger } from '../logger/index.js';
import { errorMessage } from './final-usage.js';
import type { BridgeChannel, CommandContext, CommandResult } from './index.js';

/**
 * Active `!` bash run 的登记项。键是 runId（NOT cwd）：bash 绕过串行队列，
 * 可与同 cwd 的 agent run / 其他 bash run 并行，因此不进 activeRuns（那张表
 * 以 cwd 为键，混用会互相覆盖、/stop 停错对象）。登记是为了让 /stop 能经由
 * interruptCurrentRun 够到本来是局部变量的 BashRunner 实例。
 */
interface ActiveBashRun {
  bashRunner: BashRunner;
  cardSession: BashCardSession;
  userId: string;
  chatId: string;
  cwd: string;
  command: string;
}

/**
 * `!` bash 命令执行（bridge 结构治理第 3 刀）：建卡、事件流消费、终态装配
 * 与 runId 登记表。
 *
 * 红线（§9.6 / §9.18）：
 * - bash **绝不 re-chain 到 QueueManager**——enqueue 队列 promise 未 settle 时
 *   re-chain 会自等待死锁（外层 promise 等内层、内层排在外层后面）。
 * - bash 用独立 runId 空间、独立登记表，不进 activeRuns，/stop 不会误杀。
 * - 中断卡的 `cardSession.finish('interrupted')` 不传 exitCode（保持 null），
 *   bash-renderer 的「已手动终止」文案依赖它。
 *
 * 依赖显式注入（与 ApprovalActions / CompactLifecycle / JobWatchLifecycle
 * 同一模式）。
 */
export interface BashRunLifecycleDeps {
  connector: BridgeChannel;
  sessionStore: SessionStore;
  resolveCwd(userId: string): string | undefined;
  sendResult(result: CommandResult, ctx: CommandContext): Promise<boolean>;
  finishTurnReactions(ctx: CommandContext, emoji: string): void;
}

export class BashRunLifecycle {
  private readonly deps: BashRunLifecycleDeps;

  /** Active `!` bash runs, keyed by runId (NOT cwd)。见 {@link ActiveBashRun}。 */
  private activeBashRuns = new Map<string, ActiveBashRun>();

  constructor(deps: BashRunLifecycleDeps) {
    this.deps = deps;
  }

  /**
   * Execute a bash command and stream output to a card.
   * `!` commands bypass the serial queue entirely (see body comment + §9.6):
   * bash runs in parallel with same-workspace agent runs, tracked in
   * `activeBashRuns` separately from `activeRuns`.
   */
  async executeBash(command: string, ctx: CommandContext): Promise<void> {
    const cwd = this.deps.resolveCwd(ctx.userId);

    getLogger().info(
      `[lark-remote] executeBash start userId=${ctx.userId} sessionCwd=${this.deps.sessionStore.get(ctx.userId)?.cwd} command="${command.slice(0, 30)}..."`,
    );

    if (!cwd) {
      getLogger().info(`[lark-remote] executeBash no cwd, sending error`);
      await this.deps.sendResult(
        { text: '请先使用 /cd <path> 设置工作目录，或保存一个 workspace (/ws save <name>)' },
        ctx,
      );
      return;
    }

    getLogger().info(`[lark-remote] executeBash proceeding cwd=${cwd}`);

    // `!` commands bypass the serial queue entirely (design.md §9.6):
    // index.ts dispatches `!` to router.handle → executeBash directly, NOT via
    // bridge.enqueue. bash runs in parallel with same-workspace claude runs.
    // bash runs are tracked in `activeBashRuns` (keyed by runId), separate from
    // claude's `activeRuns` (keyed by cwd) — they must not collide or `/stop`
    // would kill the wrong task. Do NOT re-chain onto the serial queue
    // (QueueManager) here: that would block on the still-pending outer promise
    // and deadlock self-wait.
    await this.executeBashInternal(command, ctx, cwd);
  }

  /**
   * Internal execution of bash command (called directly from executeBash,
   * bypassing the serial queue — see executeBash).
   */
  private async executeBashInternal(
    command: string,
    ctx: CommandContext,
    cwd: string,
  ): Promise<void> {
    getLogger().debug(
      `[lark-remote] executeBashInternal userId=${ctx.userId} chatId=${ctx.chatId} cwd=${cwd} command="${command.slice(0, 50)}..."`,
    );

    // Note: We don't check activeRuns here because bash bypasses the serial
    // queue and runs in parallel with same-workspace agent runs (§9.6). The
    // activeRuns check in forwardToClaude is for a different purpose (detecting
    // concurrent agent runs that would corrupt session state). Bash commands
    // don't have that issue.

    const runId = randomUUID();
    const bashRunner: BashRunner = new BashProcessRunner();

    // Single streaming card across the whole run (initial → output patches →
    // terminal), instead of sending many independent cards. BashCardSession is
    // the bash analogue of RunCardSession.
    const cardSession = new BashCardSession({
      connector: this.deps.connector,
      chatId: ctx.chatId,
      replyTo: ctx.messageId,
      runId,
      command,
      renderOptions: {},
    });

    // Track this bash run independently from claude's `activeRuns`. Bash runs
    // bypass the serial queue and may run in parallel with a claude run in the
    // same cwd, so they must NOT share activeRuns (which is keyed by cwd
    // and would let bash/claude overwrite each other). Keyed by runId so
    // multiple `!` commands can run concurrently. Tracked so /stop can reach
    // the bashRunner (which is otherwise a local) via interruptCurrentRun.
    this.activeBashRuns.set(runId, {
      bashRunner,
      cardSession,
      userId: ctx.userId,
      chatId: ctx.chatId,
      cwd,
      command,
    });

    let output = '';
    let stderr = '';
    let exitCode: number | null = null;

    try {
      getLogger().info(
        `[lark-remote] executeBashInternal about to start stream chatId=${ctx.chatId} messageId=${ctx.messageId}`,
      );
      try {
        await cardSession.start();
        getLogger().info(`[lark-remote] executeBash stream started runId=${runId}`);
      } catch (err) {
        getLogger().warn('[lark-remote] bash card stream unavailable:', err);
      }

      for await (const event of bashRunner.run(command, { cwd })) {
        if (event.type === 'stdout') {
          // 层④：bridge 本地 output 也必须 store-time 截断——仅 session state
          // 有界并不会让 `output +=` 自然有界（「store 有界则本地拼接自然有界」
          // 不成立），!yes 洪峰下本地字符串仍全量驻留。capBashOutput 增量调用
          // O(CAP+chunk)，不会带回 O(n²) 截断成本（output 恒 ≤ CAP，拼接后
          // ≤ CAP+chunk 再 slice 尾部）。
          output = capBashOutput(output + event.content);
          await cardSession.update({ output, stderr });
        } else if (event.type === 'stderr') {
          stderr = capBashOutput(stderr + event.content);
          await cardSession.update({ output, stderr });
        } else if (event.type === 'exit') {
          exitCode = event.exitCode ?? 0;
        }
      }

      await cardSession.finish(exitCode === 0 ? 'done' : 'error', { exitCode, output, stderr });
    } catch (err) {
      getLogger().error(`[lark-remote] bash run error runId=${runId}:`, err);
      // If for-await threw mid-stream the bash child may still be running.
      // Stop it before finalizing the card — otherwise the finally block
      // removes the activeBashRuns entry and /stop can no longer reach it,
      // leaving an orphan process.
      try {
        await bashRunner.stop();
      } catch (stopErr) {
        getLogger().warn(`[lark-remote] bash stop failed:`, stopErr);
      }
      await cardSession.finish('error', {
        exitCode: 1,
        output,
        stderr: stderr + `\n执行错误: ${errorMessage(err)}`,
      });
    } finally {
      const settleResult = await cardSession.settle();
      if (settleResult === 'unsent') {
        // Stream never established a card — send a static terminal card as fallback.
        // Use 2.0 schema to match the streaming card (avoid 2.0→1.x downgrade).
        try {
          await this.deps.connector.sendWithRetry(
            ctx.chatId,
            { card: renderBashCard(cardSession.currentState, {}) },
            { replyTo: ctx.messageId },
          );
        } catch (fallbackErr) {
          getLogger().error(
            `[lark-remote] bash terminal fallback card failed runId=${runId} chatId=${ctx.chatId}:`,
            fallbackErr,
          );
        }
      }
      if (this.activeBashRuns.has(runId)) {
        this.activeBashRuns.delete(runId);
        getLogger().info(`[lark-remote] executeBash done runId=${runId} exitCode=${exitCode}`);
      }

      // Add a Done emoji reaction to the user's original message to signal completion
      this.deps.finishTurnReactions(ctx, 'Done');
    }
  }

  /** Get all active bash runs with their state for /active command. */
  getActiveBashRuns(): Array<{
    runId: string;
    cwd: string;
    userId: string;
    chatId: string;
    terminal: RunTerminal;
    command: string;
  }> {
    const result: Array<{
      runId: string;
      cwd: string;
      userId: string;
      chatId: string;
      terminal: RunTerminal;
      command: string;
    }> = [];

    for (const [runId, bashRun] of this.activeBashRuns) {
      const state = bashRun.cardSession.currentState;
      // Only include non-terminal runs (bash has no finalizing state)
      if (state.terminal === 'running') {
        result.push({
          runId,
          cwd: bashRun.cwd,
          userId: bashRun.userId,
          chatId: bashRun.chatId,
          terminal: state.terminal,
          command: bashRun.command,
        });
      }
    }

    return result;
  }

  /**
   * /stop 的 bash 侧（interruptCurrentRunDetailed 的后半段）。
   *
   * These bypass the serial queue and are tracked separately; stop the per-run
   * BashRunner directly.
   * `/stop`（无 runId、无 cwd）语义是「停掉这个会话的一切」，所以并行跑的
   * `!` 命令也要停——旧实现命中 claude run 就 return，这些 bash 会被漏掉。
   * 带范围的中断（停止卡 runId、queue.immediate 的 cwd）保持旧语义：只有
   * 没有 claude run 命中时才回退到 bash，避免误杀用户并行跑的 `!` 任务。
   *
   * @param claudeTargetCount 本次中断已命中的 claude run 数（0 = 可回退到 bash）
   * @returns 本次实际停掉的 bash run 数
   */
  async stopMatchingBashRuns(
    input: {
      userId: string;
      chatId: string;
      runId?: string;
      cardMessageId?: string;
      cwd?: string;
    },
    claudeTargetCount: number,
  ): Promise<number> {
    const cardScoped = input.runId !== undefined || input.cardMessageId !== undefined;
    const includeBashRuns =
      (input.runId === undefined && input.cardMessageId === undefined && input.cwd === undefined) ||
      claudeTargetCount === 0;
    const bashTargets = includeBashRuns
      ? [...this.activeBashRuns.entries()].filter(([runId, b]) => {
          if (input.cwd !== undefined && b.cwd !== input.cwd) return false;
          if (b.userId !== input.userId || b.chatId !== input.chatId) return false;
          if (input.runId) {
            if (runId === input.runId) return true;
            // Scoped card clicks may fall back only through their own card id.
            if (cardScoped) return false;
          }
          if (input.cardMessageId) {
            return b.cardSession.cardMessageId === input.cardMessageId;
          }
          return true;
        })
      : [];
    let stoppedCount = 0;
    for (const [runId, b] of bashTargets) {
      getLogger().info(
        `[lark-remote] interrupt hit bash runId=${runId} cwd=${b.cwd} userId=${input.userId}`,
      );
      await b.bashRunner.stop({ immediate: true });
      // Update card to show interrupted state. exitCode 不传（保持 null）：
      // bash-renderer 的「已手动终止」文案要求 exitCode === null；传 -1 会让
      // 该分支不可达，中断卡退化成「退出码: -1」的失败样式。
      await b.cardSession.finish('interrupted');
      this.activeBashRuns.delete(runId);
      getLogger().info(`[lark-remote] interrupt bash stop done runId=${runId}`);
      stoppedCount++;
    }
    return stoppedCount;
  }
}
