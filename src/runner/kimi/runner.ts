import type { ChildProcess } from 'node:child_process';
import { getLogger } from '../../logger/index.js';
import { SpawningRunner, type RunnerTranslator } from '../common/spawning-runner.js';
import type { AgentRunner, AgentSessionReader, SpawnOptions, AgentStatusInfo } from '../types.js';
import { KimiTranslator } from './jsonl.js';

/**
 * Timeout (ms) for kimi's spawn-error race and completion race. Kimi's CLI
 * sometimes hangs after stdout closes or fails silently without an 'error'
 * event; both hooks race against this timeout to avoid blocking the runner
 * forever. Same value for both because they protect the same failure mode
 * (silent hang). Clean Code P3-1 (G25 Magic Numbers).
 */
const KIMI_TIMEOUT_MS = 5000;

// --- KimiRunner ---

interface KimiRunnerConfig {
  model?: string;
  thinkingEffort?: string;
  stopGraceMs?: number;
  pidDir?: string;
  workspace: string;
  spawnHeartbeatMs?: number;
  sessionReader?: AgentSessionReader;
  /** Completion timeout (ms). Default: 5000. Injectable for testing. */
  completionTimeoutMs?: number;
}

/**
 * KimiRunner: spawn-per-message runner using `kimi -p <prompt> --output-format stream-json`.
 *
 * Inherits the spawn + completion + cleanup orchestration from SpawningRunner.
 * This subclass overrides only:
 *   - buildArgv(opts)         → kimi-specific flags (-p/--output-format/thinkingEffort)
 *   - createTranslator(opts)  → new KimiTranslator({ cwd: opts.cwd, model })
 *   - awaitCompletion(proc, p) → 5s timeout race + SIGKILL fallback (kimi hangs after
 *     stdout closes)
 *
 * The spawn-error 5s race lives in the base class (awaitSpawnError), shared by all
 * 5 runners — kimi no longer overrides it. The completion 5s race MUST remain here
 * (pinned by source-grep anchor tests/anchor/kimi/kimi-runner-stream-error.test.ts
 * which checks for `Promise.race` and `timeout` strings in this file).
 */
export class KimiRunner extends SpawningRunner implements AgentRunner {
  readonly kind = 'kimi' as const;
  readonly sessionReader: AgentSessionReader;

  private defaultModel: string;
  private thinkingEffort: string;
  private readonly completionTimeoutMs: number;

  constructor(opts: KimiRunnerConfig) {
    super({
      pidDir: opts.pidDir,
      workspace: opts.workspace,
      stopGraceMs: opts.stopGraceMs,
      spawnHeartbeatMs: opts.spawnHeartbeatMs,
      pidFilePrefix: 'kimi',
      logTag: 'kimi-runner',
    });
    this.binary = 'kimi';
    this.defaultModel = opts.model ?? 'kimi-code/k3';
    this.thinkingEffort = opts.thinkingEffort ?? 'max';
    this.completionTimeoutMs = opts.completionTimeoutMs ?? KIMI_TIMEOUT_MS;
    this.sessionReader = opts.sessionReader ?? {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    };
  }

  get pid(): number | undefined {
    return this.currentProcess?.pid;
  }

  getStatusInfo(): AgentStatusInfo {
    return {
      kind: 'kimi',
      model: this.defaultModel,
      reasoning: this.thinkingEffort,
    };
  }

  protected buildArgv(opts: SpawnOptions): string[] {
    // kimi 0.26+ 的 -p 非交互模式与 --auto/--yolo 互斥，不能传权限 flag。
    const args = ['-p', this.currentMessage, '--output-format', 'stream-json'];
    if (opts.sessionId) args.push('-r', opts.sessionId);
    if (this.defaultModel) args.push('-m', this.defaultModel);
    return args;
  }

  // --- Hooks ---

  protected createTranslator(opts: SpawnOptions): RunnerTranslator {
    // Fresh translator per run. Pass opts.cwd and defaultModel so the
    // synthesized SystemInitEvent carries the session's real directory
    // and model name (the bridge persists these into last-session.json).
    return new KimiTranslator({ cwd: opts.cwd, model: this.defaultModel });
  }

  protected async awaitCompletion(
    proc: ChildProcess,
    completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    // kimi sometimes hangs after stdout closes — race completion against a
    // 5s timeout, then force SIGKILL if still running. Pinned by source-grep
    // anchor (tests/anchor/kimi/kimi-runner-stream-error.test.ts).
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return { code: proc.exitCode, signal: proc.signalCode };
    }

    const result = await Promise.race([
      completion,
      new Promise<{ timeout: true }>((resolve) =>
        setTimeout(() => resolve({ timeout: true }), this.completionTimeoutMs),
      ),
    ]);

    if ('timeout' in result) {
      getLogger().warn(`[kimi-runner] completion timeout, force stopping`);
      // P1-12: 只杀组长会让组内子进程 reparent 成孤儿。复用 ProcessStopper 的
      // immediate 组杀（与 exit/cleanup/killOrphan 语义一致）。
      try {
        await this.stopper.stop(proc, { immediate: true });
      } catch {
        // Process may have already exited
      }
      return { code: null, signal: 'SIGKILL' };
    }

    return result;
  }
}
