import { randomUUID } from 'node:crypto';
import type { AgentSessionReader } from '../session-contract.js';
import type { Runner, AgentEvent } from '../runner/index.js';
import { sleep } from '../common/sleep.js';
import type { AppConfig } from '../config/index.js';
import type { SessionReaderRegistry, SessionStore } from '../session/index.js';
import { resolveFinalUsage, errorMessage } from './final-usage.js';
import { getLogger } from '../logger/index.js';
import { RunCardSession } from '../card/run-card-session.js';
import { renderRunCardDetailed } from '../card/run-renderer.js';
import { isRunTerminal, type RunTerminal } from '../card/run-state.js';
import { AGENT_KINDS } from '../agent-kinds.js';
import type { AgentKind } from '../agent-kinds.js';
import { supportsCompact } from '../runner/types.js';
import type { BridgeChannel, CommandContext, CommandResult } from './index.js';
import type { ActiveRun, IdleWatchdog } from './index.js';

/**
 * 单点化：`'runCompact' in runner` 鸭子探测
 * codex app-server + kimi/opencode ACP runner 满足。
 */
function runnerHasRunCompact(runner: Runner): boolean {
  return (
    'runCompact' in runner && typeof (runner as Record<string, unknown>).runCompact === 'function'
  );
}

/**
 * 已告警过的能力不一致 kind。能力表（`COMPACT_CAPABILITY`）是声明，runner 方法
 * 是实现；两者不一致是开发期缺陷，只在首次冲突时打 error，避免每次渲染刷屏。
 */
const compactMismatchWarned = new Set<AgentKind>();

/**
 * Compact 能力的双重门控：声明的能力表 && runner 实际实现。
 *
 * 只做鸭子探测会把「漏实现」降级成静默隐藏按钮（dsh 就这样漏了），所以声明表
 * 是必需项；只信声明表则可能渲染出点不动的死按钮，所以实现检查也保留。两者
 * 不一致时打 error 日志，让缺陷在运行日志里可见。
 */
export function runnerSupportsCompact(runner: Runner, kind: AgentKind): boolean {
  const declared = supportsCompact(kind);
  const implemented = runnerHasRunCompact(runner);
  if (declared !== implemented && !compactMismatchWarned.has(kind)) {
    compactMismatchWarned.add(kind);
    getLogger().error(
      `[lark-remote] compact capability mismatch kind=${kind} declared=${declared} implemented=${implemented}`,
    );
  }
  return declared && implemented;
}

/**
 * Emoji reaction per run terminal state, so a glance at the user's original
 * message distinguishes how the run ended. Unknown/non-terminal states fall
 * back to 'Done' (default).
 */
const TERMINAL_REACTION_EMOJI: Partial<Record<RunTerminal, string>> = {
  error: 'ERROR',
  idle_timeout: 'Alarm',
  interrupted: 'SHHH',
  // 本轮结束但目标继续：任务还没完，不能打 ✓（Done）。
  goal_continuing: 'OnIt',
};

/**
 * 终态 reaction 的单源映射：普通 run 收尾（bridge/index.ts finalizeRun）与
 * 压缩收尾（本文件 streamCompact）共用同一份，保证同一终态打同一表情。
 */
export function terminalReactionEmoji(terminal: RunTerminal): string {
  return TERMINAL_REACTION_EMOJI[terminal] ?? 'Done';
}

/**
 * runCompact 能力收窄后的 runner 最小形态。streamCompact 的 'in' 探测让这步
 * cast 合法（TS 认为可能缺方法时直接 cast 会报 TS2352）；事件消费循环只依赖
 * 这一个方法。
 */
type CompactCapableRunner = {
  runCompact: (
    message: string,
    opts: { cwd: string; sessionId: string },
  ) => AsyncGenerator<AgentEvent>;
};

/**
 * 每个 cwd 保留的「可压缩 run」条数上限。Compact 按钮挂在终态 run 卡片上，
 * 卡片会被后续消息不断顶上去；无上限会让长跑进程随 run 数无界增长，而用户
 * 实际能点到的只有最近几张卡，20 条足以覆盖。
 */
const MAX_COMPACTABLE_RUNS_PER_CWD = 20;

