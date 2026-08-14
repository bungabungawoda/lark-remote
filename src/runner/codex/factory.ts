/**
 * Codex runner factory: selects the concrete runner based on `serviceMode`.
 *
 * `exec` (default) → CodexExecRunner (spawn-per-message `codex exec`).
 * `app-server` → CodexAppServerRunner (persistent `codex app-server` JSON-RPC
 * connection with approval support and sandbox enforcement).
 */

import type { AgentSessionReader } from '../types.js';
import { CodexExecRunner } from './runner.js';
import { CodexAppServerRunner } from './app-server/runner.js';
import type { AskForApproval, SandboxMode } from './app-server/protocol-types.js';

export interface CreateCodexRunnerOptions {
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  stopGraceMs?: number;
  pidDir: string;
  workspace: string;
  sessionReader: AgentSessionReader;
  serviceMode?: 'exec' | 'app-server';
  sandbox?: SandboxMode;
  approvalPolicy?: AskForApproval;
  appServerBinary?: string;
  appServerArgs?: string[];
  appServerRequestTimeoutMs?: number;
  appServerIdleTtlMs?: number;
  appServerTurnIdleTimeoutMinutes?: number;
}

export function createCodexRunner(
  opts: CreateCodexRunnerOptions,
): CodexExecRunner | CodexAppServerRunner {
  if (opts.serviceMode === 'app-server') {
    return new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: opts.sessionReader,
      binary: opts.appServerBinary ?? 'codex',
      appServerArgs: opts.appServerArgs,
      requestTimeoutMs: opts.appServerRequestTimeoutMs,
      idleTtlMs: opts.appServerIdleTtlMs,
      turnTimeoutMs:
        opts.appServerTurnIdleTimeoutMinutes != null
          ? opts.appServerTurnIdleTimeoutMinutes * 60_000
          : undefined,
      model: opts.model,
      modelProvider: opts.modelProvider,
      reasoningEffort: opts.reasoningEffort,
      sandbox: opts.sandbox,
      approvalPolicy: opts.approvalPolicy,
    });
  }
  return new CodexExecRunner({
    model: opts.model,
    modelProvider: opts.modelProvider,
    reasoningEffort: opts.reasoningEffort,
    stopGraceMs: opts.stopGraceMs,
    pidDir: opts.pidDir,
    workspace: opts.workspace,
    sessionReader: opts.sessionReader,
  });
}
