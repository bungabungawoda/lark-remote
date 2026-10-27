import type { AgentKind } from '../agent-kinds.js';
import type { TurnStartedEvent } from '../runner/index.js';
import type { SessionStore } from '../session/index.js';
import { getLogger } from '../logger/index.js';

interface InitEvent {
  session_id: string;
  cwd?: string;
}

export interface WritebackContext {
  sessionStore: SessionStore;
  userId: string;
  agentKind: AgentKind;
  cwd: string;
  sessionEpochAtStart: number;
  runId: string;
}

function pointerMoved(ctx: WritebackContext): boolean {
  return ctx.sessionStore.getSessionEpoch(ctx.userId, ctx.agentKind) !== ctx.sessionEpochAtStart;
}

export function writeBackInitSession(ctx: WritebackContext, event: InitEvent): void {
  if (pointerMoved(ctx)) {
    getLogger().info(
      `[lark-remote] system.init write-back skipped: session pointer moved since run start runId=${ctx.runId} sessionId=${event.session_id}`,
    );
    return;
  }

  const eventCwd = typeof event.cwd === 'string' ? event.cwd : '';
  const hasCwd = !!ctx.sessionStore.getCwd(ctx.userId);
  const realCwd = eventCwd.length > 0 ? eventCwd : ctx.cwd;
  if (hasCwd && eventCwd && eventCwd !== ctx.cwd) {
    getLogger().info(`[lark-remote] system.init: cwd=${ctx.cwd}, session cwd=${eventCwd}`);
    ctx.sessionStore.setSessionIdAndSessionCwd(
      ctx.userId,
      ctx.agentKind,
      event.session_id,
      realCwd,
    );
    return;
  }

  const bootstrapSessionCwd = !hasCwd && eventCwd.length > 0 ? eventCwd : undefined;
  ctx.sessionStore.setSessionIdAndCwd(
    ctx.userId,
    ctx.agentKind,
    event.session_id,
    realCwd,
    bootstrapSessionCwd,
  );
}

export function writeBackTurnStarted(ctx: WritebackContext, event: TurnStartedEvent): boolean {
  if (pointerMoved(ctx)) {
    getLogger().info(
      `[lark-remote] turn_started write-back skipped: session pointer moved since run start runId=${ctx.runId} sessionId=${event.threadId}`,
    );
    return false;
  }
  ctx.sessionStore.setSessionIdAndCwd(ctx.userId, ctx.agentKind, event.threadId, ctx.cwd);
  getLogger().info(
    `[lark-remote] turn_started session write-back runId=${ctx.runId} sessionId=${event.threadId}`,
  );
  return true;
}

export function writeBackResultSession(ctx: WritebackContext, sessionId: string | undefined): void {
  if (!sessionId || pointerMoved(ctx)) return;
  ctx.sessionStore.setSessionIdAndCwd(ctx.userId, ctx.agentKind, sessionId, ctx.cwd);
  getLogger().info(
    `[lark-remote] result session write-back runId=${ctx.runId} sessionId=${sessionId}`,
  );
}
