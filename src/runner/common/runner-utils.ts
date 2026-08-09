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