/**
 * 终态 run 卡片 Compact 按钮的取参记录。按钮只带 runId（渲染期 sessionId 可能
 * 还没到，runId 一定在），点击时据此反查该次 run 实际使用的会话。
 */
interface CompactRunRecord {
  sessionId: string;
  agentKind: AgentKind;
  /**
   * 该次 run 实际执行的工作目录。按 runId 反查时会跨 cwd 命中，压缩必须回到
   * run 自己的 cwd（session 文件、runner 实例都按 cwd 解析），不能取用户
   * 「当前」cwd —— 点击时可能已经 /cd 到别处，或排队期间被 /cd 改写。
   */
  cwd: string;
}

/**
 * Compact 生命周期（bridge 结构治理第 1 刀）：可压缩 run 记账、终态卡 /
 * resume 卡两条 Compact 入口、kimi 在途检测与压缩流式卡。
 *
 * 依赖全部显式注入（与 ApprovalActions / InboundMediaHandler 同一模式）：
 * - `activeRuns` 是与普通 run **共用的同一张 cwd 槽位表**——压缩注册前先确认
 *   槽位空闲，否则会覆盖在跑 run 的记录、`/stop` 停错对象；压缩自己不设
 *   per-call 超时（DSH 的 runCompact RPC 关闭 unary 预算），卡住时由
 *   `/stop` + §9.12 空闲看门狗兜底。
 * - 记账上限 per-cwd `MAX_COMPACTABLE_RUNS_PER_CWD`，超出按插入序淘汰最旧。
 */
export interface CompactLifecycleDeps {
  /** 与普通 run 共用的 cwd 槽位表（Bridge.activeRuns，按引用共享）。 */
  activeRuns: Map<string, ActiveRun>;
  connector: BridgeChannel;
  sessionStore: SessionStore;
  sessionReaderRegistry: SessionReaderRegistry;
  /** live 取值：`/config` 会整体替换 config 引用，不能按值快照。 */
  getConfig(): AppConfig;
  getRunner(cwd: string, kind?: AgentKind, opts?: { replaceStale?: boolean }): Runner;
  sendResult(
    result: CommandResult,
    ctx: CommandContext,
    opts?: { onCardSent?: (messageId: string) => void },
  ): Promise<boolean>;
  startIdleWatchdog(opts: {
    runId: string;
    session: RunCardSession;
    runner: Runner;
    /** >0 = 正在等人工审批：「等审批」不是「挂死」，刷新窗口而不是终止。 */
    pendingApprovals?: () => number;
  }): IdleWatchdog;
  finishTurnReactions(ctx: CommandContext, emoji: string): void;
  resolveCwd(userId: string): string | undefined;
}

export class CompactLifecycle {
  private readonly deps: CompactLifecycleDeps;

  /**
   * 最近若干次已完成的、runner 有 runCompact 的 run（cwd → runId → 记录）。
   * run 结束后 activeRuns 已清空，而终态卡上的 Compact 按钮只带 runId，
   * 需要它反查 sessionId + agentKind。
   *
   * 为什么按 runId 存而不是「每 cwd 只留最新一条」：compact 卡片动作走串行
   * 队列（会被正在跑的 run 挡住），点击到执行之间可能夹着别的 run 收尾。
   * 单槽会被覆盖 —— 旧卡片的压缩必然报「该任务已结束或不属于当前会话」，
   * 与 session 是否还在、能否压缩无关（2026-10-08 线上缺陷）。
   */
  private compactableRuns = new Map<string, Map<string, CompactRunRecord>>();

  constructor(deps: CompactLifecycleDeps) {
    this.deps = deps;
  }

  /**
   * 记下一次「可压缩 run」：终态卡上的 Compact 按钮点击时据此反查
   * sessionId + agentKind。runId 是按钮自带的唯一键，同 cwd 内唯一。
   * 超出上限按插入序淘汰最旧的一条（Map 保持插入序；重复写同一 runId
   * 先 delete 再 set 以刷新位置）。
   */
  private recordCompactableRun(
    cwd: string,
    runId: string,
    sessionId: string,
    agentKind: AgentKind,
  ): void {
    let byRunId = this.compactableRuns.get(cwd);
    if (!byRunId) {
      byRunId = new Map();
      this.compactableRuns.set(cwd, byRunId);
    }
    byRunId.delete(runId);
    byRunId.set(runId, { sessionId, agentKind, cwd });
    while (byRunId.size > MAX_COMPACTABLE_RUNS_PER_CWD) {
      const oldest = byRunId.keys().next().value as string;
      byRunId.delete(oldest);
    }
  }

