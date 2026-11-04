import type { Runner, AgentRunner, BackgroundJobRoster } from '../runner/index.js';
import {
  isLiveBackgroundJob,
  markBackgroundJobsUnknown,
  removeBackgroundJob,
  syncBackgroundJobs,
} from '../card/run-state.js';
import { renderRunCard } from '../card/run-renderer.js';
import { getLogger } from '../logger/index.js';
import { errorMessage } from './final-usage.js';
import type { AgentKind } from '../agent-kinds.js';
import type { CommandContext } from './index.js';
import type { RunCardSnapshot } from './index.js';

/**
 * 终态卡后台任务订阅与停止（bridge 结构治理第 2 刀）。
 *
 * run 的卡片在 `result` 那一帧就关闭了，但后台任务（DSH/kimi 的宿主后台作业）
 * 的生命周期跨 run：job.kill 停止、名单订阅、PATCH 串行链全部收在这里，与
 * 卡片快照（bridge 侧 runCardSnapshots）按 runId 对齐。
 *
 * 依赖显式注入（与 ApprovalActions / CompactLifecycle 同一模式）。两张核心
 * 状态表都归本类所有：
 * - `jobWatches`：runId → 中止句柄。与卡片快照同生命周期——快照被淘汰、任务
 *   全结束、patch 失败时退订。上限天然受 RUN_CARD_SNAPSHOT_MAX 约束（一张卡
 *   最多一条流）。
 * - `jobCardPatches`：同一张卡的 patch 串行链（runId → 链尾）。「停止按钮」和
 *   「订阅帧」都会改同一张终态卡：不串行化时两条 PATCH 并发，后发先至的那条
 *   会把卡片写回旧内容（任务又变回「运行中」）。
 */
export interface JobWatchLifecycleDeps {
  getRunner(cwd: string, kind?: AgentKind): Runner;
  /** 终态快照表在 bridge 侧（rememberRunCardSnapshot 收口），这里只读。 */
  getRunCardSnapshot(runId: string): RunCardSnapshot | undefined;
  /** 「停止任务」后的整卡重渲染（失败回退发新卡）。 */
  updateCardInPlace(card: object, ctx: CommandContext): Promise<boolean>;
  /** 订阅帧的原位 PATCH（已知卡，失败不补发）。 */
  patchCard(messageId: string, card: object): Promise<boolean>;
}

export class JobWatchLifecycle {
  private readonly deps: JobWatchLifecycleDeps;

  /** 终态卡后台任务订阅（runId → 中止句柄）。 */
  private jobWatches = new Map<string, AbortController>();

  /** 同一张卡的 patch 串行链（runId → 链尾）。 */
  private jobCardPatches = new Map<string, Promise<void>>();

  constructor(deps: JobWatchLifecycleDeps) {
    this.deps = deps;
  }

  /** 退订一张终态卡的后台任务名单（幂等）。 */
  stopJobWatch(runId: string): void {
    this.jobWatches.get(runId)?.abort();
    this.jobWatches.delete(runId);
    this.jobCardPatches.delete(runId);
  }

  /**
   * 停止终态卡上的一个后台任务。
   *
   * 后台任务的生命周期跨 run（这就是它需要单独入口的原因），所以解析路径是
   * 终态快照（runId → sessionId/cwd/agentKind）+ 该工作区的 runner 实例，
   * 而不是 activeRuns。成功后同步摘掉 state 里的任务并就地重渲染，否则按钮
   * 会留在卡片上而任务早已结束。
   */
  async killBackgroundJob(runId: string, jobId: string, ctx: CommandContext): Promise<boolean> {
    const snapshot = this.deps.getRunCardSnapshot(runId);
    const sessionId = snapshot?.state.sessionId;
    if (!snapshot || !sessionId) return false;
    const runner = this.deps.getRunner(snapshot.cwd, snapshot.agentKind) as AgentRunner;
    if (typeof runner.killJob !== 'function') return false;
    const killed = await runner.killJob(sessionId, jobId);
    if (!killed) return false;
    snapshot.state = removeBackgroundJob(snapshot.state, jobId);
    // 与订阅帧共用一条串行链：两条 PATCH 并发时，后发先至的那条会把卡片写回
    // 旧内容（刚停掉的任务又显示成「运行中」）。
    await this.enqueueJobCardPatch(runId, async () => {
      await this.deps.updateCardInPlace(renderRunCard(snapshot.state, snapshot.options), ctx);
      return true;
    });
    // 卡片上已经没有在跑的任务：不必再等宿主推下一帧，直接退订。
    if (!(snapshot.state.backgroundJobs ?? []).some(isLiveBackgroundJob)) {
      this.stopJobWatch(runId);
    }
    return true;
  }

