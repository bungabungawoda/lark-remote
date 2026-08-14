/**
 * CodexExecRunner: spawn-per-message runner using `codex exec --json`.
 *
 * Architecture:
 * - Each `run()` spawns a fresh `codex exec` process, writes prompt to stdin,
 *   reads ndjson from stdout, translates to AgentEvent via CodexExecTranslator.
 * - No singleton, no long-lived process, no JSON-RPC, no approval handshake.
 * - Structurally identical to ClaudeRunner (spawn-per-message + ProcessStopper + SpawnHeartbeat).
 *
 * The entire spawn + completion + cleanup orchestration is inherited
 * from SpawningRunner. This subclass overrides only the 5 hooks:
 *   - getStdio()              → ['pipe','pipe','pipe'] (writes prompt to stdin)
 *   - setupStdin(proc, msg)   → proc.stdin.end(msg, 'utf-8')
 *   - handleBadStreamLine()   → empty override (silently skip non-JSON lines)
 *   - createTranslator(opts)  → new CodexExecTranslator()
 *   - validateBeforeRun(opts) → API key check (yields error result if missing)
 *
 * Key invariants:
 * 1. argv includes `approval_policy="never"` (root cause ①).
 * 2. stdin is written once via `stdin.end(prompt)` and never written again (root cause ②).
 * 3. Translator parse failures → return [] (no event), never throw, never write back (root cause ②).
 * 4. Stream ending early → finish() yields terminal event, never leaves consumer waiting (root cause ③).
 */

import type { ChildProcess } from 'node:child_process';
import type {
  AgentKind,
  AgentSessionReader,
  AgentEvent,
  AgentRunner,
  AgentStatusInfo,
} from '../types.js';
import type { SpawnOptions } from '../types.js';
import { SpawningRunner, type RunnerTranslator } from '../common/spawning-runner.js';
import { pipeAllStdio, endStdinWithPrompt } from '../common/runner-utils.js';
import { buildCodexExecArgs } from './argv.js';
import { CodexExecTranslator } from './jsonl.js';
import { loadCodexConfig } from '../../config/codex-config.js';

interface CodexExecRunnerOptions {
  /** Model override. Omitted → codex reads from its config.toml. */
  model?: string;
  /** Model provider override. Omitted → codex reads from its config.toml. */
  modelProvider?: string;
  /** Reasoning effort level: low/medium/high/xhigh/max/ultra */
  reasoningEffort?: string;
  /** Grace period (ms) for SIGTERM→SIGKILL. Default: 5000. */
  stopGraceMs?: number;
  /** Directory for pid files. Default: `~/.lark-remote`. */
  pidDir?: string;
  /** Workspace identifier, scoped into the pid file name so concurrent
   *  workspaces do not share one `<prefix>.pid` (P1-9). */
  workspace: string;
  /** Spawn heartbeat interval (ms). Default: 30_000. */
  spawnHeartbeatMs?: number;
  /** Injected session reader (file-based CodexSessionReader). */
  sessionReader: AgentSessionReader;
}

export class CodexExecRunner extends SpawningRunner implements AgentRunner {
  readonly kind: AgentKind = 'codex';
  readonly sessionReader: AgentSessionReader;

  private readonly defaultModel?: string;
  private readonly modelProvider?: string;
  private readonly reasoningEffort?: string;

  constructor(opts: CodexExecRunnerOptions) {
    super({
      pidDir: opts.pidDir,
      workspace: opts.workspace,
      stopGraceMs: opts.stopGraceMs,
      spawnHeartbeatMs: opts.spawnHeartbeatMs,
      pidFilePrefix: 'codex',
      logTag: 'codex-exec-runner',
    });
    this.binary = 'codex';
    this.defaultModel = opts.model;
    this.modelProvider = opts.modelProvider;
    this.reasoningEffort = opts.reasoningEffort;
    this.sessionReader = opts.sessionReader;
  }

  getStatusInfo(): AgentStatusInfo {
    // If model not explicitly set, fallback to codex config.toml
    let model = this.defaultModel;
    let provider = this.modelProvider;

    if (!model || !provider) {
      try {
        const codexConfig = loadCodexConfig();
        if (!model) {
          model = codexConfig.currentModel;
        }
        if (!provider) {
          provider = codexConfig.currentProvider;
        }
      } catch {
        // Ignore errors reading codex config
      }
    }

    return {
      kind: 'codex',
      model: model ?? '(未配置)',
      provider: provider,
      extras: { sandbox: 'danger-full-access' },
    };
  }

  /** exec 模式的 turn.completed.usage 是会话累计值，flow 字段必须 jsonl 优先
   *  （review P3-7：桥侧统一走本接口，替代 agentKind 硬编码）。 */
  getUsageAuthority(): 'jsonl' {
    return 'jsonl';
  }

  protected buildArgv(opts: SpawnOptions): string[] {
    return buildCodexExecArgs({
      cwd: opts.cwd,
      model: opts.model ?? this.defaultModel,
      modelProvider: this.modelProvider,
      threadId: opts.sessionId,
      reasoningEffort: opts.reasoningEffort ?? this.reasoningEffort,
    });
  }

  // --- Hooks ---

  protected getStdio(): ('ignore' | 'pipe')[] {
    // ['pipe','pipe','pipe'] so we can write the prompt to stdin via setupStdin.
    return pipeAllStdio();
  }

  protected setupStdin(proc: ChildProcess, message: string): void {
    // Write prompt once and close (invariant: write once, never again).
    endStdinWithPrompt(proc, message);
  }

  /** Silently skip non-JSON lines from codex stdout (e.g. warnings). */
  protected handleBadStreamLine(_line: string): void {}

  protected createTranslator(_opts: SpawnOptions): RunnerTranslator {
    // Fresh translator per run (stateful: threadId/terminal/startedTools).
    return new CodexExecTranslator();
  }

  protected validateBeforeRun(opts: SpawnOptions): AgentEvent | null {
    // Pre-spawn API key check: yield an error result and abort run() if the
    // configured provider requires an env var that is not set.
    const provider = this.modelProvider;
    if (!provider) return null;
    try {
      const codexConfig = loadCodexConfig();
      const envKey = codexConfig.providerEnvKeys[provider];
      if (envKey && !process.env[envKey]) {
        return {
          type: 'result',
          subtype: 'error',
          session_id: opts.sessionId ?? '',
          errorMessage: `Provider "${provider}" 需要环境变量 ${envKey}，但该变量未设置。请在系统环境变量或 .env 文件中配置。`,
          timestamp: new Date().toISOString(),
        } as AgentEvent;
      }
    } catch {
      // Ignore config read errors — let codex handle the missing config.
    }
    return null;
  }
}