  /**
   * 终态 Compact 记账：把本次 run 实际使用的 sessionId 记进
   * {@link compactableRuns}，供终态卡上的 Compact 按钮按 runId 反查。
   *
   * 调用点固定在 `finalizeRun` 的 `finally` 里、**槽位所有权守卫之外**。
   * 所有权守卫只回答「cwd 槽位还归不归本 run」（决定能否删槽位 / evict
   * runner）；记账回答「本次 run 结束了吗、用的哪个 sessionId」。两者在不同
   * 维度上：外部中断（`/stop`、停止卡按钮、`queue.immediate`）会先摘槽位，
   * 记账若跟着守卫走就永远不会落，中断卡片的按钮必然反查不到（中断
   * 后点 Compact 一律回「该任务已结束或不属于当前会话」）。
   *
   * 覆盖所有终态入口（正常结束、error、interrupted、idle_timeout、
   * goal_continuing）——这些卡片都渲染 Compact 按钮（`goal` 仍 active 时
   * 除外）。函数体全部是内存操作（查表、属性读、Map 写），无 IO 无解析，
   * 不需要兜错；真正的清理容错由调用方 finally 保证。
   */
  recordCompactableRunForTerminal(
    cardSession: RunCardSession,
    activeRun: ActiveRun,
    ctx: CommandContext,
  ): void {
    if (!runnerSupportsCompact(activeRun.runner, activeRun.agentKind)) return;
    if (activeRun.runner.lifetime !== 'workspace') return;
    const terminal = cardSession.currentState.terminal;
    // 与事件消费守卫、Compact 按钮共用同一份终态集合（run-state.ts）。
    if (!isRunTerminal(terminal)) return;
    // 卡片状态优先（本轮 init/turn_started 写入）；缺失时回退 store——
    // 启动失败但已 /stop 的 run 没有自己的 init，压缩此前会话仍是有意义
    // 的动作。
    const compactSessionId =
      cardSession.currentState.sessionId ??
      this.deps.sessionStore.getSessionId(ctx.userId, activeRun.agentKind);
    if (!compactSessionId) return;
    this.recordCompactableRun(
      activeRun.cwd,
      activeRun.runId,
      compactSessionId,
      activeRun.agentKind,
    );
  }

  /**
   * 按 runId 反查可压缩 run 记录（跨 cwd 扫描）。
   *
   * 为什么不带 cwd 过滤：按钮属于「那一次 run」，与用户此刻在哪个工作目录、
   * 排队期间有没有 /cd 无关。`/stop` 的 interruptCurrentRun 同样是全局按 runId
   * 找（从不查当前 cwd），compact 与它保持一致。用当前 cwd 收窄会让「切了工作区
   * 再点旧卡片」和「排队期间 /cd」两种情况误报「该任务已结束或不属于当前会话」。
   */
  private findCompactableRun(runId: string): CompactRunRecord | undefined {
    for (const byRunId of this.compactableRuns.values()) {
      const record = byRunId.get(runId);
      if (record) return record;
    }
    return undefined;
  }

