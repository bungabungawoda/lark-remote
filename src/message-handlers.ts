import fs from 'node:fs';
import type { AppConfig } from './config/index.js';
import { getLogger } from './logger/index.js';
import type { Bridge } from './bridge/index.js';
import type { FeishuConnector } from './connector/index.js';
import type { CommandRouter, CardActionPayload } from './router/index.js';
import {
  COMPACT_ACTION_CMDS,
  DIRECT_RETURN_CMDS,
  SESSION_MUTATING_ACTION_CMDS,
  isImmediateAction,
} from './router/index.js';
import type { SessionStore } from './session/index.js';
import type { WorkspaceStore } from './workspace/index.js';
import type { OwnerBinder } from './binder.js';
import type { CloneSession } from './clone.js';
import { InboundTurnAssembler, type AssemblerContext } from './inbound/turn-assembler.js';
import { InboundAuthorizer } from './inbound/authorize.js';
import { stripPlaceholders } from './inbound/placeholder.js';
import type { InboundTurn, MediaOutcome } from './inbound/turn.js';
import { agentDisplayName } from './card/card-shared.js';
import { sleep } from './common/sleep.js';
import { bestEffortUnlink } from './common/fs.js';
import { dispatchOrderExecForQueue } from './router/order-exec-dispatch.js';
import { buildCardActionFullValue } from './router/card-action-payload.js';
import { actionFeedbackText } from './router/card-action-feedback.js';
import { stopCurrentTurn } from './bridge/stop-current.js';

/**
 * 会改 session 的卡片动作在分发前等待 inbound flush 的上限（ms）。
 *
 * 飞书卡片回调要求 3 秒内响应；flush 只是「让在途附件落定」，不该独占整个
 * 预算——超时后 flush 仍在后台继续，router 侧还有 1.5s 收尾预算。
 */
const SESSION_MUTATING_FLUSH_BUDGET_MS = 1_000;

/**
 * /stop 命令别名单源：普通消息的停止分支与 clone 活跃期拦截的排除条件
 * 共用同一判定，防止将来加别名时两处漂移。
 */
function isStopCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === '/stop' || t === '/t';
}

export interface MessageHandlerDeps {
  connector: FeishuConnector;
  router: CommandRouter;
  bridge: Bridge;
  sessionStore: SessionStore;
  workspaceStore: WorkspaceStore;
  binder: OwnerBinder;
  logger: ReturnType<typeof getLogger>;
  config: AppConfig;
  cloneSession: CloneSession;
}

// 各 connector 回调从 setter 签名反推参数类型（connector 里的 handler 类型未 export）。
type FeishuMessage = Parameters<Parameters<FeishuConnector['setMessageHandler']>[0]>[0];
type InboundMediaMessage = Parameters<
  Parameters<FeishuConnector['setInboundMediaDetectedHandler']>[0]
>[0];
type CardActionEvent = Parameters<Parameters<FeishuConnector['setCardActionHandler']>[0]>[0];

/** 全部回调共享的运行时状态（显式传给各模块级 handler，替代原闭包捕获）。 */
interface HandlerContext extends MessageHandlerDeps {
  assembler: InboundTurnAssembler;
  authorizer: InboundAuthorizer;
}

