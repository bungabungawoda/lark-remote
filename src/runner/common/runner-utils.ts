import type { ChildProcess } from 'node:child_process';
import type { AgentEvent } from '../types.js';

/**
 * Return the stdio config ['pipe','pipe','pipe'] used by runners that need
 * to write the prompt to the child's stdin (codex/opencode).
 */
export function pipeAllStdio(): ('ignore' | 'pipe')[] {
  return ['pipe', 'pipe', 'pipe'];
}

/**
 * Write the prompt message to the child's stdin and close it.
 * Used by codex/opencode runners which pass the prompt via stdin
 * rather than argv.
 */
export function endStdinWithPrompt(proc: ChildProcess, message: string): void {
  const stdin = proc.stdin;
  if (!stdin) return;

  // Guard against async EPIPE: proc.stdin.end() may emit an 'error' event
  // asynchronously after the call returns (the child may have already exited),
  // which the synchronous try/catch below cannot catch.
  // Check for .once availability — in test environments stdin may be a mock
  // object that lacks EventEmitter methods.
  if (typeof stdin.once === 'function') {
    stdin.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        // Child exited before we could write — not an error, just a race.
      } else {
        // Re-throw unexpected errors so they surface as unhandled-exception
        // rather than being silently swallowed by the EventEmitter default handler.
        throw err;
      }
    });
  }

  try {
    stdin.end(message, 'utf-8');
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'EPIPE'
    ) {
      // Child exited before we could write — not an error, just a race.
    } else {
      throw err;
    }
  }
}

/**
 * Build a synthetic system.init event for pre-spawn failure paths.
 *
 * When the runner exits before spawning a process (validateBeforeRun failure,
 * ENOENT spawn failure), no real system.init arrives from stdout. Without a
 * synthetic init, the bridge's pre-init result guard (§9.22) and the run-state
 * reducer's sessionId check would silently drop the error result, leaving the
 * card showing "输出流已结束，但未收到 result 事件" instead of the actual
 * error message. The synthetic init satisfies both guards so the real error
 * result is processed normally.
 */
export function syntheticInitEvent(sessionId = ''): AgentEvent {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: '',
    model: '',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a standardized auth/error result event for yield.
 *
 * Used by CodexExecRunner and OpencodeExecRunner when initialization or request
 * sending fails (e.g. not logged in, session creation failed). Produces a
 * `result`/`error` event so the bridge can render a card instead of crashing.
 */
export function authErrorEvent(errorMessage: string, sessionId = ''): AgentEvent {
  return {
    type: 'result',
    subtype: 'error',
    session_id: sessionId,
    errorMessage,
    timestamp: new Date().toISOString(),
  };
}
