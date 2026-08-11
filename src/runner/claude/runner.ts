/**
 * Claude Runner 实现
 *
 * 从 runner/index.ts 提取的 ClaudeRunner 类
 */
import { ClaudeSessionReader } from '../../session/claude/index.js';
import {
  type AgentEvent,
  type SpawnOptions,
  type AgentSessionReader,
  type AgentRunner as IAgentRunner,
  type AgentStatusInfo,
} from '../types.js';
import { SpawningRunner } from '../common/spawning-runner.js';
import { MODEL_ID_TO_ALIAS } from '../../config/index.js';

/**
 * Claude Agent Runner
 *
 * 使用 Claude Code CLI (claude) 作为后端 AI 代理
 */
export class ClaudeRunner extends SpawningRunner implements IAgentRunner {
  readonly kind = 'claude' as const;
  readonly sessionReader: AgentSessionReader;

  private defaultModel: string;
  private defaultEffort: string;
  private defaultSettings?: string;

  constructor(opts: {
    model?: string;
    effort?: string;
    settings?: string;
    stopGraceMs?: number;
    pidDir?: string;
    workspace: string;
    spawnHeartbeatMs?: number;
    sessionReader?: AgentSessionReader;
  }) {
    super({
      pidDir: opts.pidDir,
      workspace: opts.workspace,
      stopGraceMs: opts.stopGraceMs,
      spawnHeartbeatMs: opts.spawnHeartbeatMs,
      pidFilePrefix: 'claude',
      logTag: 'claude-runner',
    });
    this.binary = 'claude';
    this.defaultModel = opts.model ?? 'claude-opus-4-8';
    this.defaultEffort = opts.effort ?? 'medium';
    this.defaultSettings = opts.settings;
    this.sessionReader = opts.sessionReader ?? new ClaudeSessionReader();
  }

  get pid(): number | undefined {
    return this.currentProcess?.pid;
  }

  getStatusInfo(): AgentStatusInfo {
    const alias = MODEL_ID_TO_ALIAS[this.defaultModel] ?? this.defaultModel;
    const isHaiku = this.defaultModel.includes('haiku');
    return {
      kind: 'claude',
      model: alias,
      reasoning: isHaiku ? 'off' : this.defaultEffort,
    };
  }

  protected buildArgv(opts: SpawnOptions): string[] {
    const args = [
      '-p',
      this.currentMessage,
      '--output-format',
      'stream-json',
      '--verbose',
      // Hardcoded: Feishu chat doesn't support interactive approval.
      '--permission-mode',
      'bypassPermissions',
    ];

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    const effort = opts.effort ?? this.defaultEffort;
    if (effort) {
      args.push('--effort', effort);
    }

    const settings = opts.settings ?? this.defaultSettings;
    if (settings) {
      args.push('--settings', settings);
    }

    return args;
  }

  protected translate(rawEvent: unknown, _ctx: unknown): AgentEvent | AgentEvent[] | null {
    const event = rawEvent as AgentEvent;
    // 统一方案：所有 runner 自己生成 timestamp
    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }
    return event;
  }
}
