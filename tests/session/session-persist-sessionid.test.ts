import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../../src/session/index.js';

describe('SessionStore persistence - sessionId', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-persist-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_persists_sessionId_to_disk', () => {
    // 验证：setSessionIdAndCwd 时，sessionId 被持久化到 last-session.json
    const filePath = path.join(tmpDir, 'last-session.json');
    const store = new SessionStore(filePath);
    store.setSessionIdAndCwd('user1', 'claude', 'session-abc123', '/tmp/project');

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // 期望：持久化格式包含 sessionId 信息
    // 格式为对象，包含 sessions 字段
    expect(parsed.user1).toBeDefined();
    expect(typeof parsed.user1).toBe('object');
    expect(parsed.user1.sessions).toBeDefined();
    expect(parsed.user1.sessions.claude).toBe('session-abc123');
  });

  it('test_anchor_restores_sessionId_from_disk', () => {
    // 验证：从 last-session.json 恢复时，sessionId 被正确恢复
    const filePath = path.join(tmpDir, 'last-session.json');
    // 写入一个包含 sessionId 的文件（新格式）
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          user1: {
            cwd: '/tmp/project',
            sessions: {
              claude: 'session-abc123',
            },
            previousSessions: {},
            arrivalSessions: {},
            sessionCwds: {},
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const store = new SessionStore(filePath);

    // 期望：getSessionId 返回之前持久化的 sessionId
    const sessionId = store.getSessionId('user1', 'claude');
    expect(sessionId).toBe('session-abc123');
    expect(store.getCwd('user1')).toBe('/tmp/project');
  });

  it('test_anchor_setSessionId_persists_immediately', () => {
    // 验证：setSessionId 调用后立即持久化
    const filePath = path.join(tmpDir, 'last-session.json');
    const store = new SessionStore(filePath);

    // 先设置 cwd
    store.setCwd('user1', '/tmp/project');
    // 再设置 sessionId
    store.setSessionId('user1', 'claude', 'session-xyz789');

    // 期望：文件应该立即包含 sessionId
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const userData = parsed.user1;
    expect(userData.sessions?.claude).toBe('session-xyz789');
  });

  it('test_anchor_multiple_agents_sessionIds_persisted', () => {
    // 验证：多个 agent 的 sessionId 都被持久化
    const filePath = path.join(tmpDir, 'last-session.json');
    const store = new SessionStore(filePath);
    store.setSessionIdAndCwd('user1', 'claude', 'claude-session', '/tmp');
    store.setSessionId('user1', 'codex', 'codex-session');
    store.setSessionId('user1', 'opencode', 'opencode-session');

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const userData = parsed.user1;

    expect(userData.sessions.claude).toBe('claude-session');
    expect(userData.sessions.codex).toBe('codex-session');
    expect(userData.sessions.opencode).toBe('opencode-session');
  });
});
