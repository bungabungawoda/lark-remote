import type { AgentRunner, AgentSessionReader, SpawnOptions, AgentStatusInfo } from '../types.js';
import { SpawningRunner, type RunnerTranslator } from '../common/spawning-runner.js';
import { PiEventAccumulator } from './jsonl.js';

// --- PiRunner ---

interface PiRunnerConfig {
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  stopGraceMs?: number;
  pidDir?: string;
  workspace: string;
  spawnHeartbeatMs?: number;
  sessionReader?: AgentSessionReader;
}

/**
 * PiRunner: spawn-per-message runner using `pi --mode json -p <prompt> ...`.
 *
 * Inherits the spawn + completion + cleanup orchestration from SpawningRunner.
 * This subclass overrides only the createTranslator()
 * hook to return a PiEventAccumulator (which implements RunnerTranslator).
 * Pi uses the default JSONL stream reader (createJSONLStream) and the default
 * stdio ['ignore','pipe','pipe'] — no stdin writing, no env sync.
 */
export class PiRunner extends SpawningRunner implements AgentRunner {
  readonly kind = 'pi' as const;
  readonly sessionReader: AgentSessionReader;

  private provider: string;
  private defaultModel: string;
  private thinking: string;
  private tools: string[];

  constructor(opts: PiRunnerConfig) {
    super({
      pidDir: opts.pidDir,
      workspace: opts.workspace,
      stopGraceMs: opts.stopGraceMs,
      spawnHeartbeatMs: opts.spawnHeartbeatMs,
      pidFilePrefix: 'pi',
      logTag: 'pi-runner',
    });
    this.binary = 'pi';
    this.provider = opts.provider ?? 'Volcano';
    this.defaultModel = opts.model ?? 'glm-5.2';
    this.thinking = opts.thinking ?? 'medium';
    this.tools = opts.tools ?? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
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
      kind: 'pi',
      model: this.defaultModel,
      provider: this.provider,
      reasoning: this.thinking,
    };
  }

  protected buildArgv(opts: SpawnOptions): string[] {
    const args = [
      '--mode',
      'json',
      '-p',
      this.currentMessage,
      '--provider',
      this.provider,
      '--model',
      opts.model ?? this.defaultModel,
      '--tools',
      this.tools.join(','),
    ];
    if (opts.sessionId) args.push('--session-id', opts.sessionId);
    if (this.thinking && this.thinking !== 'off') args.push('--thinking', this.thinking);
    return args;
  }

  // --- Hooks ---

  protected createTranslator(_opts: SpawnOptions): RunnerTranslator {
    // Fresh accumulator per run (stateful: content buffer, sessionId, lastUsage).
    return new PiEventAccumulator();
  }
}
