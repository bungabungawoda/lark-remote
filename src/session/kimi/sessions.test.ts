import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KimiSessionReader } from './sessions.js';
import { detectSchemaVersion, extractWorkDir, checkCwdGuard } from './sessions.js';
import type { KimiSessionState } from './sessions.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;
let kimiDir: string;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
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

  // --- three-state guard in readSessionContent (fail-closed + WARN log) ---

  it('readSessionContent allows access when state.json unverifiable but index workDir matches', () => {
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
    // state.json has no cwd source, but index workDir matches the requested
    // workspace — the index fallback guard passes, so content is returned.
    expect(content.events.length).toBeGreaterThanOrEqual(1);
  });

  it('readSessionContent rejects when state.json and index both lack cwd (fail-closed)', () => {
    const workDir = makeWorkDir('project');
    const sessionDir = path.join(kimiDir, 'sessions', 'sess-no-cwd-src');
    const agentsDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentsDir, { recursive: true });
    // state.json with neither workDir nor cwd (v2 session without cwd field)
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ createdAt: Date.now(), updatedAt: Date.now() }),
    );
    fs.writeFileSync(
      path.join(agentsDir, 'wire.jsonl'),
      '{"type":"turn.prompt","input":[{"type":"text","text":"test"}],"origin":{"kind":"user"},"time":1000}\n',
    );
    // Index entry without workDir — no cwd source anywhere
    addIndexEntry('sess-no-cwd-src', sessionDir, workDir, { omitWorkDir: true });

    const reader = new KimiSessionReader(kimiDir);
    const content = reader.readSessionContent('sess-no-cwd-src', workDir);
    // Fail-closed: no cwd source can verify the session belongs to the
    // requested workspace — access is rejected (aligned with claude).
    expect(content.events).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no cwd source (state.json + index)'),
    );
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
    expect(content.events.length).toBeGreaterThanOrEqual(1);
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
    expect(content.events.length).toBeGreaterThanOrEqual(1);
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
});
