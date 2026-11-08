import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expectRunUsageScope } from '../../../tests/lib/usage-scope-contract.js';
import {
  KimiSessionReader,
  detectSchemaVersion,
  extractWorkDir,
  checkCwdGuard,
  scanKimiUsage,
} from './sessions.js';
import type { KimiSessionState } from './sessions.js';

let tmpDir: string;
let kimiDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-kimi-reader-test-'));
  kimiDir = path.join(tmpDir, '.kimi-code');
  fs.mkdirSync(kimiDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a real directory under tmpDir and return its realpath.
 * macOS has multiple symlink chains (/tmp → /private/tmp, /var → /private/var),
 * so we realpathSync to match production code's fs.realpathSync(cwd) comparisons.
 */
function makeWorkDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/** Write a session index entry */
function addIndexEntry(
  sessionId: string,
  sessionDir: string,
  workDir: string,
  opts?: { omitWorkDir?: boolean },
) {
  const indexPath = path.join(kimiDir, 'session_index.jsonl');
  const entry: Record<string, unknown> = { sessionId, sessionDir };
  if (!opts?.omitWorkDir) {
    entry.workDir = workDir;
  }
  fs.appendFileSync(indexPath, JSON.stringify(entry) + '\n');
}

/** Create a minimal kimi session directory with state.json and wire.jsonl */
function createSession(
  sessionId: string,
  workDir: string,
  opts?: {
    title?: string;
    wireLines?: string[];
    mtimeMs?: number;
    /** state.json schema version: 'v1' uses workDir, 'v2' uses cwd (default: 'v1') */
    stateSchema?: 'v1' | 'v2';
    /** Omit workDir from session_index.jsonl entry (v2 index may lack it) */
    omitIndexWorkDir?: boolean;
    /** Omit title/lastPrompt from state.json (v2 sessions may lack these) */
    omitTitle?: boolean;
  },
) {
  const sessionDir = path.join(kimiDir, 'sessions', sessionId);
  const agentsDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(agentsDir, { recursive: true });

  // Write state.json
  const schema = opts?.stateSchema ?? 'v1';
  const state: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (schema === 'v2') {
    state.version = 2;
    state.cwd = workDir;
    state.createdAt = Date.now();
    state.updatedAt = Date.now();
  } else {
    state.workDir = workDir;
  }
  if (!opts?.omitTitle) {
    state.title = opts?.title ?? 'Test Session';
    state.isCustomTitle = false;
    state.lastPrompt = opts?.title;
  }
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));

  // Write wire.jsonl
  if (opts?.wireLines) {
    fs.writeFileSync(path.join(agentsDir, 'wire.jsonl'), opts.wireLines.join('\n') + '\n');
  } else if (opts?.mtimeMs) {
    // Create an empty wire.jsonl so utimesSync below can set its mtime;
    // without this file, the mtime fallback would use the directory mtime
    // which is non-deterministic when sessions are created in quick succession.
    fs.writeFileSync(path.join(agentsDir, 'wire.jsonl'), '');
  }

  // Set mtime if specified
  if (opts?.mtimeMs) {
    const wirePath = path.join(agentsDir, 'wire.jsonl');
    if (fs.existsSync(wirePath)) {
      const t = opts.mtimeMs / 1000;
      fs.utimesSync(wirePath, t, t);
    }
  }

  // Add to index
  addIndexEntry(sessionId, sessionDir, workDir, { omitWorkDir: opts?.omitIndexWorkDir });

  return sessionDir;
}

