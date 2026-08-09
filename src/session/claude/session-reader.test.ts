import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeSessionReader } from '../../session/claude/session-reader.js';
import {
  listClaudeSessions,
  getNewestSession,
  readSessionContent,
  isClaudeSessionActive,
} from '../../session/claude/sessions.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-claude-reader-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: write a fake jsonl session file under <tmpDir>/<encodedCwd>/
function writeSession(cwd: string, lines: string[], sessionId = 'test-session-1234'): string {
  const encoded = cwd.replace(/\//g, '-');
  const dir = path.join(tmpDir, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const initLine = `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`;
  const allLines = [initLine, ...lines];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), allLines.join('\n') + '\n');
  return sessionId;
}

describe('ClaudeSessionReader', () => {
  it('listSessions returns the same result as listClaudeSessions', () => {
    const cwd = '/tmp/proj-a';
    writeSession(cwd, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ]);

    const reader = new ClaudeSessionReader({ projectsDir: tmpDir });
    const fromReader = reader.listSessions(cwd);
    const fromFunction = listClaudeSessions(cwd, { projectsDir: tmpDir });

    expect(fromReader.sessions).toEqual(fromFunction);
    expect(fromReader.total).toBe(1);
    expect(fromReader.sessions).toHaveLength(1);
    expect(fromReader.sessions[0].sessionId).toBe('test-session-1234');
    expect(fromReader.sessions[0].summary).toBe('hello');
  });

  it('getNewestSession returns null when no sessions exist', () => {
    const reader = new ClaudeSessionReader({ projectsDir: tmpDir });
    expect(reader.getNewestSession('/tmp/empty-cwd')).toBeNull();
  });

  it('getNewestSession returns the newest session when present', () => {
    const cwd = '/tmp/proj-b';
    writeSession(cwd, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first"}]}}',
    ]);
    // second session with a newer mtime — write a different sessionId
    const encoded = cwd.replace(/\//g, '-');
    const dir = path.join(tmpDir, encoded);
    const newerPath = path.join(dir, 'newer-session.jsonl');
    fs.writeFileSync(
      newerPath,
      '{"type":"system","subtype":"init","session_id":"newer-session","cwd":"/tmp/proj-b","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second"}]}}\n',
    );
    // bump mtime to be newer than the first file
    const future = Date.now() / 1000 + 60;
    fs.utimesSync(newerPath, future, future);

    const reader = new ClaudeSessionReader({ projectsDir: tmpDir });
    const newest = reader.getNewestSession(cwd);
    expect(newest).not.toBeNull();
    expect(newest!.sessionId).toBe('newer-session');

    // Should match the direct function
    const direct = getNewestSession(cwd, { projectsDir: tmpDir });
    expect(newest!.sessionId).toBe(direct!.sessionId);
  });

  it('readSessionContent matches readSessionContent function', () => {
    const cwd = '/tmp/proj-c';
    const sessionId = writeSession(cwd, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"do thing"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"done"}]}}',
    ]);

    const reader = new ClaudeSessionReader({ projectsDir: tmpDir });
    const fromReader = reader.readSessionContent(sessionId, cwd);
    const fromFunction = readSessionContent(sessionId, cwd, { projectsDir: tmpDir });

    expect(fromReader).toEqual(fromFunction);
    expect(fromReader.events.map((e) => e.content)).toEqual(['done']);
  });

  it('isSessionActive matches isClaudeSessionActive function', () => {
    const cwd = '/tmp/proj-d';
    const sessionId = writeSession(cwd, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"yo"}]}}',
    ]);

    const reader = new ClaudeSessionReader({ projectsDir: tmpDir });
    const fromReader = reader.isSessionActive(sessionId, cwd);
    const fromFunction = isClaudeSessionActive(sessionId, cwd, { projectsDir: tmpDir });
    expect(fromReader).toBe(fromFunction);
  });

  it('isSessionActive returns false for missing session', () => {
    const reader = new ClaudeSessionReader({ projectsDir: tmpDir });
    expect(reader.isSessionActive('nonexistent', '/tmp/missing')).toBe(false);
  });

  it('works without projectsDir (uses default ~/.claude/projects/)', () => {
    // Just verify it doesn't throw and returns empty for a nonexistent cwd.
    // We can't write to the real ~/.claude/projects/ in tests, so only check
    // the no-sessions case.
    const reader = new ClaudeSessionReader();
    expect(reader.listSessions('/tmp/nonexistent-cwd-xyz')).toEqual({
      sessions: [],
      total: 0,
    });
    expect(reader.getNewestSession('/tmp/nonexistent-cwd-xyz')).toBeNull();
  });
});
