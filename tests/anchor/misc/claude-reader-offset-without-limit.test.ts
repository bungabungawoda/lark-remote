import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeSessionReader } from '../../../src/session/claude/session-reader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-claude-anchor-offset-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: write a fake jsonl session file under <tmpDir>/<encodedCwd>/
function writeSession(cwd: string, sessionId: string, summary: string): string {
  const encoded = cwd.replace(/\//g, '-');
  const dir = path.join(tmpDir, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const initLine = `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`;
  const userLine = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"${summary}"}]}}`;
  fs.writeFileSync(filePath, initLine + '\n' + userLine + '\n');
  return filePath;
}

describe('anchor: claude reader offset-without-limit', () => {
  it('test_anchor_claude_listSessions_offset_without_limit_respects_offset', () => {
    const cwd = '/tmp/anchor-offset-proj';

    // Write 3 sessions with deterministic ascending mtime so ordering is stable.
    const base = Date.now() / 1000;
    const p0 = writeSession(cwd, 'sess-a', 'first');
    fs.utimesSync(p0, base + 10, base + 10);
    const p1 = writeSession(cwd, 'sess-b', 'second');
    fs.utimesSync(p1, base + 20, base + 20);
    const p2 = writeSession(cwd, 'sess-c', 'third');
    fs.utimesSync(p2, base + 30, base + 30);

    const reader = new ClaudeSessionReader({ projectsDir: tmpDir });

    // Request offset=1 with no limit: should return sessions from index 1 onward
    // (2 sessions), total still 3. Bug: current impl ignores offset when limit
    // is undefined and returns all 3.
    const result = reader.listSessions(cwd, { offset: 1 });

    expect(result.total).toBe(3);
    expect(result.sessions).toHaveLength(2);
  });
});
