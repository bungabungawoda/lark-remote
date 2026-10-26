import { DEFAULT_APPROVAL_TIMEOUT_MS, type AppConfig } from '../config/index.js';
import type { AgentKind, Runner } from '../runner/index.js';
import type { RunCardSession } from '../card/run-card-session.js';
import { ApprovalCoordinator } from './approval-coordinator.js';
import { getLogger } from '../logger/index.js';
import { errorMessage } from './final-usage.js';

export function remindPendingApproval(
  connector: {
    removeReactionByEmoji(messageId: string, emoji: string): Promise<void>;
    addReaction(messageId: string, emoji: string): Promise<void>;
  },
  messageId: string,
  runId: string,
): void {
  void (async () => {
    try {
      await connector.removeReactionByEmoji(messageId, 'Typing');
    } catch (err) {
      getLogger().warn(
        `[lark-remote] remove Typing reaction failed runId=${runId}: ${errorMessage(err)}`,
      );
    }
    try {
      await connector.addReaction(messageId, 'Typing');
    } catch (err) {
      getLogger().warn(
        `[lark-remote] re-add Typing reaction failed runId=${runId}: ${errorMessage(err)}`,
      );
    }
  })();
}

export function createRunApprovalCoordinator(opts: {
  runner: Runner;
  cardSession: RunCardSession;
  config: AppConfig;
  runId: string;
  agentKind: AgentKind;
}): ApprovalCoordinator {
  return new ApprovalCoordinator({
    approvalTimeoutMs:
      opts.agentKind === 'claude'
        ? (opts.config.claude?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS)
        : DEFAULT_APPROVAL_TIMEOUT_MS,
    responder: async (requestId, response) => {
      const runner = opts.runner as Runner & {
        respondApproval?: (id: number | string, value: unknown) => Promise<void>;
      };
      if (typeof runner.respondApproval === 'function') {
        await runner.respondApproval(requestId, response);
      }
    },
    interruptTurn: async () => {
      await opts.runner.stop();
    },
    pushToCard: async (events) => {
      for (const event of events) await opts.cardSession.push(event);
    },
  });
}