  /**
   * Handle compact card action — trigger a compaction request for any
   * runCompact-capable runner（codex/kimi/opencode/pi/claude）。按钮带的是
   * 那次 run 的 runId，据此反查该 run 实际使用的 sessionId + agentKind
   * + cwd（compactableRuns，按 runId 记录），再调 runner 的 runCompact()。
   */
  async handleCompactAction(value: { runId?: string }, ctx: CommandContext): Promise<void> {
    const log = getLogger();
    log.info(
      `[lark-remote] handleCompactAction userId=${ctx.userId} runId=${value.runId?.slice(0, 8)}...`,
    );

    const { runId } = value;
    if (!runId) {
      await this.deps.sendResult({ text: '⚠️ 无效的 Compact 请求，缺少 runId' }, ctx);
      return;
    }

    // 校验：run 结束后 activeRuns 已清空，只能靠按钮自带的 runId 反查记录。
    // 按 runId 存（不按「最新的那一条」），点击到执行之间夹了新 run 收尾也不失效；
    // 查找也不按「当前 cwd」收窄（见 findCompactableRun）。
    const target = this.findCompactableRun(runId);
    if (!target) {
      await this.deps.sendResult({ text: '⚠️ 该任务已结束或不属于当前会话' }, ctx);
      return;
    }
    // 压缩必须用那次 run 自己的 cwd（session 文件 + runner 实例都按 cwd 解析）。
    const cwd = target.cwd;

    // §5.3: kimi 压缩在途检测（wire 状态机）。第二次点击在本地毫秒级如实回答，
    // 不开卡、不发 session/prompt——否则 kimi 服务端拒绝并产生「秒回」假完成。
    if (await this.rejectIfCompactionInFlight(target.sessionId, cwd, target.agentKind, ctx)) {
      return;
    }

    // Check that the runner has runCompact method（声明表 && runner 实现）
    const runner = this.deps.getRunner(cwd, target.agentKind, { replaceStale: true });
    if (!runnerSupportsCompact(runner, target.agentKind)) {
      await this.deps.sendResult({ text: '⚠️ 当前运行模式不支持 Compact' }, ctx);
      return;
    }

    log.info(
      `[lark-remote] handleCompactAction executing runCompact for runId=${runId} cwd=${cwd}`,
    );
    await this.streamCompact({
      sessionId: target.sessionId,
      cwd,
      agentKind: target.agentKind,
      runner,
      ctx,
    });
  }

  /**
   * §5.3: kimi 压缩在途检测——reader 实现契约的 `readCompactionState` 时，若
   * wire 状态机判定当前有未终结的压缩（最后一次 begin 无 terminal 记录），
   * 直接回文本「已有一次 Compact 正在进行」并返回 true（调用方不开卡、不发
   * session/prompt）。codex/claude 等 reader 无此方法 → 返回 false，行为不变。
   */
  private async rejectIfCompactionInFlight(
    sessionId: string,
    cwd: string,
    agentKind: AgentKind,
    ctx: CommandContext,
  ): Promise<boolean> {
    const reader = this.deps.sessionReaderRegistry.get(agentKind);
    if (!reader?.readCompactionState) return false;
    try {
      const state = reader.readCompactionState(sessionId, cwd);
      if (state?.inFlight) {
        const since = state.inFlightSince;
        let timeLabel = '未知时刻';
        if (since !== undefined) {
          const d = new Date(since);
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          timeLabel = `${hh}:${mm}`;
        }
        await this.deps.sendResult(
          { text: `⚠️ 已有一次 Compact 正在进行（开始于 ${timeLabel}），请等待完成` },
          ctx,
        );
        return true;
      }
    } catch (err) {
      getLogger().warn(
        `[lark-remote] readCompactionState failed sessionId=${sessionId}: ${errorMessage(err)}`,
      );
    }
    return false;
  }

