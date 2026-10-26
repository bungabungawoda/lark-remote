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
import { InboundTurnAssembler } from './inbound/turn-assembler.js';
import { InboundAuthorizer } from './inbound/authorize.js';
import { stripPlaceholders } from './inbound/placeholder.js';
import type { MediaOutcome } from './inbound/turn.js';
import { agentDisplayName } from './card/card-shared.js';
import { sleep } from './common/sleep.js';
import { bestEffortUnlink } from './common/fs.js';
import { dispatchOrderExecForQueue } from './router/order-exec-dispatch.js';
import { buildCardActionFullValue } from './router/card-action-payload.js';
import { actionFeedbackText } from './router/card-action-feedback.js';

const SESSION_MUTATING_FLUSH_BUDGET_MS = 2_000;

/**
 * /stop 命令别名单源：普通消息的停止分支与 clone 活跃期拦截的排除条件
 * 共用同一判定，防止将来加别名时两处漂移。
 */
export function isStopCommand(text: string): boolean {
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

export function setupMessageHandlers(deps: MessageHandlerDeps): void {
  const {
    connector,
    router,
    bridge,
    sessionStore,
    workspaceStore,
    binder,
    logger,
    config,
    cloneSession,
  } = deps;

  // 入站统一装配器：图/文任意顺序 → 同一个 turn、同一个 prompt。
  const assembler = new InboundTurnAssembler({
    onCommit: (turn, prompt) => {
      const messageId = turn.messageIds[turn.messageIds.length - 1] ?? '';
      const ctx = {
        userId: turn.userId,
        chatId: turn.chatId,
        messageId,
        turnMessageIds: turn.messageIds,
      };
      let cwd = sessionStore.getCwd(turn.userId) ?? '';
      if (!cwd) {
        const recent = [...workspaceStore.list()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        if (recent.length > 0) cwd = recent[0].path;
      }
      const binding = bridge.currentBinding(turn.userId);
      bridge.enqueue(
        cwd,
        async () => {
          await router.handle(prompt, ctx, {
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
    },
    onReceipt: async (ctx, text) => {
      await bridge.sendResult({ text }, ctx);
    },
  });
  router.setInboundFlusher(() => assembler.flushAll('flush'));

  const authorizer = new InboundAuthorizer({
    binder,
    onBind: (userId, chatId) => {
      let resolvedCwd: string;
      try {
        resolvedCwd = fs.realpathSync(process.cwd());
      } catch {
        resolvedCwd = process.cwd();
      }
      if (!sessionStore.getCwd(userId)) {
        sessionStore.setCwd(userId, resolvedCwd);
      }

      return (async () => {
        try {
          await connector.sendWithRetry(chatId, {
            text:
              `✅ 已绑定到本账号，此后仅你可使用本应用\n` +
              `📂 当前工作目录: \`${resolvedCwd}\`\n` +
              `🤖 默认 Agent: ${agentDisplayName(config.defaultAgent)}\n` +
              `💡 直接输入消息即可开始对话，或 /cd 切换目录`,
          });
          const helpResult = router.cmdHelp();
          if (helpResult.card) {
            await connector.sendWithRetry(chatId, { card: helpResult.card });
          }
        } catch (err) {
          logger.error('[binder] onboarding send failed:', err);
        }
      })();
    },
  });

  connector.setInboundMediaDetectedHandler((msg) => {
    const authorization = authorizer.authorize(msg.userId, msg.chatId);
    if (authorization === 'rejected') {
      logger.warn(`[media] rejected inbound media from non-owner ${msg.userId}`);
      return;
    }
    if (cloneSession.isActive()) {
      logger.info(`[media] dropped inbound media during clone session ${msg.messageId}`);
      return;
    }
    if (!router.config.inboundMedia.enabled) {
      assembler.ingest({
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
      const payload = await connector.downloadInboundMedia(msg, {
        maxFileSizeMb: router.config.inboundMedia.maxFileSizeMb,
      });
      try {
        return await bridge.saveInboundMedia(payload);
      } catch (err) {
        for (const item of payload.media) bestEffortUnlink(item.tempPath);
        throw err;
      }
    })();
    assembler.ingest({
      kind: 'media',
      userId: msg.userId,
      chatId: msg.chatId,
      messageId: msg.messageId,
      replyToMessageId: msg.replyToMessageId,
      rawContentType: msg.rawContentType,
      outcome,
    });
  });

  connector.setMessageHandler((msg) => {
    const decision = authorizer.authorize(msg.userId, msg.chatId);
    if (decision === 'rejected' || decision === 'bind_success') return;

    logger.info(`message from ${msg.userId} (${msg.rawContentType}): ${msg.content.slice(0, 100)}`);
    void connector.addReaction(msg.messageId, 'Typing');

    if (cloneSession.isActive() && !isStopCommand(msg.content)) {
      void cloneSession
        .handleMessage(msg.content, {
          userId: msg.userId,
          chatId: msg.chatId,
          messageId: msg.messageId,
        })
        .catch((err: unknown) => logger.error('[clone] message handling failed:', err));
      return;
    }

    const content = router.expandAliasMessage(msg.content);
    if (isStopCommand(content)) {
      void (async () => {
        const interrupt = await bridge.interruptCurrentRunDetailed({
          userId: msg.userId,
          chatId: msg.chatId,
        });
        const ctx = { userId: msg.userId, chatId: msg.chatId, messageId: msg.messageId };
        if (!interrupt.stopped) {
          await bridge.sendResult({ text: '当前没有运行中的进程' }, ctx);
        } else if ((interrupt.stoppedCount ?? 1) > 1) {
          await bridge.sendResult(
            { text: `✅ 已停止 ${interrupt.stoppedCount} 个运行中的任务` },
            ctx,
          );
        }
      })().catch((err: unknown) => logger.error('[control] /stop failed:', err));
      return;
    }

    const stripped = stripPlaceholders(content);
    if (stripped.unknownTags.length > 0) {
      logger.warn(
        `[inbound] unknown placeholder tags stripped: ${stripped.unknownTags.join(', ')} ` +
          `(msg_type=${msg.rawContentType})`,
      );
    }
    const commandEligible =
      msg.rawContentType === 'text' && stripped.kinds.length === 0 && stripped.clean !== '';

    if (commandEligible && (stripped.clean.startsWith('/') || stripped.clean.startsWith('!'))) {
      void (async () => {
        await assembler.flush(msg.userId, msg.chatId, 'flush');
        await router.handle(
          stripped.clean,
          {
            userId: msg.userId,
            chatId: msg.chatId,
            messageId: msg.messageId,
          },
          { allowCommandPrefix: true },
        );
      })().catch((err: unknown) => logger.error('[control] command failed:', err));
      return;
    }

    assembler.ingest({
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
  });

  connector.setCardActionHandler(async (action) => {
    if (!binder.isOwner(action.operator.openId)) {
      binder.recordRejectedCardAction(action.operator.openId);
      return;
    }

    const actionValue = action.action.value as CardActionPayload | undefined;
    if (!actionValue?.cmd) return;

    logger.info(`card action: ${actionValue.cmd}`);

    const userId = action.operator.openId;
    const chatId = action.chatId;
    const messageId = action.messageId;
    void connector.addReaction(messageId, 'Typing');

    if (actionValue.cmd === 'stop') {
      void router
        .handleCardAction({ ...actionValue, cmd: 'stop' }, { userId, chatId, messageId })
        .catch((err: unknown) => logger.error('[control] card stop failed:', err));
      return;
    }

    const isImmediate = isImmediateAction(actionValue.cmd);
    const cwd = sessionStore.getCwd(userId) ?? '';
    const fullValue = buildCardActionFullValue(actionValue, action);

    if (SESSION_MUTATING_ACTION_CMDS.has(actionValue.cmd)) {
      const flushP = assembler
        .flush(userId, chatId, 'flush')
        .catch((err: unknown) => logger.error('[control] inbound flush failed:', err));
      await Promise.race([flushP, sleep(SESSION_MUTATING_FLUSH_BUDGET_MS)]);
    }

    if (DIRECT_RETURN_CMDS.has(actionValue.cmd)) {
      return router.handleCardAction(fullValue, { userId, chatId, messageId });
    }

    if (actionValue.cmd === 'order.exec') {
      void dispatchOrderExecForQueue({
        router,
        bridge,
        cwd,
        orderId: actionValue.orderId,
        ctx: { userId, chatId, messageId },
      }).catch((err: unknown) => logger.error('[control] order.exec dispatch failed:', err));
      return;
    }

    const forwardActionFeedback = (res: unknown) => {
      const text = actionFeedbackText(res);
      if (!text) return;
      void bridge
        .sendResult({ text }, { userId, chatId, messageId })
        .catch((err: unknown) => logger.error('[control] card action feedback failed:', err));
    };

    if (isImmediate) {
      bridge.enqueueImmediate(cwd, async () => {
        const res = await router.handleCardAction(fullValue, { userId, chatId, messageId });
        forwardActionFeedback(res);
      });
    } else {
      bridge.enqueue(
        cwd,
        async () => {
          const res = await router.handleCardAction(fullValue, { userId, chatId, messageId });
          forwardActionFeedback(res);
        },
        {
          taskMeta: {
            userId,
            chatId,
            messageId: router.mintQueueTaskKey('card', actionValue.cmd),
            feishuReplyTo: messageId,
            messagePreview: `card action: ${actionValue.cmd}`,
            kind: COMPACT_ACTION_CMDS.has(actionValue.cmd) ? 'compact' : 'command',
            editable: !COMPACT_ACTION_CMDS.has(actionValue.cmd),
          },
        },
      );
    }
  });
}