  /**
   * 让终态卡的后台任务小节跟着宿主继续更新。
   *
   * run 的卡片在 `result` 那一帧就关闭了，但后台任务还能再跑很久：不订阅，
   * 卡片会一直写「运行中」并留着停止按钮，点了必然失败。退订条件写
   * 在 {@link consumeJobRoster} 里——名单清空、patch 失败、订阅中断、快照被
   * 淘汰，任一命中即退出；**绝不因为 patch 失败补发新卡**。
   */
  startBackgroundJobWatch(runId: string, snapshot: RunCardSnapshot, runner: Runner): void {
    const live = (snapshot.state.backgroundJobs ?? []).some(isLiveBackgroundJob);
    if (!live) return;
    const sessionId = snapshot.state.sessionId;
    const messageId = snapshot.messageId;
    const watchJobs = (runner as AgentRunner).watchJobs;
    if (!sessionId || !messageId || typeof watchJobs !== 'function') {
      // 没有卡 id 就没有 patch 的落点：保留收尾快照，不另发一张卡。
      getLogger().info(
        `[lark-remote] background jobs stay on the turn snapshot runId=${runId} ` +
          `(sessionId=${sessionId ?? '-'} messageId=${messageId ?? '-'} watchable=${typeof watchJobs === 'function'})`,
      );
      return;
    }
    const controller = new AbortController();
    this.jobWatches.set(runId, controller);
    void this.consumeJobRoster(runId, snapshot, controller, (signal) =>
      watchJobs.call(runner, sessionId, signal),
    );
  }

  /** 消费宿主推来的整份任务名单，直到全结束 / 流断 / patch 失败 / 外部退订。 */
  private async consumeJobRoster(
    runId: string,
    snapshot: RunCardSnapshot,
    controller: AbortController,
    watch: (signal: AbortSignal) => AsyncIterable<ReadonlyArray<BackgroundJobRoster>>,
  ): Promise<void> {
    const messageId = snapshot.messageId;
    if (!messageId) return;
    let allEnded = false;
    // 订阅帧 PATCH 已失败 → 卡片不可达：finally 不再补 markJobsUnknown。
    let cardLost = false;
    try {
      for await (const roster of watch(controller.signal)) {
        const next = syncBackgroundJobs(snapshot.state, roster);
        // 名单没变化就不打 PATCH：宿主可能重复推同一份。
        if (next === snapshot.state) continue;
        snapshot.state = next;
        const ok = await this.enqueueJobCardPatch(runId, () =>
          this.deps.patchCard(messageId, renderRunCard(snapshot.state, snapshot.options)),
        );
        if (!ok) {
          getLogger().warn(
            `[lark-remote] background job card update failed, stop watching runId=${runId}`,
          );
          // 卡片已不可达：markJobsUnknown 的补写注定再失败，且「标未知」
          // 是写给卡片读者看的——没有卡就没有读者。置标志让 finally 跳过。
          cardLost = true;
          return;
        }
        if (!(snapshot.state.backgroundJobs ?? []).some(isLiveBackgroundJob)) {
          allEnded = true;
          return;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        getLogger().warn(
          `[lark-remote] background job watch failed runId=${runId}: ${errorMessage(err)}`,
        );
      }
    } finally {
      const externallyAborted = controller.signal.aborted;
      controller.abort();
      // 流断了而任务没结算：监控中断 ≠ 任务结束，标成未知而不是继续写「运行中」。
      // 但卡片 PATCH 已失败（cardLost）时不补写：补写注定失败且语义错位。
      if (!allEnded && !cardLost && !externallyAborted) await this.markJobsUnknown(runId, snapshot);
      this.jobWatches.delete(runId);
      this.jobCardPatches.delete(runId);
    }
  }

  /** 订阅断了但任务仍未结算：把在跑的任务标成「状态未知」并重渲染一次。 */
  private async markJobsUnknown(runId: string, snapshot: RunCardSnapshot): Promise<void> {
    const next = markBackgroundJobsUnknown(snapshot.state);
    if (next === snapshot.state) return;
    snapshot.state = next;
    const messageId = snapshot.messageId;
    if (!messageId) return;
    await this.enqueueJobCardPatch(runId, () =>
      this.deps.patchCard(messageId, renderRunCard(snapshot.state, snapshot.options)),
    );
  }

  /**
   * 一张终态卡的 PATCH 串行链。
   *
   * 渲染放在链内执行（`task` 里读 `snapshot.state`），后入链的任务必然看到更新
   * 后的状态；否则「停止」与「订阅帧」并发时卡片可能回退。
   */
  private enqueueJobCardPatch(runId: string, task: () => Promise<boolean>): Promise<boolean> {
    const previous = this.jobCardPatches.get(runId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.jobCardPatches.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