describe('KimiSessionReader', () => {
  it('listSessions returns empty for non-existent kimi dir', () => {
    const reader = new KimiSessionReader(path.join(tmpDir, 'no-such-dir'));
    const result = reader.listSessions(makeWorkDir('nonexistent'));
    expect(result.sessions).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('listSessions non-ENOENT failure keeps the exact contract message and the original error as cause', () => {
    // 脏 index 条目（sessionDir 非字符串）→ path.join 抛 TypeError（非 ENOENT）
    // → 必须上抛契约文案（router 靠它展示「列表失败」，静默 [] 与真空不可区分），
    // cause 保留原始错误（throwSessionListError 契约）。
    fs.appendFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'sess-bad', sessionDir: 123 }) + '\n',
    );
    const reader = new KimiSessionReader(kimiDir);

    let thrown: unknown;
    try {
      reader.listSessions(makeWorkDir('project-a'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/^kimi session list 读取失败: /);
    expect((thrown as Error).cause).toBeInstanceOf(TypeError);
  });

  it('listSessions returns sessions for matching workDir', () => {
    const workDir = makeWorkDir('project-a');
    createSession('sess-1', workDir, { title: 'First session' });
    createSession('sess-2', workDir, { title: 'Second session' });

    const reader = new KimiSessionReader(kimiDir);
    const result = reader.listSessions(workDir);
    expect(result.total).toBe(2);
    expect(result.sessions).toHaveLength(2);
  });

  it('listSessions filters by workDir', () => {
    const workDirA = makeWorkDir('project-a');
    const workDirB = makeWorkDir('project-b');
    createSession('sess-a1', workDirA, { title: 'A1' });
    createSession('sess-b1', workDirB, { title: 'B1' });

    const reader = new KimiSessionReader(kimiDir);
    const resultA = reader.listSessions(workDirA);
    expect(resultA.total).toBe(1);
    expect(resultA.sessions[0].sessionId).toBe('sess-a1');
  });

  it('listSessions sorts by mtime descending', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-old', workDir, { title: 'Old', mtimeMs: Date.now() - 60000 });
    createSession('sess-new', workDir, { title: 'New', mtimeMs: Date.now() });

    const reader = new KimiSessionReader(kimiDir);
    const result = reader.listSessions(workDir);
    expect(result.sessions[0].sessionId).toBe('sess-new');
  });

  it('listSessions supports limit and offset', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-1', workDir, { title: '1', mtimeMs: Date.now() - 4000 });
    createSession('sess-2', workDir, { title: '2', mtimeMs: Date.now() - 3000 });
    createSession('sess-3', workDir, { title: '3', mtimeMs: Date.now() - 2000 });
    createSession('sess-4', workDir, { title: '4', mtimeMs: Date.now() - 1000 });

    const reader = new KimiSessionReader(kimiDir);
    const page1 = reader.listSessions(workDir, { limit: 2, offset: 0 });
    expect(page1.sessions).toHaveLength(2);
    expect(page1.total).toBe(4);
    // Most recent first
    expect(page1.sessions[0].sessionId).toBe('sess-4');

    const page2 = reader.listSessions(workDir, { limit: 2, offset: 2 });
    expect(page2.sessions).toHaveLength(2);
    expect(page2.sessions[0].sessionId).toBe('sess-2');
  });

  it('getNewestSession returns the most recent session', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-old', workDir, { title: 'Old', mtimeMs: Date.now() - 60000 });
    createSession('sess-new', workDir, { title: 'New', mtimeMs: Date.now() });

    const reader = new KimiSessionReader(kimiDir);
    const newest = reader.getNewestSession(workDir);
    expect(newest).not.toBeNull();
    expect(newest!.sessionId).toBe('sess-new');
  });

  it('getNewestSession returns null when no sessions', () => {
    const reader = new KimiSessionReader(kimiDir);
    expect(reader.getNewestSession(makeWorkDir('empty'))).toBeNull();
  });

  it('readSessionContent returns events from wire.jsonl', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-1', workDir, {
      title: 'Test',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"hello kimi"}],"origin":{"kind":"user"},"time":1000}',
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"Hello!"}},"time":1001}',
        '{"type":"context.append_loop_event","event":{"type":"step.end"},"time":1002}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":100,"output":50,"inputCacheRead":10,"inputCacheCreation":5},"time":1003}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-1', workDir);
    expect(content.events.length).toBeGreaterThanOrEqual(1);
    // Should have a text event
    const textEvents = content.events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0].content).toBe('Hello!');
  });

  it('readSessionContent returns displayTitle from turn.prompt', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-1', workDir, {
      title: 'Test',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"my task prompt"}],"origin":{"kind":"user"},"time":1000}',
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"response"}},"time":1001}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-1', workDir);
    expect(content.displayTitle).toBe('my task prompt');
  });

  it('readSessionContent returns usage from usage.record', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-1', workDir, {
      title: 'Test',
      wireLines: [
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":200,"output":100,"inputCacheRead":20,"inputCacheCreation":10},"time":1000}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-1', workDir);
    expect(content.usage).toBeDefined();
    expect(content.usage!.inputTokens).toBe(200);
    expect(content.usage!.outputTokens).toBe(100);
    expect(content.usage!.cacheReadTokens).toBe(20);
    expect(content.usage!.cacheCreationTokens).toBe(10);
    expect(content.usage!.totalTokens).toBe(330);
  });

  // 一次 run 内会有多次模型调用（工具往返），每次一条 usage.record。卡片
  // 「本 run」必须是末个 turn.prompt 之后的记录之和——会话总量（旧实现）会把
  // 历史所有 run 的消耗当成这一轮，末条记录又会漏掉前面的工具往返。
  it('reports the last turn as per-run usage instead of the session total', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-turns', workDir, {
      title: 'Turns',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"first"}],"origin":{"kind":"user"},"time":1000}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1000,"output":500,"inputCacheRead":200,"inputCacheCreation":50},"time":1001}',
        '{"type":"turn.prompt","input":[{"type":"text","text":"second"}],"origin":{"kind":"user"},"time":2000}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":300,"output":100,"inputCacheRead":30},"time":2001}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":200,"output":50,"inputCacheRead":20},"time":2002}',
      ],
    });

    const content = new KimiSessionReader(kimiDir).readSessionContent('sess-turns', workDir);

    expect(content.usage).toMatchObject({
      inputTokens: 500, // 300 + 200（末个 turn 的两次模型调用）
      outputTokens: 150, // 100 + 50
      cacheReadTokens: 50, // 30 + 20
      contextLength: 200 + 50 + 20, // 末条使用记录的窗口水位，不求和
      cumulativeInputTokens: 1500, // 会话累计（含 first turn）
      cumulativeOutputTokens: 650,
    });
  });

  it('an empty last turn shows flow 0, not the previous turn records', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-empty-turn', workDir, {
      title: 'Empty turn',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"first"}],"origin":{"kind":"user"},"time":1000}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":100,"output":50},"time":1001}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":20,"output":10},"time":1002}',
        '{"type":"turn.prompt","input":[{"type":"text","text":"second"}],"origin":{"kind":"user"},"time":2000}',
      ],
    });

    const content = new KimiSessionReader(kimiDir).readSessionContent('sess-empty-turn', workDir);

    expectRunUsageScope(content.usage, {
      flowInput: 0,
      flowOutput: 0,
      contextLength: 30,
      cumulativeInput: 120,
      cumulativeOutput: 60,
    });
  });

  // 子 agent 的 wire 文件没有 turn 标记，无法归属到某一轮：只能进会话累计，
  // 进"本 run"会把所有并发子 agent 的历史消耗算到当前这一轮。
  it('keeps subagent usage in the session cumulative only', () => {
    const workDir = makeWorkDir('project');
    const sessionDir = createSession('sess-subagent', workDir, {
      title: 'Sub',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"go"}],"origin":{"kind":"user"},"time":1000}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":100,"output":50},"time":1001}',
      ],
    });
    const subDir = path.join(sessionDir, 'agents', 'agent-0');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'wire.jsonl'),
      '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1000,"output":500},"time":1002}\n',
    );

    const content = new KimiSessionReader(kimiDir).readSessionContent('sess-subagent', workDir);

    expect(content.usage!.inputTokens).toBe(100); // 本 run = 主 wire 的末个 turn
    expect(content.usage!.cumulativeInputTokens).toBe(1100); // 子 agent 计入会话累计
    expect(content.usage!.cumulativeOutputTokens).toBe(550);
  });

  it('readSessionContent returns empty events for unknown sessionId', () => {
    const workDir = makeWorkDir('project');
    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('nonexistent-session', workDir);
    expect(content.events).toEqual([]);
  });

  it('readSessionContent returns empty events for mismatched cwd', () => {
    const workDir = makeWorkDir('project');
    const wrongDir = makeWorkDir('wrong-dir');
    createSession('sess-1', workDir, { title: 'Test' });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-1', wrongDir);
    expect(content.events).toEqual([]);
  });

  it('readSessionContent skips thinking blocks', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-1', workDir, {
      title: 'Test',
      wireLines: [
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"think","text":"internal reasoning"}},"time":1000}',
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"visible output"}},"time":1001}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-1', workDir);
    // Only text events, no thinking
    expect(content.events.every((e) => e.type !== 'think')).toBe(true);
    expect(content.events.some((e) => e.type === 'text' && e.content === 'visible output')).toBe(
      true,
    );
  });

  it('readSessionContent parses tool.call and tool.result events', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-1', workDir, {
      title: 'Test',
      wireLines: [
        '{"type":"context.append_loop_event","event":{"type":"tool.call","name":"Read","args":{"path":"/tmp/f"},"toolCallId":"tc1"},"time":1000}',
        '{"type":"context.append_loop_event","event":{"type":"tool.result","result":{"output":"file contents"},"toolCallId":"tc1"},"time":1001}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-1', workDir);
    const toolUse = content.events.find((e) => e.type === 'tool_use');
    const toolResult = content.events.find((e) => e.type === 'tool_result');
    expect(toolUse).toBeDefined();
    expect(toolUse!.content).toContain('Read');
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toBe('file contents');
  });

  it('isSessionActive returns false for unknown session', () => {
    const reader = new KimiSessionReader(kimiDir);
    expect(reader.isSessionActive('nonexistent', makeWorkDir('project'))).toBe(false);
  });

  it('isSessionActive returns false when no wire.jsonl', () => {
    const workDir = makeWorkDir('project');
    // Create session without wire.jsonl
    createSession('sess-1', workDir, { title: 'Test' });

    const reader = new KimiSessionReader(kimiDir);
    expect(reader.isSessionActive('sess-1', workDir)).toBe(false);
  });

  it('isSessionActive returns false for stale session (step.end)', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-1', workDir, {
      title: 'Test',
      wireLines: [
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"hi"}},"time":1000}',
        '{"type":"context.append_loop_event","event":{"type":"step.end"},"time":1001}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":100,"output":50},"time":1002}',
      ],
    });

    // Make wire.jsonl recent enough (within STALE_MS)
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-1');
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const now = Date.now() / 1000;
    fs.utimesSync(wirePath, now, now);

    const reader = new KimiSessionReader(kimiDir);
    expect(reader.isSessionActive('sess-1', workDir)).toBe(false);
  });

  // --- schema v2 (cwd field) compatibility tests ---

  it('readSessionContent works with v2 state.json (cwd instead of workDir)', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-v2', workDir, {
      title: 'V2 Session',
      stateSchema: 'v2',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"hello v2"}],"origin":{"kind":"user"},"time":1000}',
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"V2 reply"}},"time":1001}',
        '{"type":"context.append_loop_event","event":{"type":"step.end"},"time":1002}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":300,"output":150,"inputCacheRead":30,"inputCacheCreation":15},"time":1003}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-v2', workDir);
    expect(content.events.length).toBeGreaterThanOrEqual(1);
    const textEvents = content.events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0].content).toBe('V2 reply');
    expect(content.displayTitle).toBe('hello v2');
    expect(content.usage).toBeDefined();
    expect(content.usage!.inputTokens).toBe(300);
    expect(content.usage!.outputTokens).toBe(150);
    expect(content.usage!.cacheReadTokens).toBe(30);
    expect(content.usage!.cacheCreationTokens).toBe(15);
  });

  it('readSessionContent rejects v2 state.json with mismatched cwd', () => {
    const workDir = makeWorkDir('project');
    const wrongDir = makeWorkDir('wrong-dir');
    createSession('sess-v2-mismatch', workDir, {
      title: 'V2 Mismatch',
      stateSchema: 'v2',
      wireLines: [
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"should not appear"}},"time":1000}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-v2-mismatch', wrongDir);
    expect(content.events).toEqual([]);
  });

  it('readSessionContent works with v1 state.json (workDir field)', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-v1', workDir, {
      title: 'V1 Session',
      stateSchema: 'v1',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"hello v1"}],"origin":{"kind":"user"},"time":1000}',
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"V1 reply"}},"time":1001}',
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":100,"output":50,"inputCacheRead":10,"inputCacheCreation":5},"time":1002}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-v1', workDir);
    expect(content.events.length).toBeGreaterThanOrEqual(1);
    const textEvents = content.events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0].content).toBe('V1 reply');
    expect(content.usage).toBeDefined();
    expect(content.usage!.inputTokens).toBe(100);
  });

  // --- schema version detection and three-state guard tests ---

  it('detectSchemaVersion identifies v1 by workDir field', () => {
    const state: KimiSessionState = {
      createdAt: '2026-08-07T00:00:00Z',
      updatedAt: '2026-08-07T00:00:00Z',
      workDir: '/home/user/project',
    };
    expect(detectSchemaVersion(state)).toBe(1);
  });

  it('detectSchemaVersion identifies v2 by version field', () => {
    const state: KimiSessionState = {
      version: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    };
    expect(detectSchemaVersion(state)).toBe(2);
  });

  it('detectSchemaVersion identifies v2 by heuristic (cwd present, workDir absent)', () => {
    const state: KimiSessionState = {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    };
    expect(detectSchemaVersion(state)).toBe(2);
  });

  it('detectSchemaVersion prefers v1 when both fields present', () => {
    // Edge case: both workDir and cwd present but no version → v1 (workDir takes precedence)
    const state: KimiSessionState = {
      createdAt: '2026-08-07T00:00:00Z',
      updatedAt: '2026-08-07T00:00:00Z',
      workDir: '/home/user/project',
      cwd: '/home/user/other',
    };
    expect(detectSchemaVersion(state)).toBe(1);
  });

  it('extractWorkDir returns workDir for v1', () => {
    const state: KimiSessionState = {
      createdAt: '2026-08-07T00:00:00Z',
      updatedAt: '2026-08-07T00:00:00Z',
      workDir: '/home/user/project',
    };
    expect(extractWorkDir(state)).toBe('/home/user/project');
  });

  it('extractWorkDir returns cwd for v2', () => {
    const state: KimiSessionState = {
      version: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    };
    expect(extractWorkDir(state)).toBe('/home/user/project');
  });

  it('extractWorkDir returns undefined when neither field present', () => {
    const state: KimiSessionState = {
      createdAt: '2026-08-07T00:00:00Z',
      updatedAt: '2026-08-07T00:00:00Z',
    };
    expect(extractWorkDir(state)).toBeUndefined();
  });

  it('checkCwdGuard returns verified when workDir matches', () => {
    const state: KimiSessionState = {
      createdAt: '2026-08-07T00:00:00Z',
      updatedAt: '2026-08-07T00:00:00Z',
      workDir: '/home/user/project',
    };
    expect(checkCwdGuard(state, '/home/user/project')).toBe('verified');
  });

  it('checkCwdGuard returns verified when v2 cwd matches', () => {
    const state: KimiSessionState = {
      version: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    };
    expect(checkCwdGuard(state, '/home/user/project')).toBe('verified');
  });

  it('checkCwdGuard returns failed when workDir mismatches', () => {
    const state: KimiSessionState = {
      createdAt: '2026-08-07T00:00:00Z',
      updatedAt: '2026-08-07T00:00:00Z',
      workDir: '/home/user/project',
    };
    expect(checkCwdGuard(state, '/home/user/other')).toBe('failed');
  });

  it('checkCwdGuard returns failed when v2 cwd mismatches', () => {
    const state: KimiSessionState = {
      version: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    };
    expect(checkCwdGuard(state, '/home/user/other')).toBe('failed');
  });

  it('checkCwdGuard returns unverifiable when neither workDir nor cwd present', () => {
    const state: KimiSessionState = {
      createdAt: '2026-08-07T00:00:00Z',
      updatedAt: '2026-08-07T00:00:00Z',
    };
    expect(checkCwdGuard(state, '/home/user/project')).toBe('unverifiable');
  });

  // --- three-state guard in readSessionContent (fail-open + WARN log) ---

  it('readSessionContent allows access when state.json has no workDir/cwd (unverifiable)', () => {
    const workDir = makeWorkDir('project');
    // Create session with v2 state that has no workDir/cwd fields at all
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-no-dir');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    // state.json with neither workDir nor cwd
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ createdAt: Date.now(), updatedAt: Date.now() }),
    );
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"turn.prompt","input":[{"type":"text","text":"test"}],"origin":{"kind":"user"},"time":1000}\n' +
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"reply"}},"time":1001}\n',
    );
    addIndexEntry('sess-no-dir', sessionDir, workDir);

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-no-dir', workDir);
    // Fail-open: should return content despite unverifiable cwd
    const textEvents = content.events.filter((e) => e.type === 'text');
    expect(textEvents.some((e) => e.content === 'reply')).toBe(true);
  });

  it('readSessionContent blocks access when state.json missing but index has workDir', () => {
    const workDir = makeWorkDir('project-a');
    const wrongDir = makeWorkDir('project-b');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-no-state');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    // No state.json at all
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"turn.prompt","input":[{"type":"text","text":"test"}],"origin":{"kind":"user"},"time":1000}\n' +
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"reply"}},"time":1001}\n',
    );
    // Index has workDir — should be used as fallback guard
    addIndexEntry('sess-no-state', sessionDir, workDir);

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-no-state', wrongDir);
    // Should be blocked: index workDir=/project-a ≠ requested cwd=/project-b
    expect(content.events).toEqual([]);
  });

  it('readSessionContent blocks access when state.json unparseable but index has workDir', () => {
    const workDir = makeWorkDir('project-a');
    const wrongDir = makeWorkDir('project-b');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-bad-state');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Corrupt state.json
    fs.writeFileSync(path.join(sessionDir, 'state.json'), 'not valid json{{{');
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"turn.prompt","input":[{"type":"text","text":"test"}],"origin":{"kind":"user"},"time":1000}\n' +
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"reply"}},"time":1001}\n',
    );
    addIndexEntry('sess-bad-state', sessionDir, workDir);

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-bad-state', wrongDir);
    expect(content.events).toEqual([]);
  });

  it('readSessionContent allows access when state.json missing and index workDir matches', () => {
    const workDir = makeWorkDir('project-a');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-no-state-ok');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    // No state.json
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"turn.prompt","input":[{"type":"text","text":"ok"}],"origin":{"kind":"user"},"time":1000}\n' +
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"reply"}},"time":1001}\n',
    );
    addIndexEntry('sess-no-state-ok', sessionDir, workDir);

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-no-state-ok', workDir);
    const textEvents = content.events.filter((e) => e.type === 'text');
    expect(textEvents.some((e) => e.content === 'reply')).toBe(true);
  });

  // --- v2 listSessions title extraction from wire.jsonl ---

  it('listSessions extracts summary from wire.jsonl when v2 state has no title', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-v2-notitle', workDir, {
      stateSchema: 'v2',
      omitTitle: true,
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"Build a web server"}],"origin":{"kind":"user"},"time":1000}',
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"done"}},"time":1001}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const result = reader.listSessions(workDir);
    expect(result.total).toBe(1);
    expect(result.sessions[0].summary).toBe('Build a web server');
  });

  it('listSessions falls back to New Session when wire.jsonl has no turn.prompt', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-v2-empty-wire', workDir, {
      stateSchema: 'v2',
      omitTitle: true,
      wireLines: [
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"no prompt here"}},"time":1000}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const result = reader.listSessions(workDir);
    expect(result.total).toBe(1);
    expect(result.sessions[0].summary).toBe('New Session');
  });

  it('listSessions uses state.json title when available (v2 with title)', () => {
    const workDir = makeWorkDir('project');
    createSession('sess-v2-title', workDir, {
      title: 'My V2 Session',
      stateSchema: 'v2',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"wire prompt"}],"origin":{"kind":"user"},"time":1000}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const result = reader.listSessions(workDir);
    expect(result.sessions[0].summary).toBe('My V2 Session');
  });

  // --- session_index.jsonl with missing workDir, v2 fallback to state.json cwd ---

  it('listSessions filters by state.json cwd when index entry lacks workDir', () => {
    const workDir = makeWorkDir('project');
    const otherDir = makeWorkDir('other');
    // Session with v2 state but index entry without workDir
    createSession('sess-v2-no-index-workdir', workDir, {
      stateSchema: 'v2',
      omitIndexWorkDir: true,
      title: 'V2 No Index WorkDir',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"hello"}],"origin":{"kind":"user"},"time":1000}',
      ],
    });
    // Another session for a different directory, also no index workDir
    createSession('sess-v2-other-dir', otherDir, {
      stateSchema: 'v2',
      omitIndexWorkDir: true,
      title: 'V2 Other Dir',
      wireLines: [
        '{"type":"turn.prompt","input":[{"type":"text","text":"other"}],"origin":{"kind":"user"},"time":1000}',
      ],
    });

    const reader = new KimiSessionReader(kimiDir);
    const result = reader.listSessions(workDir);
    // Only the session matching workDir should appear
    expect(result.total).toBe(1);
    expect(result.sessions[0].sessionId).toBe('sess-v2-no-index-workdir');
  });

  // --- v2 createdAt/updatedAt as number ---

  it('readSessionContent handles v2 state.json with numeric timestamps', () => {
    const workDir = makeWorkDir('project');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-v2-nums');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    // state.json with numeric timestamps (v2 format)
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({
        version: 2,
        createdAt: 1723077600000,
        updatedAt: 1723077600000,
        cwd: workDir,
      }),
    );
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"turn.prompt","input":[{"type":"text","text":"numeric ts test"}],"origin":{"kind":"user"},"time":1000}\n' +
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"works"}},"time":1001}\n',
    );
    addIndexEntry('sess-v2-nums', sessionDir, workDir);

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-v2-nums', workDir);
    // numeric 时间戳的 wire.jsonl 必须被正常解析为事件内容
    const textEvents = content.events.filter((e) => e.type === 'text');
    expect(textEvents.some((e) => e.content === 'works')).toBe(true);
  });

  it('readSessionContent returns empty when cwd does not exist (realpathSync protection)', () => {
    const workDir = makeWorkDir('project');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-stale-cwd');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: workDir }),
    );
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"turn.prompt","input":[{"type":"text","text":"hello"}],"origin":{"kind":"user"},"time":1000}\n',
    );
    addIndexEntry('sess-stale-cwd', sessionDir, workDir);

    const reader = new KimiSessionReader(kimiDir);

    // Use a non-existent cwd path — realpathSync should NOT throw uncaught;
    // it should be caught and return empty content gracefully.
    const nonexistentCwd = '/no/such/directory/ever';
    expect(() => reader.readSessionContent('sess-stale-cwd', nonexistentCwd)).not.toThrow();
    const content = reader.readSessionContent('sess-stale-cwd', nonexistentCwd);
    expect(content.events).toEqual([]);
  });

  it('readSessionContent parses compaction records and populates compactCount + compactPreContextLength', () => {
    // §6.3: wire.jsonl 中 full_compaction.complete / context.apply_compaction 记录
    // 需解析出 compactCount 和 compactPreContextLength（tokensBefore）。
    // 展示计数只计 context.apply_compaction：一次手动 /compact 会同时写
    // full_compaction.complete + apply 两条，双计虚报 2 次。
    const workDir = makeWorkDir('project');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-compact');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: workDir }),
    );
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      // First turn with usage
      '{"type":"usage.record","model":"test-model","usage":{"inputOther":1000,"output":500,"inputCacheRead":200,"inputCacheCreation":50},"time":1000}\n' +
        '{"type":"turn.prompt","input":[{"type":"text","text":"placeholder"}],"origin":{"kind":"user"},"time":1001}\n' +
        '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"response"}},"time":1002}\n' +
        // First compaction
        // REAL shape: full_compaction.complete carries ONLY {type, time}.
        '{"type":"full_compaction.complete","time":2000}\n' +
        // Usage after compaction
        '{"type":"usage.record","model":"test-model","usage":{"inputOther":500,"output":200,"inputCacheRead":100,"inputCacheCreation":25},"time":3000}\n' +
        // The actual compaction — REAL shape: compactedCount/tokensBefore/tokensAfter
        // only on context.apply_compaction.
        '{"type":"context.apply_compaction","summary":"placeholder","compactedCount":4,"tokensBefore":30000,"tokensAfter":15000,"time":4000}\n',
    );
    addIndexEntry('sess-compact', sessionDir, workDir);

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-compact', workDir);

    expect(content.usage).toBeDefined();
    // full_compaction.complete 不计入展示计数（与 apply 同属一次手动 compact）。
    expect(content.usage?.compactCount).toBe(1);
    // compactPreContextLength takes the most recent compaction's tokensBefore
    expect(content.usage?.compactPreContextLength).toBe(30000);
  });

  it('readSessionContent with no compaction records has compactCount 0 and no compactPreContextLength', () => {
    const workDir = makeWorkDir('project');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-no-compact');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: workDir }),
    );
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"usage.record","model":"test-model","usage":{"inputOther":1000,"output":500},"time":1000}\n' +
        '{"type":"turn.prompt","input":[{"type":"text","text":"placeholder"}],"origin":{"kind":"user"},"time":1001}\n',
    );
    addIndexEntry('sess-no-compact', sessionDir, workDir);

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-no-compact', workDir);

    expect(content.usage).toBeDefined();
    expect(content.usage?.compactCount).toBe(0);
    expect(content.usage?.compactPreContextLength).toBeUndefined();
  });

  it('readCompactionRecords returns real-shape compaction records in wire order', () => {
    const workDir = makeWorkDir('project');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-records');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: workDir }),
    );
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"usage.record","model":"test-model","usage":{"inputOther":1000,"output":500},"time":1000}\n' +
        '{"type":"full_compaction.complete","time":2000}\n' +
        '{"type":"context.apply_compaction","summary":"placeholder","compactedCount":4,"tokensBefore":30000,"tokensAfter":15000,"time":4000}\n',
    );
    addIndexEntry('sess-records', sessionDir, workDir);

    const records = new KimiSessionReader(kimiDir).readCompactionRecords('sess-records', workDir);

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ type: 'full_compaction.complete', time: 2000 });
    expect(records[1]).toEqual({
      type: 'context.apply_compaction',
      compactedCount: 4,
      tokensBefore: 30000,
      tokensAfter: 15000,
      time: 4000,
    });
  });

  it('readCompactionRecords fails closed on cwd guard mismatch', () => {
    const workDir = makeWorkDir('project');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-guarded');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: workDir }),
    );
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"context.apply_compaction","summary":"placeholder","compactedCount":1,"tokensBefore":100,"tokensAfter":50,"time":2000}\n',
    );
    addIndexEntry('sess-guarded', sessionDir, workDir);

    const records = new KimiSessionReader(kimiDir).readCompactionRecords(
      'sess-guarded',
      makeWorkDir('other-project'),
    );
    expect(records).toEqual([]);
  });

  it('createCompactionRecordTracker: 首调全量，之后增量只读新增字节', () => {
    const workDir = makeWorkDir('project');
    const sessionId = 'sess-tracker';
    const sessionDir = path.join(kimiDir, 'sessions', sessionId);
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: workDir }),
    );
    const wirePath = path.join(agentsDir, 'wire.jsonl');
    fs.writeFileSync(
      wirePath,
      '{"type":"full_compaction.begin","source":"manual","time":1000}\n' +
        '{"type":"usage.record","model":"m","usage":{"inputOther":1,"output":2},"time":1100}\n',
    );
    addIndexEntry(sessionId, sessionDir, workDir);
    const reader = new KimiSessionReader(kimiDir);
    const tracker = reader.createCompactionRecordTracker(sessionId, workDir);
    expect(tracker).not.toBeNull();

    const readSpy = vi.spyOn(fs, 'readSync');
    try {
      // 首调 = 全量历史（覆盖 baseline 捕获后、tracker 创建前落地的记录）。
      const first = tracker!.records();
      expect(first).toHaveLength(1);
      expect(first[0]).toEqual({ type: 'full_compaction.begin', source: 'manual', time: 1000 });
      const firstEnd = fs.statSync(wirePath).size;

      // 模拟压缩进行中：追加进度行（mtime 变化，旧路径的 mtime 缓存必然失效）。
      fs.appendFileSync(
        wirePath,
        '{"type":"full_compaction.complete","time":2000}\n' +
          '{"type":"usage.record","model":"m","usage":{"inputOther":3,"output":4},"time":2100}\n',
      );
      const second = tracker!.records();
      expect(second).toHaveLength(2);
      expect(second[1]).toEqual({ type: 'full_compaction.complete', time: 2000 });

      // 增量证明：第二次读从上次 EOF 的字节偏移开始，而不是从 0 重扫。
      // readSync 有 (fd, buffer, opts?) 重载在前，位置参数取索引 4 需绕过元组推断。
      const positions = readSpy.mock.calls.map(
        (call) => (call as unknown as unknown[])[4] as number,
      );
      const afterFirst = positions.filter((p) => p === 0).length;
      expect(positions.some((p) => p === firstEnd)).toBe(true);
      expect(afterFirst).toBeLessThan(positions.length);

      // 无新增数据：记录列表稳定，不产生重复。
      const third = tracker!.records();
      expect(third).toHaveLength(2);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('createCompactionRecordTracker: 文件被截断重写时从头重建', () => {
    const workDir = makeWorkDir('project');
    const sessionId = 'sess-tracker-reset';
    const sessionDir = path.join(kimiDir, 'sessions', sessionId);
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: workDir }),
    );
    const wirePath = path.join(agentsDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, '{"type":"full_compaction.begin","source":"auto","time":1}\n');
    addIndexEntry(sessionId, sessionDir, workDir);

    const tracker = new KimiSessionReader(kimiDir).createCompactionRecordTracker(
      sessionId,
      workDir,
    )!;
    expect(tracker.records()).toHaveLength(1);

    // 截断重写（比原文件短）：tracker 必须放弃旧 offset，重建而不是漏读/错读。
    fs.writeFileSync(wirePath, '{"type":"full_compaction.complete","time":9}\n');
    const records = tracker.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'full_compaction.complete', time: 9 });
  });

  it('createCompactionRecordTracker: cwd 守卫不匹配返回 null', () => {
    const workDir = makeWorkDir('project');
    const sessionId = 'sess-tracker-guard';
    const sessionDir = path.join(kimiDir, 'sessions', sessionId);
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: workDir }),
    );
    fs.writeFileSync(path.join(agentsDir, 'wire.jsonl'), '{}\n');
    addIndexEntry(sessionId, sessionDir, workDir);

    const tracker = new KimiSessionReader(kimiDir).createCompactionRecordTracker(
      sessionId,
      makeWorkDir('other-project'),
    );
    expect(tracker).toBeNull();
  });
});