  /**
   * Stream a compaction to a card: start a RunCardSession with
   * operationKind='compaction' (no recursive Compact button), consume
   * runner.runCompact() events, read authoritative jsonl usage, and finish
   * the card. Shared by handleCompactAction (run card button) and
   * handleResumeCompact (resume cards) so both flows stay in sync.
   *
   * Precondition: callers have already validated that `runner` implements
   * runCompact and that the session exists in `cwd`.
   */
  private async streamCompact(opts: {
    sessionId: string;
    cwd: string;
    agentKind: AgentKind;
    runner: Runner;
    ctx: CommandContext;
  }): Promise<void> {
    const log = getLogger();
    const { sessionId, cwd, agentKind, runner, ctx } = opts;
    log.info(`[lark-remote] streamCompact sessionId=${sessionId} cwd=${cwd}`);

    // 能力收窄：调用方已校验（runId / resume 两条路径），此处仅保留 'in'
    // 探测让 TS 收窄 runner 类型（其后的 cast 才合法）。
    if (
      !('runCompact' in runner) ||
      typeof (runner as Record<string, unknown>).runCompact !== 'function'
    ) {
      await this.deps.sendResult({ text: '⚠️ 当前运行模式不支持 Compact' }, ctx);
      return;
    }

    // activeRuns 以 cwd 为键：注册前先确认槽位空闲，否则压缩会覆盖在跑的 run 的
    // 记录，令 /stop 只停到最后注册的那个。
    const busyWith = this.deps.activeRuns.get(cwd);
    if (busyWith) {
      log.info(`[lark-remote] compact refused: cwd busy cwd=${cwd} runId=${busyWith.runId}`);
      await this.deps.sendResult({ text: '⚠️ 该工作区正在运行任务，请等待结束或先 /stop' }, ctx);
      return;
    }

    await this.deps.sendResult({ text: '🗜 Compact 已触发，正在压缩会话…' }, ctx);

    const compactRunId = randomUUID();
    // 渲染选项同时用于流式卡与「卡片流没建起来」时的静态兜底卡——两者必须
    // 同门控，否则兜底卡会渲染出与本次 run 不一致的按钮。
    const renderOptions = { agentKind };
    const cardSession = new RunCardSession({
      connector: this.deps.connector,
      chatId: ctx.chatId,
      replyTo: ctx.messageId,
      runId: compactRunId,
      renderOptions,
    });
    // 压缩与普通 run 共用同一套生命周期——注册进 activeRuns（/stop 有对象可停、
    // /active 看得见）、挂 §9.12 空闲看门狗、终态后补 reaction。缺任何一环，卡住的
    // 压缩都只能等 runner 级超时，用户既停不掉也看不出它还在跑。
    const activeRun: ActiveRun = {
      runId: compactRunId,
      userId: ctx.userId,
      chatId: ctx.chatId,
      session: cardSession,
      cwd,
      runner,
      agentKind,
    };
    this.deps.activeRuns.set(cwd, activeRun);
    getLogger().info(`[lark-remote] activeRuns.set cwd=${cwd} runId=${compactRunId} compact=true`);
    let watchdog: IdleWatchdog | null = null;

    try {
      await cardSession.start();
      watchdog = this.deps.startIdleWatchdog({
        runId: compactRunId,
        session: cardSession,
        runner,
      });
      // operationKind=compaction：卡片不渲染 Compact 按钮（防递归 Compact）。
      await cardSession.push({
        type: 'turn_started',
        threadId: sessionId,
        turnId: '',
        operationKind: 'compaction',
      });
      const outcome = await this.consumeCompactEvents(
        cardSession,
        watchdog,
        runner as CompactCapableRunner,
        sessionId,
        cwd,
      );
      await this.finishCompactCard(cardSession, sessionId, cwd, agentKind, outcome);
      log.info(
        `[lark-remote] streamCompact finished sessionId=${sessionId} sawResult=${outcome.sawResult} subtype=${outcome.resultSubtype ?? 'none'}`,
      );
    } catch (err) {
      log.error(`[lark-remote] streamCompact failed: ${errorMessage(err)}`);
      // 终态守卫（与 runAgentStreamToEnd 同口径）：running/finalizing 才转 error，
      // 已终态（interrupted/idle_timeout）保留首终态，不被迟到的异常改写。
      const catchTerminal = cardSession.currentState.terminal;
      if (!isRunTerminal(catchTerminal)) {
        await cardSession.finish('error', { errorMsg: errorMessage(err) });
      } else {
        log.info(
          `[lark-remote] skip compact error finish: state already terminal (${catchTerminal}) runId=${compactRunId}`,
        );
      }
    } finally {
      watchdog?.stop();
      // 与 run 路径同口径的降级：卡片流没建起来（start 失败 / stream 未收尾）时，
      // 终态只存在于内存里。settle() 释放 producer 并等 stream 收尾；'unsent'
      // 表示用户手里没有卡，必须补一张静态终态卡，否则只剩「Compact 已触发」
      // 和一条 reaction，用户既不知道失败也不知道原因。
      const settled = await cardSession.settle();
      if (settled === 'unsent') {
        const finalRender = renderRunCardDetailed(cardSession.currentState, renderOptions);
        await this.deps.sendResult({ card: finalRender.card }, ctx);
      }
      // 只摘自己的槽位：/stop 可能已删掉本条并让排队的下一条占住同一 cwd。
      if (this.deps.activeRuns.get(cwd) === activeRun) {
        this.deps.activeRuns.delete(cwd);
        getLogger().info(`[lark-remote] activeRuns.delete cwd=${cwd} runId=${compactRunId}`);
      }
      // 终态 reaction：与普通 run 同一口径（done→Done / error→ERROR /
      // interrupted→SHHH / idle_timeout→Alarm）。
      this.deps.finishTurnReactions(ctx, terminalReactionEmoji(cardSession.currentState.terminal));
    }
  }

