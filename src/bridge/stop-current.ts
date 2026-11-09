import { agentDisplayName } from '../card/card-shared.js';
import type { AgentKind } from '../agent-kinds.js';
import type { CommandContext, CommandResult, InterruptOutcome } from './index.js';
import { formatHostStopResult, type HostTurnStopResult } from './host-stop.js';

/**
 * `/stop` 的唯一实现入口：文本命令与卡片停止都走这里。
 *
 * 顺序红线（design.md §9.6）：本地 activeRuns/bash 全部 miss 后，按当前
 * user/cwd/session 取消 DSH 宿主轮次；否则「恢复会话 / 上个实例留在 host 里的
 * turn」在用户发 `/stop` 后仍会继续跑。任何调用方自己拼一份「没有进程」的
 * 分支都会漏掉这段 fallback 与 unconfirmed 警告。
 */
export interface StopCurrentTurnBridge {
  interruptCurrentRunDetailed(input: { userId: string; chatId: string }): Promise<InterruptOutcome>;
  stopCurrentHostTurn(userId: string): Promise<HostTurnStopResult | undefined>;
}

function agentName(kind: AgentKind | undefined): string {
  return kind ? agentDisplayName(kind) : 'agent';
}

export async function stopCurrentTurn(
  bridge: StopCurrentTurnBridge,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  const interrupt = await bridge.interruptCurrentRunDetailed({
    userId: ctx.userId,
    chatId: ctx.chatId,
  });

  if (!interrupt.stopped) {
    // 本地没有 activeRun/bash：恢复会话的 turn 可能仍在 DSH 宿主里跑。
    const hostStop = await bridge.stopCurrentHostTurn(ctx.userId);
    if (hostStop && hostStop.status !== 'noop') {
      return { text: formatHostStopResult(hostStop) };
    }
    return { text: '当前没有运行中的进程' };
  }

  if (interrupt.stop?.status === 'unconfirmed') {
    return {
      text:
        `⚠️ 未能确认 ${agentName(interrupt.agentKind)} 的 turn 已停止，它可能仍在后台运行。\n` +
        '请在 DSH Web UI 检查；需要终止时再发一次 /stop。',
    };
  }

  const count = interrupt.stoppedCount ?? 1;
  if (count > 1) return { text: `✅ 已停止 ${count} 个运行中的任务` };
  return null;
}