describe('KimiSessionReader compaction state machine', () => {
  /**
   * Write a session with the given wire lines and return a reader.
   * Fixture data is synthetic (AABB UUIDs, tmp paths) — project red line.
   */
  function makeCompactionReader(
    sessionId: string,
    workDir: string,
    wireLines: string[],
  ): KimiSessionReader {
    const sessionDir = path.join(kimiDir, 'sessions', sessionId);
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: workDir }),
    );
    fs.writeFileSync(path.join(agentsDir, 'wire.jsonl'), wireLines.join('\n') + '\n');
    addIndexEntry(sessionId, sessionDir, workDir);
    return new KimiSessionReader(kimiDir);
  }

  it('readCompactionState: begin 无终态 → inFlight，inFlightSince 取 begin 时间', () => {
    const workDir = makeWorkDir('project');
    const reader = makeCompactionReader('sess-begin-only', workDir, [
      '{"type":"full_compaction.begin","source":"manual","time":5000}',
    ]);

    const state = reader.readCompactionState('sess-begin-only', workDir);
    expect(state.inFlight).toBe(true);
    expect(state.inFlightSince).toBe(5000);
    expect(state.records).toHaveLength(1);
  });

  it('readCompactionState: begin + complete → 不在途', () => {
    const workDir = makeWorkDir('project');
    const reader = makeCompactionReader('sess-begin-complete', workDir, [
      '{"type":"full_compaction.begin","source":"manual","time":5000}',
      '{"type":"full_compaction.complete","time":6000}',
    ]);

    const state = reader.readCompactionState('sess-begin-complete', workDir);
    expect(state.inFlight).toBe(false);
    expect(state.inFlightSince).toBeUndefined();
  });

  it('readCompactionState: begin + cancel → 不在途', () => {
    const workDir = makeWorkDir('project');
    const reader = makeCompactionReader('sess-begin-cancel', workDir, [
      '{"type":"full_compaction.begin","source":"manual","time":5000}',
      '{"type":"full_compaction.cancel","time":6000}',
    ]);

    const state = reader.readCompactionState('sess-begin-cancel', workDir);
    expect(state.inFlight).toBe(false);
    expect(state.inFlightSince).toBeUndefined();
  });

  it('readCompactionState: auto source 的 begin 同样判在途', () => {
    const workDir = makeWorkDir('project');
    const reader = makeCompactionReader('sess-begin-auto', workDir, [
      '{"type":"full_compaction.begin","source":"auto","time":7000}',
    ]);

    const state = reader.readCompactionState('sess-begin-auto', workDir);
    expect(state.inFlight).toBe(true);
    expect(state.inFlightSince).toBe(7000);
  });

  it('readCompactionState: 第二轮 begin 无终态 → 仍判在途（上一次已闭合）', () => {
    const workDir = makeWorkDir('project');
    const reader = makeCompactionReader('sess-two-rounds', workDir, [
      '{"type":"full_compaction.begin","source":"manual","time":1000}',
      '{"type":"context.apply_compaction","compactedCount":4,"tokensBefore":30000,"tokensAfter":15000,"time":2000}',
      '{"type":"full_compaction.begin","source":"manual","time":3000}',
    ]);

    const state = reader.readCompactionState('sess-two-rounds', workDir);
    expect(state.inFlight).toBe(true);
    expect(state.inFlightSince).toBe(3000);
  });

  it('readCompactionRecords 返回 begin / terminal 三类记录（含 source/time）', () => {
    const workDir = makeWorkDir('project');
    const reader = makeCompactionReader('sess-three-kinds', workDir, [
      '{"type":"full_compaction.begin","source":"manual","time":1000}',
      '{"type":"full_compaction.cancel","time":2000}',
      '{"type":"full_compaction.begin","source":"auto","time":3000}',
      '{"type":"context.apply_compaction","compactedCount":4,"tokensBefore":30000,"tokensAfter":15000,"time":4000}',
    ]);

    const records = reader.readCompactionRecords('sess-three-kinds', workDir);
    expect(records).toEqual([
      { type: 'full_compaction.begin', source: 'manual', time: 1000 },
      { type: 'full_compaction.cancel', time: 2000 },
      { type: 'full_compaction.begin', source: 'auto', time: 3000 },
      {
        type: 'context.apply_compaction',
        compactedCount: 4,
        tokensBefore: 30000,
        tokensAfter: 15000,
        time: 4000,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 扫描累积器单测（纯函数直测：scanKimiUsage）
//
// 拆分自 readSessionContent 的 usage 单遍闭包；事件/displayTitle 装配与端到
// 端行为仍由上面的公共 API 测试覆盖。这里直测三条易漂移的内部口径：
// - turn 边界 = 最后一个 turn.prompt（之后的 usage.record 才进 flow）；
// - 末 turn 尚无记录 → flow 全 0（契约是「末个 turn」，不是「末个非空 turn」）；
// - 畸形 usage.record（缺 usage 对象/字段）按 0 计但记为「有数据」。
// ---------------------------------------------------------------------------
describe('scanKimiUsage（扫描累积器）', () => {
  it('turn 只累计最后一个 turn.prompt 之后的 usage.record；水位取主 wire 末条', () => {
    const scan = scanKimiUsage([
      JSON.stringify({
        type: 'usage.record',
        model: 'k2',
        usage: { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 6 },
        time: 1,
      }),
      JSON.stringify({
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'q2' }],
        origin: { kind: 'user' },
        time: 2,
      }),
      JSON.stringify({
        type: 'usage.record',
        model: 'k2',
        usage: { inputOther: 200, output: 20, inputCacheRead: 1, inputCacheCreation: 2 },
        time: 3,
      }),
    ]);
    expect(scan.turn).toEqual({ input: 200, output: 20, cacheRead: 1, cacheCreation: 2 });
    expect(scan.totals).toEqual({ input: 300, output: 30, cacheRead: 6, cacheCreation: 8 });
    // §9.21：水位 = 末条主 wire record 的 input+output+cacheRead+cacheCreation。
    expect(scan.mainContextLength).toBe(200 + 20 + 1 + 2);
    expect(scan.hasUsageRecord).toBe(true);
  });

  it('末 turn 尚无 usage.record → flow 全 0；畸形 record 记为有数据', () => {
    const scan = scanKimiUsage([
      '{"type":"usage.record","model":"k2","time":1}',
      '{"type":"turn.prompt","input":[{"type":"text","text":"q3"}],"origin":{"kind":"user"},"time":2}',
    ]);
    expect(scan.turn).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    // 畸形 record：字段按 0 计，但 hasUsageRecord = true（全零照实返回）。
    expect(scan.hasUsageRecord).toBe(true);
    expect(scan.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(scan.mainContextLength).toBe(0);
  });

  it('整份 wire 无 turn.prompt → turn undefined（装配段回退全会话口径）', () => {
    const scan = scanKimiUsage([
      JSON.stringify({
        type: 'usage.record',
        model: 'k2',
        usage: { inputOther: 7, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
        time: 1,
      }),
    ]);
    expect(scan.turn).toBeUndefined();
    expect(scan.totals.input).toBe(7);
  });
});

/**
 * listSessions 循环内各分支组合（characterization）。
 *
 * 后续把循环体抽成模块级命名函数后，state 解析失败、cwd 过滤、
 * summary 三级回退（title → wire → New Session）、mtime 回退目录、
 * 以及排序/分页的组合行为必须逐项保持。
 */
describe('listSessions 循环分支组合 (characterization)', () => {
  it('state 损坏 / cwd 不匹配 / 标题 / wire 回退 / mtime 回退目录 同时出现', () => {
    const workDir = makeWorkDir('combo');
    const otherDir = makeWorkDir('combo-other');
    const reader = new KimiSessionReader(kimiDir);
    const promptLine = JSON.stringify({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'from wire' }],
      origin: { kind: 'user' },
      time: 1,
    });

    // 1) state.json 损坏但 index workDir 匹配：summary 保持默认 'New Session'
    //    （stateParsed=false → 不做 wire 回退，这是需钉住的原行为）
    const s1 = path.join(kimiDir, 'sessions', 's-broken');
    fs.mkdirSync(path.join(s1, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(s1, 'state.json'), '{not json');
    fs.writeFileSync(path.join(s1, 'agents', 'main', 'wire.jsonl'), promptLine + '\n');
    addIndexEntry('s-broken', s1, workDir);

    // 2) cwd 不匹配的会话 → 排除
    createSession('s-foreign', otherDir, { title: 'foreign', mtimeMs: 9000 });

    // 3) state 有 title → summary 取 title
    createSession('s-titled', workDir, { title: 'has title', mtimeMs: 5000 });

    // 4) state 解析成功但无 title → 从 wire 的 turn.prompt 取 summary
    createSession('s-wire', workDir, { omitTitle: true, wireLines: [promptLine] });

    // 5) state 无 title、无 wire 文件 → summary 'New Session'，mtime 回退目录
    const s5 = path.join(kimiDir, 'sessions', 's-empty');
    fs.mkdirSync(s5, { recursive: true });
    fs.writeFileSync(
      path.join(s5, 'state.json'),
      JSON.stringify({ workDir, createdAt: '', updatedAt: '' }),
    );
    addIndexEntry('s-empty', s5, workDir);

    const { sessions, total } = reader.listSessions(workDir);
    expect(total).toBe(4);
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    expect(byId.get('s-broken')?.summary).toBe('New Session');
    expect(byId.get('s-titled')?.summary).toBe('has title');
    expect(byId.get('s-wire')?.summary).toBe('from wire');
    expect(byId.get('s-empty')?.summary).toBe('New Session');
    expect(byId.has('s-foreign')).toBe(false);
    // mtime 全序降序（不依赖具体时间戳）
    const mtimes = sessions.map((s) => s.mtime);
    expect([...mtimes].sort((a, b) => b - a)).toEqual(mtimes);
    // 分页仍基于完整有序集合
    expect(reader.listSessions(workDir, { limit: 2, offset: 1 }).total).toBe(4);
  });
});
