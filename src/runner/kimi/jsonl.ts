import type { RunnerTranslator } from '../common/spawning-runner.js';
import type { AgentEvent } from '../types.js';

// --- Kimi JSON event types ---

interface KimiMetaEvent {
  role: 'meta';
  type: 'session.resume_hint';
  session_id: string;
  command: string;
  content: string;
}

interface KimiAssistantEvent {
  role: 'assistant';
  content?: string;
  tool_calls?: Array<{
    type: 'function';
    id: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface KimiToolResultEvent {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

type KimiEvent =
  | KimiMetaEvent
  | KimiAssistantEvent
  | KimiToolResultEvent
  | { role: string; [key: string]: unknown };

// --- Tool name normalization (Kimi uses lowercase) ---

const TOOL_NAME_MAP: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  bash: 'Bash',
  websearch: 'WebSearch',
  fetchurl: 'FetchURL',
  skill: 'Skill',
  tasklist: 'TaskList',
  taskoutput: 'TaskOutput',
  taskstop: 'TaskStop',
  todolist: 'TodoList',
  croncreate: 'CronCreate',
  crondelete: 'CronDelete',
  cronlist: 'CronList',
  enterplanmode: 'EnterPlanMode',
  exitplanmode: 'ExitPlanMode',
  getgoal: 'GetGoal',
  setgoalbudget: 'SetGoalBudget',
  updategoal: 'UpdateGoal',
  readmediafile: 'ReadMediaFile',
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

// --- KimiTranslator ---

/**
 * Translates kimi `--output-format stream-json` ndjson into lark-remote
 * AgentEvents. Stateful: captures sessionId from the first meta event so
 * the synthesized SystemInitEvent carries the correct session_id.
 *
 * Implements RunnerTranslator so the base SpawningRunner can drive it
 * uniformly. kimi has no agent-reported terminal error (no equivalent of
 * codex `turn.failed`), so isTerminal/finish/getTerminalError/
 * hasAgentTerminalError are no-ops — kimi relies entirely on the base
 * class's signal/code-based result event classification.
 */
export class KimiTranslator implements RunnerTranslator {
  private readonly cwd: string;
  private readonly model: string;
  private sessionId: string | undefined;

  constructor(opts: { cwd: string; model: string }) {
    this.cwd = opts.cwd;
    this.model = opts.model;
  }

  translate(raw: unknown): AgentEvent | AgentEvent[] | null {
    const rawEvent = raw as KimiEvent;

    // Handle meta events (session.resume_hint) — emit system.init so the
    // bridge can sync sessionStore with the new sessionId. Without this,
    // the bridge never learns the sessionId and auto-resume silently fails.
    if (rawEvent.role === 'meta' && (rawEvent as KimiMetaEvent).type === 'session.resume_hint') {
      const metaEvent = rawEvent as KimiMetaEvent;
      this.sessionId = metaEvent.session_id;
      return {
        type: 'system',
        subtype: 'init',
        session_id: metaEvent.session_id,
        cwd: this.cwd,
        model: this.model,
        timestamp: new Date().toISOString(),
      };
    }

    if (rawEvent.role === 'assistant') {
      const assistantEvent = rawEvent as KimiAssistantEvent;
      const events: AgentEvent[] = [];

      // Text content - yield immediately (Kimi sends complete content per message)
      if (assistantEvent.content) {
        events.push({
          type: 'assistant',
          message: { content: [{ type: 'text', text: assistantEvent.content }] },
          timestamp: new Date().toISOString(),
        });
      }

      // Tool calls - emit as separate events
      if (assistantEvent.tool_calls && assistantEvent.tool_calls.length > 0) {
        for (const tc of assistantEvent.tool_calls) {
          let argsObj: Record<string, unknown> = {};
          try {
            argsObj = JSON.parse(tc.function.arguments);
          } catch {
            // Use empty object if parse fails
          }

          events.push({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: tc.id,
                  name: normalizeToolName(tc.function.name),
                  input: argsObj,
                },
              ],
            },
            timestamp: new Date().toISOString(),
          });
        }
      }

      return events.length > 0 ? events : null;
    }

    if (rawEvent.role === 'tool') {
      const toolEvent = rawEvent as KimiToolResultEvent;
      return {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolEvent.tool_call_id,
              content: toolEvent.content,
              is_error: false,
            },
          ],
        },
        timestamp: new Date().toISOString(),
      };
    }

    return null;
  }

  isTerminal(): boolean {
    // kimi has no terminal event — the base class's result event is the terminal.
    return false;
  }

  finish(_reason: 'failed' | 'interrupted' | 'timeout'): void {
    // No-op: kimi has no stream-ended-early terminal error to record.
  }

  getTerminalError(): string | undefined {
    // Always undefined — kimi has no agent-reported terminal error.
    return undefined;
  }

  hasAgentTerminalError(): boolean {
    // Always false — kimi has no agent-reported terminal error.
    return false;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }
}
