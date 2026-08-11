/**
 * OpencodeExecRunner: spawn-per-message runner using `opencode run --format json --auto`.
 *
 * Architecture:
 * - Each `run()` spawns a fresh `opencode run` process, writes prompt to stdin,
 *   reads ndjson from stdout, translates to AgentEvent via OpencodeExecTranslator.
 * - No singleton, no long-lived process, no HTTP server, no approval handshake.
 * - Structurally identical to other exec runners (spawn-per-message + ProcessStopper + SpawnHeartbeat).
 *
 * The entire spawn + completion + cleanup orchestration is inherited
 * from SpawningRunner. This subclass overrides only the 5 hooks:
 *   - getStdio()              → ['pipe','pipe','pipe'] (writes prompt to stdin)
 *   - getSpawnEnv(opts)       → sync PWD=opts.cwd (opencode reads PWD, not cwd)
 *   - setupStdin(proc, msg)   → proc.stdin.end(msg, 'utf-8')
 *   - handleBadStreamLine()   → empty override (silently skip non-JSON lines)
 *   - createTranslator(opts)  → new OpencodeExecTranslator({ cwd: opts.cwd })
 *
 * Key invariants:
 * 1. argv includes `--auto` (root cause ①).
 * 2. stdin is written once via `stdin.end(prompt)` and never written again (root cause ②).
 * 3. Translator parse failures → return [] (no event), never throw, never write back (root cause ②).
 * 4. Stream ending early → finish() yields terminal event, never leaves consumer waiting (root cause ③).
 *
 * Verified (2026-07-13): opencode run reads prompt from stdin.
 * Command: `echo 'msg' | opencode run --format json --auto`
 * Result: stdout outputs ndjson with step_start → text → step_finish
 */

import type { ChildProcess } from 'node:child_process';
import type { AgentKind, AgentSessionReader, AgentRunner, AgentStatusInfo } from '../types.js';
import type { SpawnOptions } from '../types.js';
import { SpawningRunner, type RunnerTranslator } from '../common/spawning-runner.js';
import { pipeAllStdio, endStdinWithPrompt } from '../common/runner-utils.js';
import { buildOpencodeRunArgs } from './argv.js';
import { OpencodeExecTranslator } from './jsonl.js';

interface OpencodeExecRunnerOptions {
  /** Model override in provider/model format (e.g. 'anthropic/claude-sonnet-4-20250514'). Omitted → opencode config default. */
  model?: string;
  /** Grace period (ms) for SIGTERM→SIGKILL. Default: 5000. */
  stopGraceMs?: number;
  /** Directory for pid files. Default: `~/.lark-remote`. */
  pidDir?: string;
  /** Workspace identifier, scoped into the pid file name so concurrent
   *  workspaces do not share one `<prefix>.pid` (P1-9). */
  workspace: string;
  /** Spawn heartbeat interval (ms). Default: 30_000. */
  spawnHeartbeatMs?: number;
  /** Injected session reader (CLI-based OpencodeSessionReader). */
  sessionReader: AgentSessionReader;
}

export class OpencodeExecRunner extends SpawningRunner implements AgentRunner {
  readonly kind: AgentKind = 'opencode';
  readonly sessionReader: AgentSessionReader;

  private readonly defaultModel?: string;

  constructor(opts: OpencodeExecRunnerOptions) {
    super({
      pidDir: opts.pidDir,
      workspace: opts.workspace,
      stopGraceMs: opts.stopGraceMs,
      spawnHeartbeatMs: opts.spawnHeartbeatMs,
      pidFilePrefix: 'opencode',
      logTag: 'opencode-exec-runner',
    });
    this.binary = 'opencode';
    this.defaultModel = opts.model;
    this.sessionReader = opts.sessionReader;
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: 'opencode',
      model: this.defaultModel ?? '(未配置)',
      provider: this.defaultModel?.split('/')[0],
    };
  }

  protected buildArgv(opts: SpawnOptions): string[] {
    const model = opts.model ?? this.defaultModel;
    return buildOpencodeRunArgs({
      model,
      sessionId: opts.sessionId,
    });
  }

  // --- Hooks ---

  protected getStdio(): ('ignore' | 'pipe')[] {
    // ['pipe','pipe','pipe'] so we can write the prompt to stdin via setupStdin.
    return pipeAllStdio();
  }

  protected getSpawnEnv(opts: SpawnOptions): NodeJS.ProcessEnv {
    // Sync PWD env to opts.cwd: Node spawn's `cwd` option only chdir's the
    // child, it does NOT update the PWD env var (a shell convention).
    // opencode `run` reads PWD (not process.cwd()) for project/directory
    // detection in its 2nd instance phase, so an inherited PWD (e.g. bridge
    // started from "/") would orphan sessions under directory="/" /
    // project=global, making /resume unable to find them.
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    if (opts.cwd) spawnEnv.PWD = opts.cwd;
    return spawnEnv;
  }

  protected setupStdin(proc: ChildProcess, message: string): void {
    // Write prompt once and close (invariant: write once, never again).
    endStdinWithPrompt(proc, message);
  }

  /** Silently skip non-JSON lines from opencode stdout (e.g. warnings). */
  protected handleBadStreamLine(_line: string): void {}

  protected createTranslator(opts: SpawnOptions): RunnerTranslator {
    // Fresh translator per run. Pass opts.cwd so the synthesized
    // SystemInitEvent carries the session's real directory (the bridge
    // persists this into last-session.json).
    return new OpencodeExecTranslator({ cwd: opts.cwd });
  }
}
