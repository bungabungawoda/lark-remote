// 会话 / 停止 / 压缩 / resume / active 卡片动作族。
// 实现从 CommandRouter 搬出；类上保留同名薄委托，分发表仍按方法名字符串命中。
import type { CommandContext } from '../../bridge/index.js';
import { agentDisplayName } from '../../card/card-shared.js';
import { resolveAgentKind } from '../../agent-kinds.js';
import { RESUME_PAGE_SIZE } from '../commands/resume.js';
import type { CommandRouter } from '../index.js';
import type { CardActionPayload, CardActionResponse } from './shared.js';
import { ACTIVE_PAGE_SIZE, CARD_PAYLOAD_MISSING, normalizePageArgs } from './shared.js';

/**
 * resume.use: 从 /resume 列表卡切换到所选会话。
 */
export async function handleResumeUse(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<void> {
  // resume.use carries an agent field from /resume [agent] list cards
  // (both active and completed cards include the agent field).
  const resolvedAgent = resolveAgentKind(value.agent, host.config.defaultAgent);

  const entry = host.sessionStore.get(ctx.userId);
  const cwd = entry?.cwd;
  if (!cwd) {
    await host.bridge.sendResult({ text: '请先 /cd 设置工作目录' }, ctx);
    return;
  }

  // 校验前不得写入 sessionId。旧实现先无条件 setSessionId 再调
  // cmdResume 校验，过期卡片（session 不在当前 cwd）校验失败时 store 已被
  // 污染；value.sessionId 缺失时还会静默清空已有绑定。现在统一走 cmdResume
  // 的已验证路径（:2352 校验通过才写入），sessionId 缺失直接报错。
  if (!value.sessionId) {
    await host.bridge.sendResult({ text: '缺少 sessionId，请重新从 /resume 列表选择会话' }, ctx);
    return;
  }
  await host.bridge.sendResult(host.cmdResume([resolvedAgent, value.sessionId], ctx), ctx);
}

/** new-session: 清空当前会话绑定，下一条消息开始全新对话。 */
export async function handleNewSession(host: CommandRouter, ctx: CommandContext): Promise<void> {
  host.sessionStore.clearSessionId(ctx.userId, host.config.defaultAgent, {
    clearSessionCwd: true,
  });
  const cwd = host.sessionStore.getCwd(ctx.userId) ?? '(未设置)';
  const agentName = agentDisplayName(host.config.defaultAgent);
  await host.bridge.sendResult(
    { text: `已创建新 ${agentName} 会话，下一条消息将开始全新对话\n📁 ${cwd}` },
    ctx,
  );
}

/** compact: 对当前会话发起压缩（bridge 收口）。 */
export async function handleCompact(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<void> {
  await host.bridge.handleCompactAction(value, ctx);
}

/** resume.compact: 对 /resume 选中的历史会话发起压缩（bridge 收口）。 */
export async function handleResumeCompact(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<void> {
  await host.bridge.handleResumeCompact(value, ctx);
}

/** stop.session: 恢复卡上的「终止」——取消指定 session 的宿主 turn。 */
export async function handleStopSession(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<void> {
  await host.bridge.handleStopSession(value, ctx);
}

/**
 * Handle resume.page: paginate the /resume session list in place.
 * Mirrors handleLsPage — updates the same card, never sends a new one.
 */
export async function handleResumePage(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse> {
  const resolvedAgent = resolveAgentKind(value.agent, host.config.defaultAgent);

  const { pageSize, alignedOffset, error } = normalizePageArgs(value, RESUME_PAGE_SIZE);
  if (error) {
    return { toast: { type: 'error', content: error } };
  }

  const entry = host.sessionStore.get(ctx.userId);
  const cwd = entry?.cwd;
  if (!cwd) {
    return { toast: { type: 'error', content: '请先 /cd 设置工作目录' } };
  }

  // cmdResume clamps stale/out-of-range offsets and re-fetches internally.
  const result = host.cmdResume([resolvedAgent, String(pageSize)], ctx, alignedOffset);
  if (!result.card) {
    // e.g. the agent has no sessions in this directory — surface an error
    // toast instead of a contradictory success toast plus text reply.
    // Agent name keeps the toast consistent with the text branch of cmdResume.
    return {
      toast: {
        type: 'error',
        content: `当前目录没有 ${agentDisplayName(resolvedAgent)} 的 session 记录`,
      },
    };
  }
  await host.bridge.updateCardInPlace(result.card, ctx);
  return { toast: { type: 'success', content: '' } };
}

/**
 * Handle active.page: paginate the /active run list in place.
 * Mirrors handleResumePage — updates the same card, never sends a new one.
 */
export async function handleActivePage(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse> {
  const { alignedOffset, error } = normalizePageArgs(value, ACTIVE_PAGE_SIZE);
  if (error) {
    return { toast: { type: 'error', content: error } };
  }

  const result = host.cmdActive([], ctx, alignedOffset);
  if (!result.card) {
    return { toast: { type: 'error', content: '当前没有正在进行中的任务' } };
  }
  await host.bridge.updateCardInPlace(result.card, ctx);
  return { toast: { type: 'success', content: '' } };
}

/**
 * Handle stop card action: interrupt current run.
 */
export async function handleCardStop(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<void> {
  if (!ctx.userId || !ctx.chatId || (!value.runId && !ctx.messageId)) {
    await host.bridge.sendResult({ text: '⚠️ 无效的停止请求，缺少必要信息' }, ctx);
    return;
  }
  const interrupt = await host.bridge.interruptCurrentRunDetailed({
    userId: ctx.userId,
    chatId: ctx.chatId,
    ...(value.runId ? { runId: value.runId } : {}),
    cardMessageId: ctx.messageId,
  });
  const stopped = interrupt.stopped;
  // card stop button silently no-op'd when the
  // run had already exited. Give the user a visible result.
  if (!stopped) {
    await host.bridge.sendResult({ text: '该任务已结束，无需终止' }, ctx);
    return;
  }
  // DSH: `session/cancel` is only a request. If the host still reports the
  // turn open, say so instead of letting the card imply a clean stop.
  if (interrupt.stop?.status === 'unconfirmed') {
    const name = interrupt.agentKind ? agentDisplayName(interrupt.agentKind) : 'agent';
    await host.bridge.sendResult(
      {
        text:
          `⚠️ 未能确认 ${name} 的 turn 已停止，它可能仍在后台运行。\n` +
          '请在 DSH Web UI 检查；需要终止时再点一次停止。',
      },
      ctx,
    );
  }
}

/**
 * Handle a terminal card's 「停止」 on one background job.
 *
 * 任务跨 run 生命周期，所以卡片按钮是唯一入口；失败必须给出可读原因
 * （任务已自行结束、服务重启后快照被回收），不能点了没反应。
 */
export async function handleJobKill(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<void> {
  const runId = typeof value.runId === 'string' ? value.runId : '';
  const jobId = typeof value.jobId === 'string' ? value.jobId : '';
  // miss path 必回复（本文件的设计约束）：旧版/异常卡片 payload 缺参时
  // 静默 return 会让点击毫无反应，用户无从判断。
  if (!runId || !jobId) {
    await host.bridge.sendResult({ text: CARD_PAYLOAD_MISSING }, ctx);
    return;
  }
  if (await host.bridge.killBackgroundJob(runId, jobId, ctx)) return;
  await host.bridge.sendResult({ text: '停止失败：任务可能已自行结束，或记录已回收' }, ctx);
}