  /**
   * 事件消费循环（streamCompact 前半段）：吞 runner.runCompact() 的全部事件，
   * 逐帧喂卡片。终态后不再消费（与 runAgentStreamToEnd 同口径）；result 帧
   * 只做记录（subype/errorMessage），终态装配在 {@link finishCompactCard}。
   */
  private async consumeCompactEvents(
    cardSession: RunCardSession,
    watchdog: IdleWatchdog | null,
    runner: CompactCapableRunner,
    sessionId: string,
    cwd: string,
  ): Promise<{
    sawResult: boolean;
    resultSubtype: 'success' | 'error' | 'interrupted' | undefined;
    resultError: string | undefined;
  }> {
    let sawResult = false;
    let resultSubtype: 'success' | 'error' | 'interrupted' | undefined;
    let resultError: string | undefined;
    for await (const event of runner.runCompact('', { cwd, sessionId })) {
      // 已终态（/stop、空闲看门狗）后不再消费事件：与 runAgentStreamToEnd 同口径，
      // 否则迟到的 result 会把终态卡改写成「已完成」。
      const cardTerminal = cardSession.currentState.terminal;
      if (isRunTerminal(cardTerminal)) {
        continue;
      }
      if (event.type === 'result') {
        sawResult = true;
        resultSubtype = (event as { subtype?: 'success' | 'error' | 'interrupted' }).subtype;
        resultError = (event as { errorMessage?: string }).errorMessage;
      }
      watchdog?.touch();
      await cardSession.push(event);
    }
    return { sawResult, resultSubtype, resultError };
  }

  /**
   * 终态装配（streamCompact 后半段）：result subtype 三态映射 → 从会话 jsonl
   * 读权威统计（compactCount 短重试）→ cardSession.finish。
   */
  private async finishCompactCard(
    cardSession: RunCardSession,
    sessionId: string,
    cwd: string,
    agentKind: AgentKind,
    outcome: {
      sawResult: boolean;
      resultSubtype: 'success' | 'error' | 'interrupted' | undefined;
      resultError: string | undefined;
    },
  ): Promise<void> {
    const { resultSubtype, resultError } = outcome;
    // §5.3: 卡片终态必须等于引擎真实终态。旧实现只看 sawResult 布尔——error
    // subtype 的 result 也被 finish 'done'（放大器 bug，2026-08-31 事故）。
    const terminal: 'done' | 'error' | 'interrupted' =
      resultSubtype === 'success'
        ? 'done'
        : resultSubtype === 'interrupted'
          ? 'interrupted'
          : 'error';
    // 压缩结束后从会话 jsonl 读权威统计（压缩后上下文、压缩次数、本次压缩
    // token 消耗与会话累计）。thread/compacted 通知与 jsonl 落盘几乎同时
    // （实测差 ~9ms），compactCount 未读到则短重试，仍失败优雅降级（无统计）。
    // 不支持压缩统计的 reader（opencode/dsh）读到的只是压缩前末次采样，与上一张
    // run 卡的用量块逐字相同——重复展示会被读成「压缩后的数字」，因此整块不展示，
    // 也不再为拿不到的数据空跑一次完整读取。
    const compactStatsSupported =
      this.deps.sessionReaderRegistry.tryGet(agentKind)?.supportsCompactCount !== false;
    let finalUsage = compactStatsSupported
      ? resolveFinalUsage(
          this.deps.sessionReaderRegistry,
          this.deps.getConfig().defaultAgent,
          sessionId,
          cwd,
          agentKind,
        )
      : undefined;
    for (
      let attempt = 0;
      compactStatsSupported && !finalUsage?.compactCount && attempt < 2;
      attempt++
    ) {
      await sleep(150);
      finalUsage = resolveFinalUsage(
        this.deps.sessionReaderRegistry,
        this.deps.getConfig().defaultAgent,
        sessionId,
        cwd,
        agentKind,
      );
    }
    await cardSession.finish(terminal, {
      resultSubtype: resultSubtype ?? 'error',
      errorMsg: terminal === 'error' ? (resultError ?? '未收到压缩结果') : undefined,
      // finalUsage 的字段形态就是 FinishMeta 的用量部分（同为 UsageSnapshot），
      // 逐字段抄的那 14 行随单源一起去掉。
      ...(finalUsage ?? {}),
    });
  }