/** 入站统一装配器 commit：图/文组装成 turn → 进 agent 队列。 */
function handleTurnCommit(ctx: HandlerContext, turn: InboundTurn, prompt: string): void {
  const messageId = turn.messageIds[turn.messageIds.length - 1] ?? '';
  const taskCtx = {
    userId: turn.userId,
    chatId: turn.chatId,
    messageId,
    turnMessageIds: turn.messageIds,
  };
  let cwd = ctx.sessionStore.getCwd(turn.userId) ?? '';
  if (!cwd) {
    const recent = [...ctx.workspaceStore.list()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    if (recent.length > 0) cwd = recent[0].path;
  }
  const binding = ctx.bridge.currentBinding(turn.userId);
  ctx.bridge.enqueue(
    cwd,
    async () => {
      await ctx.router.handle(prompt, taskCtx, {
        cwdOverride: cwd,
        binding,
        allowCommandPrefix: false,
      });
    },
    {
      taskMeta: {
        userId: turn.userId,
        chatId: turn.chatId,
        messageId,
        messagePreview: prompt.slice(0, 3000),
        binding,
      },
    },
  );
}

/** 入站回执（无文本纯附件 / rejected 项）：面向用户的提示。 */
async function handleTurnReceipt(
  ctx: HandlerContext,
  receiptCtx: AssemblerContext,
  text: string,
): Promise<void> {
  await ctx.bridge.sendResult({ text }, receiptCtx);
}

/** owner 绑定成功后的 onboarding 消息（fire-and-forget）。 */
function handleBind(ctx: HandlerContext, userId: string, chatId: string): Promise<void> {
  let resolvedCwd: string;
  try {
    resolvedCwd = fs.realpathSync(process.cwd());
  } catch {
    resolvedCwd = process.cwd();
  }
  if (!ctx.sessionStore.getCwd(userId)) {
    ctx.sessionStore.setCwd(userId, resolvedCwd);
  }

  return (async () => {
    try {
      await ctx.connector.sendWithRetry(chatId, {
        text:
          `✅ 已绑定到本账号，此后仅你可使用本应用\n` +
          `📂 当前工作目录: \`${resolvedCwd}\`\n` +
          `🤖 默认 Agent: ${agentDisplayName(ctx.config.defaultAgent)}\n` +
          `💡 直接输入消息即可开始对话，或 /cd 切换目录`,
      });
      const helpResult = ctx.router.cmdHelp();
      if (helpResult.card) {
        await ctx.connector.sendWithRetry(chatId, { card: helpResult.card });
      }
    } catch (err) {
      ctx.logger.error('[binder] onboarding send failed:', err);
    }
  })();
}

/** 入站媒体（image/file）检测：鉴权 → clone 拦截 → 落盘或 rejected 回执。 */
function handleInboundMedia(ctx: HandlerContext, msg: InboundMediaMessage): void {
  const authorization = ctx.authorizer.authorize(msg.userId, msg.chatId);
  if (authorization === 'rejected') {
    ctx.logger.warn(`[media] rejected inbound media from non-owner ${msg.userId}`);
    return;
  }
  if (ctx.cloneSession.isActive()) {
    ctx.logger.info(`[media] dropped inbound media during clone session ${msg.messageId}`);
    return;
  }
  if (!ctx.router.config.inboundMedia.enabled) {
    ctx.assembler.ingest({
      kind: 'rejected',
      userId: msg.userId,
      chatId: msg.chatId,
      messageId: msg.messageId,
      replyToMessageId: msg.replyToMessageId,
      rawContentType: msg.rawContentType,
      rejectedKind: 'file',
      reason:
        '入站媒体保存已关闭（inboundMedia.enabled: false），未保存文件。' +
        '如需自动保存图片/文件，请开启后重试',
    });
    return;
  }
  const outcome = (async (): Promise<MediaOutcome> => {
    const payload = await ctx.connector.downloadInboundMedia(msg, {
      maxFileSizeMb: ctx.router.config.inboundMedia.maxFileSizeMb,
    });
    try {
      return await ctx.bridge.saveInboundMedia(payload);
    } catch (err) {
      for (const item of payload.media) bestEffortUnlink(item.tempPath);
      throw err;
    }
  })();
  ctx.assembler.ingest({
    kind: 'media',
    userId: msg.userId,
    chatId: msg.chatId,
    messageId: msg.messageId,
    replyToMessageId: msg.replyToMessageId,
    rawContentType: msg.rawContentType,
    outcome,
  });
}

/** 普通入站消息：鉴权 → clone 拦截 → /stop → 命令前缀 → 装配器。 */
function handleInboundMessage(ctx: HandlerContext, msg: FeishuMessage): void {
  const decision = ctx.authorizer.authorize(msg.userId, msg.chatId);
  if (decision === 'rejected' || decision === 'bind_success') return;

  ctx.logger.info(
    `message from ${msg.userId} (${msg.rawContentType}): ${msg.content.slice(0, 100)}`,
  );
  void ctx.connector.addReaction(msg.messageId, 'Typing');

  if (ctx.cloneSession.isActive() && !isStopCommand(msg.content)) {
    void ctx.cloneSession
      .handleMessage(msg.content, {
        userId: msg.userId,
        chatId: msg.chatId,
        messageId: msg.messageId,
      })
      .catch((err: unknown) => ctx.logger.error('[clone] message handling failed:', err));
    return;
  }

  const content = ctx.router.expandAliasMessage(msg.content);
  if (isStopCommand(content)) {
    void (async () => {
      const stopCtx = { userId: msg.userId, chatId: msg.chatId, messageId: msg.messageId };
      // 与 /stop 斜杠命令共用同一实现：本地 miss 时必须继续走 DSH 宿主轮次
      // 取消，并保留 unconfirmed 警告。文本快路径自己拼一份会漏掉这两条。
      const result = await stopCurrentTurn(ctx.bridge, stopCtx);
      if (result) await ctx.bridge.sendResult(result, stopCtx);
    })().catch((err: unknown) => ctx.logger.error('[control] /stop failed:', err));
    return;
  }

  const stripped = stripPlaceholders(content);
  if (stripped.unknownTags.length > 0) {
    ctx.logger.warn(
      `[inbound] unknown placeholder tags stripped: ${stripped.unknownTags.join(', ')} ` +
        `(msg_type=${msg.rawContentType})`,
    );
  }
  const commandEligible =
    msg.rawContentType === 'text' && stripped.kinds.length === 0 && stripped.clean !== '';

  if (commandEligible && (stripped.clean.startsWith('/') || stripped.clean.startsWith('!'))) {
    void (async () => {
      await ctx.assembler.flush(msg.userId, msg.chatId, 'flush');
      await ctx.router.handle(
        stripped.clean,
        {
          userId: msg.userId,
          chatId: msg.chatId,
          messageId: msg.messageId,
        },
        { allowCommandPrefix: true },
      );
    })().catch((err: unknown) => ctx.logger.error('[control] command failed:', err));
    return;
  }

  ctx.assembler.ingest({
    kind: 'text',
    userId: msg.userId,
    chatId: msg.chatId,
    messageId: msg.messageId,
    replyToMessageId: msg.replyToMessageId,
    rawContentType: msg.rawContentType,
    text: stripped.clean,
    placeholders: stripped.kinds,
    unknownTags: stripped.unknownTags,
  });
}

/** 卡片动作：鉴权 → stop/直返/order.exec → immediate 或普通队列。 */
async function handleCardAction(ctx: HandlerContext, action: CardActionEvent) {
  if (!ctx.binder.isOwner(action.operator.openId)) {
    ctx.binder.recordRejectedCardAction(action.operator.openId);
    return;
  }

  const actionValue = action.action.value as CardActionPayload | undefined;
  if (!actionValue?.cmd) return;

  ctx.logger.info(
    actionValue.cmd === 'stop'
      ? `card action: stop runId=${actionValue.runId ?? '(none)'} messageId=${action.messageId}`
      : `card action: ${actionValue.cmd}`,
  );

  const userId = action.operator.openId;
  const chatId = action.chatId;
  const messageId = action.messageId;
  void ctx.connector.addReaction(messageId, 'Typing');

  if (actionValue.cmd === 'stop') {
    void ctx.router
      .handleCardAction({ ...actionValue, cmd: 'stop' }, { userId, chatId, messageId })
      .catch((err: unknown) => ctx.logger.error('[control] card stop failed:', err));
    return;
  }

  const isImmediate = isImmediateAction(actionValue.cmd);
  const cwd = ctx.sessionStore.getCwd(userId) ?? '';
  const fullValue = buildCardActionFullValue(actionValue, action);

  if (SESSION_MUTATING_ACTION_CMDS.has(actionValue.cmd)) {
    const flushP = ctx.assembler
      .flush(userId, chatId, 'flush')
      .catch((err: unknown) => ctx.logger.error('[control] inbound flush failed:', err));
    await Promise.race([flushP, sleep(SESSION_MUTATING_FLUSH_BUDGET_MS)]);
  }

  if (DIRECT_RETURN_CMDS.has(actionValue.cmd)) {
    return ctx.router.handleCardAction(fullValue, { userId, chatId, messageId });
  }

  if (actionValue.cmd === 'order.exec') {
    void dispatchOrderExecForQueue({
      router: ctx.router,
      bridge: ctx.bridge,
      cwd,
      orderId: actionValue.orderId,
      ctx: { userId, chatId, messageId },
    }).catch((err: unknown) => ctx.logger.error('[control] order.exec dispatch failed:', err));
    return;
  }

  const forwardActionFeedback = (res: unknown) => {
    const text = actionFeedbackText(res);
    if (!text) return;
    void ctx.bridge
      .sendResult({ text }, { userId, chatId, messageId })
      .catch((err: unknown) => ctx.logger.error('[control] card action feedback failed:', err));
  };

  if (isImmediate) {
    ctx.bridge.enqueueImmediate(cwd, async () => {
      const res = await ctx.router.handleCardAction(fullValue, { userId, chatId, messageId });
      forwardActionFeedback(res);
    });
  } else {
    ctx.bridge.enqueue(
      cwd,
      async () => {
        const res = await ctx.router.handleCardAction(fullValue, { userId, chatId, messageId });
        forwardActionFeedback(res);
      },
      {
        taskMeta: {
          userId,
          chatId,
          messageId: ctx.router.mintQueueTaskKey('card', actionValue.cmd),
          feishuReplyTo: messageId,
          messagePreview: `card action: ${actionValue.cmd}`,
          kind: COMPACT_ACTION_CMDS.has(actionValue.cmd) ? 'compact' : 'command',
          editable: !COMPACT_ACTION_CMDS.has(actionValue.cmd),
        },
      },
    );
  }
}

export function setupMessageHandlers(deps: MessageHandlerDeps): void {
  // ctx 在 assembler/authorizer 创建后填充；转发箭头只在事件触发时读它。
  // 所有决策逻辑都在模块级 handler 中，本函数只做注册，圈复杂度保持最低。
  // 循环初始化：两个实例的回调捕获 ctx，而 ctx 又需要这两个实例，无法在
  // 声明处一次性初始化；回调只在事件到达时执行，那时填充早已完成。
  // eslint-disable-next-line prefer-const
  let ctx: HandlerContext;
  const assembler = new InboundTurnAssembler({
    onCommit: (turn, prompt) => handleTurnCommit(ctx, turn, prompt),
    onReceipt: (receiptCtx, text) => handleTurnReceipt(ctx, receiptCtx, text),
  });
  deps.router.setInboundFlusher(() => assembler.flushAll('flush'));

  const authorizer = new InboundAuthorizer({
    binder: deps.binder,
    onBind: (userId, chatId) => handleBind(ctx, userId, chatId),
  });

  ctx = { ...deps, assembler, authorizer };

  deps.connector.setInboundMediaDetectedHandler((msg) => handleInboundMedia(ctx, msg));
  deps.connector.setMessageHandler((msg) => handleInboundMessage(ctx, msg));
  deps.connector.setCardActionHandler((action) => handleCardAction(ctx, action));
}