  /**
   * Handle resume.compact card action — compact a session directly from a
   * resume card (auto-resume / `/resume <id>`), without a runId.
   *
   * Unlike handleCompactAction (which validates against the last finished run's
   * runId), the resume card carries the sessionId + agent it was rendered for.
   * Validation: the session must exist in the current cwd (same rule as
   * cmdResume / resume.use) and the runner must implement runCompact.
   */
  async handleResumeCompact(
    value: { sessionId?: string; agent?: string },
    ctx: CommandContext,
  ): Promise<void> {
    const log = getLogger();
    log.info(
      `[lark-remote] handleResumeCompact userId=${ctx.userId} sessionId=${value.sessionId?.slice(0, 16)} agent=${value.agent ?? 'default'}`,
    );

    const { sessionId } = value;
    if (!sessionId) {
      await this.deps.sendResult({ text: '⚠️ 无效的 Compact 请求，缺少 sessionId' }, ctx);
      return;
    }

    const cwd = this.deps.resolveCwd(ctx.userId);
    if (!cwd) {
      await this.deps.sendResult({ text: '⚠️ 未设置工作目录' }, ctx);
      return;
    }

    // Resolve agent kind the same way resume.use does: card value wins,
    // otherwise fall back to defaultAgent. 名单来自单源 AGENT_KINDS —— 手抄一份
    // 必然再次漂移（这份曾经漏 dsh：带 dsh 的卡片会静默退回 defaultAgent，
    // 用错 reader 报「未找到 session」）。
    const agentKind: AgentKind =
      value.agent && (AGENT_KINDS as readonly string[]).includes(value.agent)
        ? (value.agent as AgentKind)
        : this.deps.getConfig().defaultAgent;

    // Session must exist in the current cwd (same rule as cmdResume /
    // resume.use): reject ghosts so a stale card cannot compact a session
    // from another cwd. Read failures get visible feedback (card click
    // 红线：不许静默失败)。
    let content: ReturnType<AgentSessionReader['readSessionContent']>;
    try {
      content = this.deps.sessionReaderRegistry.get(agentKind).readSessionContent(sessionId, cwd);
    } catch (err) {
      await this.deps.sendResult(
        { text: `⚠️ 读取 session ${sessionId} 失败: ${errorMessage(err)}` },
        ctx,
      );
      return;
    }
    if (
      content.events.length === 0 &&
      !content.usage &&
      !content.aiTitle &&
      !content.recap &&
      !content.displayTitle
    ) {
      await this.deps.sendResult(
        { text: `⚠️ 未找到 session ${sessionId}（当前目录: ${cwd}）` },
        ctx,
      );
      return;
    }

    // §5.3: kimi 压缩在途检测（与 handleCompactAction 同一入口）。
    if (await this.rejectIfCompactionInFlight(sessionId, cwd, agentKind, ctx)) return;

    // Check that the runner has runCompact（声明表 && runner 实现；
    // codex/kimi/opencode/pi/claude/dsh 均已实现）。
    const runner = this.deps.getRunner(cwd, agentKind);
    if (!runnerSupportsCompact(runner, agentKind)) {
      await this.deps.sendResult({ text: '⚠️ 当前运行模式不支持 Compact' }, ctx);
      return;
    }

    log.info(
      `[lark-remote] handleResumeCompact executing runCompact sessionId=${sessionId} cwd=${cwd}`,
    );
    await this.streamCompact({ sessionId, cwd, agentKind, runner, ctx });
  }
}
