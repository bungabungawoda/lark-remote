import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readSessionContent,
  listClaudeSessions,
  getNewestSession,
  isClaudeSessionActive,
} from '../../session/claude/sessions.js';
import { parseSessionJsonl } from '../../session/claude/session-index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-claude-sessions-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: write a fake jsonl session file under <tmpDir>/<encodedCwd>/
// Injects a system init line with `cwd` so the production code can locate
// the file via projectDirForCwd + readCwdFromJsonl (regression 2026-06-21).
function writeSession(cwd: string, lines: string[]): string {
  const encoded = cwd.replace(/\//g, '-');
  const dir = path.join(tmpDir, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = 'test-session-1234';
  const initLine = `{"type":"system","subtype":"init","session_id":"${sessionId}","cwd":"${cwd}","model":"opus"}`;
  const allLines = [initLine, ...lines];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), allLines.join('\n') + '\n');
  return sessionId;
}

describe('readSessionContent', () => {
  it('returns empty events when jsonl does not exist', () => {
    const result = readSessionContent('missing', '/tmp/proj', { projectsDir: tmpDir });
    expect(result.events).toEqual([]);
    expect(result.usage).toBeUndefined();
  });

  it('collects assistant text events after the last user message', () => {
    // Simulates the production bug: session ends with a tool_result → assistant
    // end_turn text, with NO `type:"result"` event afterwards. Only events
    // AFTER the last user message are part of the catch-up tail.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp/proj","model":"opus"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"do thing"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"working on it"}]}}',
      '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"x","type":"tool_result","content":"ok"}]}}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"✅ done"}]}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });

    // lastUserIdx points to the tool_result (line 3). Only the assistant
    // message AFTER it is part of the tail.
    expect(result.events.map((e) => e.content)).toEqual(['✅ done']);
  });

  it('extracts tool_use, tool_result, and thinking as separate events (BUG: currently skipped)', () => {
    // A real Claude session with thinking + tool_use + tool_result + final text.
    // Each content_block should become its own event in the tail.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"run a test"}]}}',
      // Assistant: thinking → tool_use → tool_result → text
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[' +
        '{"type":"thinking","thinking":"Let me run the test..."},' +
        '{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"npm test"}},' +
        '{"type":"tool_result","tool_use_id":"tu1","content":"10 passed"},' +
        '{"type":"text","text":"All tests passed! ✅"}]' +
        '}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });

    // All content blocks are now extracted as separate events
    const contents = result.events.map((e) => e.content);
    expect(contents.some((c) => c.includes('Let me run the test...'))).toBe(true);
    expect(contents.some((c) => c.includes('Bash'))).toBe(true);
    expect(contents.some((c) => c.includes('10 passed'))).toBe(true);
    expect(contents.some((c) => c.includes('All tests passed! ✅'))).toBe(true);
  });

  it('extracts thinking blocks as separate events', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"explain foo"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[' +
        '{"type":"thinking","thinking":"Thinking about foo..."},' +
        '{"type":"text","text":"Foo is a variable."}]' +
        '}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    const contents = result.events.map((e) => e.content);

    // Thinking should be extracted
    expect(contents).toContain('Thinking about foo...');
    // Text should also be extracted
    expect(contents).toContain('Foo is a variable.');
  });

  it('extracts tool_result with error content', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"do something"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[' +
        '{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls /nonexistent"}},' +
        '{"type":"tool_result","tool_use_id":"tu1","content":"Error: No such file or directory","is_error":true}' +
        ']' +
        '}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    const contents = result.events.map((e) => e.content);

    expect(contents.some((c) => c.includes('Bash'))).toBe(true);
    expect(contents.some((c) => c.includes('Error: No such file or directory'))).toBe(true);
  });

  it('skips tail metadata lines (last-prompt, mode) that lack message.content', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"reply"}]}}',
      '{"type":"last-prompt","lastPrompt":"hi","leafUuid":"abc"}',
      '{"type":"mode","mode":"normal"}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });

    // Only the assistant text shows; last-prompt/mode are ignored
    expect(result.events.map((e) => e.content)).toEqual(['reply']);
  });

  it('aggregates usage from assistant messages regardless of tail structure', () => {
    // Older Claude CLI versions wrote a result event after the assistant reply.
    // Usage is aggregated from assistant messages (which is how the production
    // code computes it), so an assistant message with `message.usage` is what
    // drives the footer stats.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":10,"output_tokens":20}}}',
      '{"type":"result","subtype":"success","session_id":"s1"}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.events.map((e) => e.content)).toEqual(['a']);
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(20);
  });
  it('aggregates cache_read_input_tokens and cache_creation_input_tokens from assistant messages', () => {
    // Claude API returns cache_read_input_tokens and cache_creation_input_tokens
    // in the usage object. aggregateSessionUsage must collect these for cost tracking.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":500,"cache_creation_input_tokens":100}}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.usage).toBeDefined();
    expect(result.usage?.cacheReadTokens).toBe(500);
    expect(result.usage?.cacheCreationTokens).toBe(100);
    // Claude JSONL has no declared total; ccusage computes it as the sum of parts.
    expect(result.usage?.totalTokens).toBe(630); // 10 + 20 + 500 + 100
  });

  it('counts compact_boundary events and uses max(postTokens, last full prompt) as contextLength', () => {
    // compact_boundary 仅写入 jsonl，不通过 stream-json 输出。readSessionContent
    // 必须数 compact_boundary 事件得到 compactCount。contextLength 取 max(末次
    // compact postTokens, 末条消息完整 prompt)，两者谁新谁大。
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":100000,"output_tokens":20}}}',
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":5000}}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"after compact"}],"usage":{"input_tokens":6000,"output_tokens":30}}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.usage?.compactCount).toBe(1);
    // contextLength 取 max(postTokens=5000, 末轮窗口占用=6000) = 6000
    // (review P2-8: input+cacheRead+cacheCreation, excludes output)
    expect(result.usage?.contextLength).toBe(6000);
  });

  it('counts multiple compact_boundary events, contextLength uses max(last postTokens, last full prompt)', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":200000,"output_tokens":20}}}',
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":50000}}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"more"}],"usage":{"input_tokens":80000,"output_tokens":30}}}',
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":40000}}',
      '{"type":"assistant","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"after 2nd"}],"usage":{"input_tokens":45000,"output_tokens":40}}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.usage?.compactCount).toBe(2);
    // 多次 compact 取 max(末次 postTokens=40000, 末轮窗口占用=45000) = 45000
    expect(result.usage?.contextLength).toBe(45000);
  });

  it('exposes cumulative input/output as session-wide totals', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q1"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a1"}],"usage":{"input_tokens":100,"output_tokens":20}}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q2"}]}}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"a2"}],"usage":{"input_tokens":5000,"output_tokens":50}}}',
    ]);
    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.usage).toBeDefined();
    // 非累计字段 = 末轮（本 run）scope（对齐 codex `last_token_usage` 语义）
    expect(result.usage!.inputTokens).toBe(5000); // 末轮 m2
    expect(result.usage!.outputTokens).toBe(50); // 末轮 m2
    // 累计字段 = session 总和（所有 run，供卡片"· 累计"展示）
    expect(result.usage!.cumulativeInputTokens).toBe(5100); // 100 + 5000
    expect(result.usage!.cumulativeOutputTokens).toBe(70); // 20 + 50
  });

  it('cache 非累计字段取末轮、累计取 session 总和（scope 分离）', () => {
    // 修复回归：scalarScan 曾把 session 总和同时塞进非累计与累计字段，
    // jsonl 兜底路径会把 session 累计当"本 run"显示（累计反而更小）。
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q1"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a1"}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":500,"cache_creation_input_tokens":50}}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q2"}]}}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"a2"}],"usage":{"input_tokens":1000,"output_tokens":80,"cache_read_input_tokens":800,"cache_creation_input_tokens":0}}}',
    ]);
    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.usage).toBeDefined();
    // 非累计（本 run）= 末轮 m2
    expect(result.usage?.inputTokens).toBe(1000);
    expect(result.usage?.outputTokens).toBe(80);
    expect(result.usage?.cacheReadTokens).toBe(800);
    expect(result.usage?.cacheCreationTokens).toBeUndefined(); // 末轮 cache_creation=0
    expect(result.usage?.totalTokens).toBe(1000 + 80 + 800 + 0); // 末轮分项和
    // 累计（session 总和）
    expect(result.usage?.cumulativeInputTokens).toBe(1100); // 100 + 1000
    expect(result.usage?.cumulativeOutputTokens).toBe(100); // 20 + 80
    expect(result.usage?.cumulativeCacheReadTokens).toBe(1300); // 500 + 800
    expect(result.usage?.cumulativeCacheCreationTokens).toBe(50); // 50 + 0
  });

  it('merges multi-line assistant usage by per-field max (zero placeholder lines before real usage)', () => {
    // Regression 2026-08-19: some backends (third-party gateways) stream an
    // assistant message as multiple jsonl lines sharing one message id, with
    // all-zero usage on the early placeholder lines (empty thinking block) and
    // the real usage only on the final line carrying stop_reason.
    // First-occurrence-wins dedup pinned the zero record, so the auto-resume
    // card showed per-run stats all 0 while the real usage line was discarded.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q1"}]}}',
      // m1: two zero-usage placeholder lines, then the final line with real usage
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"","signature":""}],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a1"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a1 done"}],"stop_reason":"end_turn","usage":{"input_tokens":619,"output_tokens":313,"cache_read_input_tokens":98816,"cache_creation_input_tokens":0}}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q2"}]}}',
      // m2: single line with real usage (official-API shape)
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"a2"}],"usage":{"input_tokens":100,"output_tokens":20}}}',
    ]);
    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.usage).toBeDefined();
    // 非累计字段 = 末轮 m2
    expect(result.usage!.inputTokens).toBe(100);
    expect(result.usage!.outputTokens).toBe(20);
    // 累计：m1 的真实 usage（末行）+ m2；零占位行不得遮蔽真行
    expect(result.usage!.cumulativeInputTokens).toBe(719); // 619 + 100
    expect(result.usage!.cumulativeOutputTokens).toBe(333); // 313 + 20
    expect(result.usage!.cumulativeCacheReadTokens).toBe(98816);
  });

  it('per-field max merge combines message_start-style partial usage across lines of one message', () => {
    // Same multi-line message, but the FIRST line already carries real
    // input_tokens with output 0 (message_start shape) and only the final
    // line adds output_tokens. Max merge must combine them, not let the
    // later line's 0 clobber the earlier real value (last-wins would fail
    // the inverse order).
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"..."}],"usage":{"input_tokens":46045,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn","usage":{"input_tokens":46045,"output_tokens":433,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
    ]);
    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.usage!.inputTokens).toBe(46045);
    expect(result.usage!.outputTokens).toBe(433);
    expect(result.usage!.totalTokens).toBe(46045 + 433);
    expect(result.usage!.contextLength).toBe(46045);
  });

  it('returns compactCount=0 when no compact_boundary events', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":100,"output_tokens":20}}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    // 无 compact 时 compactCount=0（falsy，显示层不渲染 "compact 0 次"）
    expect(result.usage?.compactCount).toBe(0);
    // 无 compact 单 turn：contextLength = 该 turn 窗口占用 = input（无 cache，excludes output）
    expect(result.usage?.contextLength).toBe(100);
  });

  it('uses last turn full prompt as contextLength when no compact (includes cache)', () => {
    // 无 compact 时 contextLength = 末轮窗口占用 = input+cacheRead+cacheCreation（excludes output）。
    // 累加所有 turn 会得到 N×context 的虚假巨值（regression:
    // 大量 turn 累加远超实际 context 值）。
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q1"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a1"}],"usage":{"input_tokens":100,"output_tokens":20}}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q2"}]}}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"a2"}],"usage":{"input_tokens":5000,"output_tokens":50}}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q3"}]}}',
      '{"type":"assistant","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"a3"}],"usage":{"input_tokens":90000,"output_tokens":100}}}',
    ]);
    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.usage?.compactCount).toBe(0);
    // contextLength = 最后一个 turn 的窗口占用（无 cache 时 = input，excludes output），不是所有 turn 累加
    expect(result.usage?.contextLength).toBe(90000);
    // 非累计字段 = 末轮 scope；累计字段 = session 总和（用于 cost 计算）
    expect(result.usage?.inputTokens).toBe(90000); // 末轮 m3
    expect(result.usage?.outputTokens).toBe(100); // 末轮 m3
    expect(result.usage?.cumulativeInputTokens).toBe(95100); // 100+5000+90000
    expect(result.usage?.cumulativeOutputTokens).toBe(170); // 20+50+100
  });

  it('compact after continued conversation uses last full prompt (not stale postTokens)', () => {
    // 场景：compact 后又有多轮对话，postTokens=5000 已过期，末条消息 input+cache=60000
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q1"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a1"}],"usage":{"input_tokens":100000,"output_tokens":100}}}',
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":5000}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q2"}]}}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"a2"}],"usage":{"input_tokens":50000,"output_tokens":50,"cache_read_input_tokens":8000,"cache_creation_input_tokens":2000}}}',
    ]);
    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    // contextLength = max(postTokens=5000, 末轮窗口占用=50000+8000+2000=60000) = 60000
    // (review P2-8: input+cacheRead+cacheCreation, excludes output)
    expect(result.usage?.contextLength).toBe(60000);
  });

  it('contextLength includes cache_read when no compact', () => {
    // 场景：无 compact、有 cache_read（input=100、output=50、cache_read=9000）→ contextLength=9100
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"q"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":9000,"cache_creation_input_tokens":0}}}',
    ]);
    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    // contextLength = input+cacheRead+cacheCreation = 100+9000+0 = 9100 (excludes output, review P2-8)
    expect(result.usage?.contextLength).toBe(9100);
  });

  it('falls back to reading the whole file when no user message is found', () => {
    // Malformed/very old jsonl without a user message: should still produce
    // some content rather than an empty card.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"orphan assistant text"}]}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.events.map((e) => e.content)).toEqual(['orphan assistant text']);
  });
});

describe('listClaudeSessions', () => {
  it('lists session files by mtime even when jsonl lacks a result event', () => {
    // list uses only stat + summarize (first user text), so a tail that lacks
    // `type:"result"` must still show the session in the list.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello world"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hi back"}]}}',
    ]);

    const sessions = listClaudeSessions('/tmp/proj', { projectsDir: tmpDir });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(sessionId);
    expect(sessions[0].summary).toContain('hello world');
  });

  it('test_anchor_summary_skips_leading_task_notification', () => {
    // Regression 2026-08-11: when the first user record is a task-notification
    // (Claude CLI sub-agent completion), summarizeSession must skip it and find
    // the real first user input instead of returning the XML tag text.
    writeSession('/tmp/proj', [
      // Notification happens to be the first user record
      '{"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>\\n<task-id>aa11bb22</task-id>\\n</task-notification>"}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"real first question"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":5}}}',
    ]);
    const sessions = listClaudeSessions('/tmp/proj', { projectsDir: tmpDir });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).not.toContain('<task-notification');
    expect(sessions[0].summary).toContain('real first question');
  });
});

describe('cwd decoded from JSONL (regression: 2026-06-21 /resume & /cd paths)', () => {
  // The directory name under ~/.claude/projects/ is lossy: it encodes
  // BOTH `/` and `_` as `-`, so `/mnt/data_d/reports` and
  // `/mnt/data-d/reports` both produce the same directory name
  // (`-mnt-data-d-reports`). The only reliable source for cwd is
  // the JSONL `cwd` field written by Claude CLI on every event.

  it('parseSessionJsonl returns the cwd from a system init line', () => {
    const dir = path.join(tmpDir, 'data_d-proj');
    fs.mkdirSync(dir);
    const sid = 'cwd-data-d';
    fs.writeFileSync(
      path.join(dir, `${sid}.jsonl`),
      '{"type":"system","subtype":"init","session_id":"s","cwd":"/mnt/data_d/reports","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task"}]}}\n' +
        '{"type":"result","subtype":"success","session_id":"s"}\n',
    );

    // 统一 parser 的 cwdSet 必须包含原样 cwd，NOT 从目录名反推的解码值
    const cwdSet = parseSessionJsonl(path.join(dir, `${sid}.jsonl`)).cwdSet;
    expect(cwdSet.has('/mnt/data_d/reports')).toBe(true);
    // The wrong decoded form would be `/mnt/data/d/reports`
    expect(cwdSet.has('/mnt/data/d/reports')).toBe(false);
  });

  it('parseSessionJsonl preserves hyphens in cwd (e.g. lark-remote)', () => {
    const dir = path.join(tmpDir, 'lark-remote');
    fs.mkdirSync(dir);
    const sid = 'cwd-lark-remote';
    fs.writeFileSync(
      path.join(dir, `${sid}.jsonl`),
      '{"type":"system","subtype":"init","session_id":"s","cwd":"/home/user/my-project","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task"}]}}\n',
    );

    const cwdSet = parseSessionJsonl(path.join(dir, `${sid}.jsonl`)).cwdSet;
    // The wrong decoded form would split `my-project` into `my/project`
    expect(cwdSet.has('/home/user/my-project')).toBe(true);
    expect(cwdSet.has('/home/user/my/project')).toBe(false);
  });

  it('listClaudeSessions filters jsonl files by cwd field across directory-name collisions', () => {
    // Two real cwds that encode to the SAME directory name. Claude encodes
    // BOTH `/` and `_` as `-`, so `data_d/foo` and `data-d/foo` both encode
    // to `-mnt-data-d-foo`. Both jsonls live in that one directory;
    // listClaudeSessions must use the cwd field to pick the right one.
    //
    // Regression 2026-06-21 cwd decoding.
    const sharedDir = path.join(tmpDir, '-mnt-data-d-foo'); // what projectDirForCwd('/mnt/data_d/foo') and projectDirForCwd('/mnt/data-d/foo') both return
    fs.mkdirSync(sharedDir, { recursive: true });

    // session A: cwd = /mnt/data_d/foo (underscore variant)
    fs.writeFileSync(
      path.join(sharedDir, 'a.jsonl'),
      '{"type":"system","subtype":"init","session_id":"a","cwd":"/mnt/data_d/foo","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"under-d"}]}}\n',
    );
    // session B: cwd = /mnt/data-d/foo (hyphen variant)
    fs.writeFileSync(
      path.join(sharedDir, 'b.jsonl'),
      '{"type":"system","subtype":"init","session_id":"b","cwd":"/mnt/data-d/foo","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"under-hyphen"}]}}\n',
    );

    // Asking for the underscore variant must only return session A, even
    // though both jsonls share the same parent directory.
    const sessionsA = listClaudeSessions('/mnt/data_d/foo', { projectsDir: tmpDir });
    expect(sessionsA.map((s) => s.sessionId)).toEqual(['a']);
    expect(sessionsA[0].summary).toContain('under-d');

    // Asking for the hyphen variant must only return session B.
    const sessionsB = listClaudeSessions('/mnt/data-d/foo', { projectsDir: tmpDir });
    expect(sessionsB.map((s) => s.sessionId)).toEqual(['b']);
    expect(sessionsB[0].summary).toContain('under-hyphen');
  });

  it('listClaudeSessions returns [] when no jsonl in the directory matches the requested cwd', () => {
    // Directory exists with one jsonl, but its cwd is something else — the
    // caller asked for a different cwd. Should return [] (not the wrong
    // session).
    const dir = path.join(tmpDir, 'some-proj');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 's.jsonl'),
      '{"type":"system","subtype":"init","session_id":"s","cwd":"/the/real/cwd","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task"}]}}\n',
    );

    expect(listClaudeSessions('/a/different/cwd', { projectsDir: tmpDir })).toEqual([]);
  });

  it('getNewestSession picks the mtime-newest jsonl among the matching cwds', () => {
    const dir = path.join(tmpDir, '-p-x'); // projectDirForCwd('/p/x')
    fs.mkdirSync(dir);

    // Older session
    const older = 'older-sid';
    const olderFile = path.join(dir, `${older}.jsonl`);
    fs.writeFileSync(
      olderFile,
      '{"type":"system","subtype":"init","session_id":"' +
        older +
        '","cwd":"/p/x","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"old"}]}}\n',
    );
    const past = new Date(Date.now() - 3600_000);
    fs.utimesSync(olderFile, past, past);

    // Newer session
    const newer = 'newer-sid';
    fs.writeFileSync(
      path.join(dir, `${newer}.jsonl`),
      '{"type":"system","subtype":"init","session_id":"' +
        newer +
        '","cwd":"/p/x","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"new"}]}}\n',
    );

    const newest = getNewestSession('/p/x', { projectsDir: tmpDir });
    expect(newest?.sessionId).toBe(newer);
    expect(newest?.summary).toContain('new');
  });

  it('readSessionContent returns empty when a sessionId is found but cwd does not match', () => {
    // directory-name collision: same filename, different cwd fields.
    // /resume <sid> with the wrong cwd must NOT return the wrong session's
    // content (regression: 2026-06-21 /resume cross-cwd leak).
    const dirA = path.join(tmpDir, 'collide-a');
    const dirB = path.join(tmpDir, 'collide-b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const sid = 'same-sid';
    fs.writeFileSync(
      path.join(dirA, `${sid}.jsonl`),
      '{"type":"system","subtype":"init","session_id":"' +
        sid +
        '","cwd":"/real/cwd/A","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task A"}]}}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply A"}]}}\n',
    );
    fs.writeFileSync(
      path.join(dirB, `${sid}.jsonl`),
      '{"type":"system","subtype":"init","session_id":"' +
        sid +
        '","cwd":"/real/cwd/B","model":"opus"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task B"}]}}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply B"}]}}\n',
    );

    // Same sid under both dirs. projectDirForCwd('/real/cwd/B') encodes
    // the same way as '/real/cwd/A' if they differ only by `_` vs `-`.
    // Either way: asking for cwd A should not return B's content.
    const resultA = readSessionContent(sid, '/real/cwd/A', { projectsDir: tmpDir });
    const resultB = readSessionContent(sid, '/real/cwd/B', { projectsDir: tmpDir });

    // One of these will land on the wrong directory because the dir names
    // are different here; the important thing is the cwd-field check
    // prevents leaking the wrong content.
    if (resultA.events.length > 0) {
      expect(resultA.events.map((e) => e.content).join('|')).toContain('A');
      expect(resultA.events.map((e) => e.content).join('|')).not.toContain('B');
    }
    if (resultB.events.length > 0) {
      expect(resultB.events.map((e) => e.content).join('|')).toContain('B');
      expect(resultB.events.map((e) => e.content).join('|')).not.toContain('A');
    }
  });
});

describe('readSessionContent - aiTitle and recap extraction', () => {
  it('extracts the last ai-title from jsonl', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first task"}]}}',
      '{"type":"ai-title","aiTitle":"First Title","sessionId":"s1"}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"working..."}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second task"}]}}',
      '{"type":"ai-title","aiTitle":"Second Task Title","sessionId":"s1"}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"done"}]}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.aiTitle).toBe('Second Task Title');
  });

  it('returns undefined for aiTitle when none exists', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.aiTitle).toBeUndefined();
  });

  it('extracts the last recap (isCompactSummary) from jsonl', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task one"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}]}}',
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":1000,"postTokens":500}}',
      '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"Summary: first part"}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"task two"}]}}',
      '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"b"}]}}',
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":2000,"postTokens":800}}',
      '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"Summary: second part with more detail"}]}}',
      '{"type":"assistant","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"c"}]}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.recap).toBe('Summary: second part with more detail');
  });

  it('returns undefined for recap when none exists', () => {
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.recap).toBeUndefined();
  });

  it('displayTitle skips isMeta user messages (skill injection etc.)', () => {
    // Regression 2026-07-05: skill injection writes a `type:"user"` message
    // with `isMeta:true` to carry the skill body through the user channel.
    // Without filtering, this meta message is mistaken for "last user input"
    // and shown as 🏷️ 最近输入 — but it is NOT something the user typed.
    // Trigger window: between skill injection and the user's next real input.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"placeholder"}]}}',
      '{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /home/user/.claude/skills/article-downloader\\n\\n# article-downloader skill"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"starting download"}]}}',
    ]);

    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.displayTitle).toBe('placeholder');
    expect(result.displayTitle).not.toContain('Base directory for this skill');
  });

  it('test_anchor_displayTitle_skips_task_notification_falls_back_to_real_input', () => {
    // Regression 2026-08-11: Claude CLI injects a task-notification on sub-agent
    // completion (type:"user", isMeta absent, content is string starting with
    // "<task-notification>"). Without filtering, this overwrites the real user
    // input in displayTitle when no aiTitle exists.
    const sessionId = writeSession('/tmp/proj', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"placeholder"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":5}}}',
      // Claude CLI injected sub-agent completion notification: isMeta absent, string content
      '{"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>\\n<task-id>aa11bb22</task-id>\\n<status>completed</status>\\n</task-notification>"}}',
    ]);
    const result = readSessionContent(sessionId, '/tmp/proj', { projectsDir: tmpDir });
    expect(result.displayTitle).not.toContain('<task-notification');
    expect(result.displayTitle).toContain('placeholder');
  });
});

describe('readSessionContent - EnterWorktree relocated session', () => {
  // Regression 2026-08-04: Claude Code's EnterWorktree MOVES the transcript
  // file to the new cwd's project dir mid-session. The file then no longer
  // exists under the requested (pre-relocate) cwd's encoded dir, and a file
  // located by the new cwd is rejected by the first-cwd-only guard because
  // its first cwd field is the pre-relocate path. Both paths silently return
  // { events: [] }, so the run card's token stats fall back to per-run live
  // usage (inflated/missing cumulative fields). See
  // See worktree relocate fix (2026-08-04).
  //
  // Fixture: a single jsonl with TWO cwd segments (A then B), written ONLY
  // into B's encoded dir (A's dir is left empty — simulates the file having
  // been moved away from A's project dir). Each test uses its own tmpDir so
  // the cross-dir fallback scan is not polluted by other cases' fixtures.
  function writeRelocatedSession(projectsDir: string, sid: string): void {
    const encodedB = '/real/cwd/B'.replace(/\//g, '-'); // -real-cwd-B
    const dirB = path.join(projectsDir, encodedB);
    fs.mkdirSync(dirB, { recursive: true });
    const lines = [
      '{"type":"user","cwd":"/real/cwd/A","message":{"role":"user","content":"hi"}}',
      '{"type":"assistant","cwd":"/real/cwd/A","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":100,"output_tokens":10}}}',
      '{"type":"user","cwd":"/real/cwd/B","message":{"role":"user","content":"next"}}',
      '{"type":"assistant","cwd":"/real/cwd/B","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":200,"output_tokens":20}}}',
    ];
    fs.writeFileSync(path.join(dirB, `${sid}.jsonl`), lines.join('\n') + '\n');
  }

  it('test_anchor_locates_relocated_file_across_project_dirs_when_origin_dir_empty', () => {
    // 验证行为: 当 session 文件已被 EnterWorktree 搬离原 cwd(A) 的项目目录、
    //           只存在于新 cwd(B) 的项目目录时，readSessionContent 按 sessionId
    //           跨 projects 子目录兜底定位到文件并返回内容。
    // 缺失后果: 搬迁会话的完成卡片读不到 jsonl usage → token 统计回退到单 run
    //           live 增量，出现"数字变少/累计消失"错觉（2026-08-04 实例）。
    // 依据: worktree relocate 方案 §3.1 改动 A + §3.3 用例 1。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-relocate-r1-'));
    try {
      const sid = 'relocated-session-1';
      writeRelocatedSession(localTmp, sid);
      const result = readSessionContent(sid, '/real/cwd/A', { projectsDir: localTmp });
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.usage).toBeDefined();
      // 非累计 = 末轮 m2，累计 = session 总和
      expect(result.usage?.inputTokens).toBe(200);
      expect(result.usage?.cumulativeInputTokens).toBe(300); // 100 + 200
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_accepts_post_relocate_cwd_when_first_cwd_differs', () => {
    // 验证行为: 请求搬迁后的新 cwd(B)，文件存在于 B 的项目目录，但文件首条
    //           cwd 字段是搬迁前的 A。守卫应接受"任一 cwd 字段匹配"而非仅首条。
    // 缺失后果: run 在 worktree cwd 发起时，文件被找到却被首条-cwd 守卫拒绝，
    //           同样静默返回空 → token 统计漂移（2026-08-04 实例 run 2）。
    // 依据: worktree relocate 方案 §3.1 改动 B + §3.3 用例 2。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-relocate-r2-'));
    try {
      const sid = 'relocated-session-2';
      writeRelocatedSession(localTmp, sid);
      const result = readSessionContent(sid, '/real/cwd/B', { projectsDir: localTmp });
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.usage).toBeDefined();
      // 非累计 = 末轮 m2，累计 = session 总和
      expect(result.usage?.inputTokens).toBe(200);
      expect(result.usage?.cumulativeInputTokens).toBe(300); // 100 + 200
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_relocated_session_usage_scope_matches_whole_file', () => {
    // EnterWorktree 搬迁会话 = 同一 jsonl 含 A→B 两段 cwd。readSessionContent
    // 无论请求 A 还是 B 都读同一物理文件（跨目录兜底/index 定位），scalarScan
    // 整文件单遍扫描 → 非累计字段 = 文件末轮（B 段 m2）、累计 = 全文件 session
    // 总和（A 段 m1 + B 段 m2）。本 run ≤ 累计 不变量在搬迁场景依然成立。
    // 缺失后果: 若按"请求 cwd 的某段"过滤再聚合，会漏掉搬迁前段或把段内累计
    //           当本 run，卡片混 scope（实例：cwd=main 14 行 + worktree
    //           1097 行，两段同一文件）。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-relocate-scope-'));
    try {
      const sid = 'relocated-scope-session';
      writeRelocatedSession(localTmp, sid);
      // 请求搬迁前 cwd(A)：跨目录兜底定位到 B 目录的文件，读全文件
      const fromA = readSessionContent(sid, '/real/cwd/A', { projectsDir: localTmp });
      // 请求搬迁后 cwd(B)：index/直接定位到同一文件
      const fromB = readSessionContent(sid, '/real/cwd/B', { projectsDir: localTmp });
      // 两处读同一文件 → 非累计 = 末轮 m2（B 段），累计 = 全文件总和
      for (const result of [fromA, fromB]) {
        expect(result.events.length).toBeGreaterThan(0);
        expect(result.usage).toBeDefined();
        expect(result.usage?.inputTokens).toBe(200); // 末轮 m2
        expect(result.usage?.outputTokens).toBe(20); // 末轮 m2
        expect(result.usage?.totalTokens).toBe(200 + 20); // 末轮分项和
        expect(result.usage?.cumulativeInputTokens).toBe(300); // m1(100) + m2(200)
        expect(result.usage?.cumulativeOutputTokens).toBe(30); // m1(10) + m2(20)
        expect(result.usage!.cumulativeTotalTokens!).toBeGreaterThan(result.usage!.totalTokens!);
      }
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_rejects_foreign_cwd_after_relocate_guard_relaxation', () => {
    // 验证行为: 守卫放宽为"任一 cwd 匹配"后，对文件中完全不含的无关 cwd(C)
    //           仍拒绝，返回空 events。守卫原始目的（防目录编码 lossy 误匹配，
    //           regression 2026-06-21）不可被搬迁修复破坏。
    // 缺失后果: 守卫形同虚设 → 跨目录兜底会把任意 sessionId 同名文件捞回，
    //           /resume <sid> 错 cwd 泄漏其他会话内容。
    // 依据: worktree relocate 方案 §3.1 安全性说明 + §3.3 用例 3。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-relocate-r3-'));
    try {
      const sid = 'relocated-session-3';
      writeRelocatedSession(localTmp, sid);
      const result = readSessionContent(sid, '/real/cwd/C', { projectsDir: localTmp });
      expect(result.events).toEqual([]);
      expect(result.usage).toBeUndefined();
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  // probe: 跨目录兜底在多个项目目录含同名 sessionId 文件时，sort 后 first-match
  // 若被守卫拒绝不会继续尝试下一个目录。这是已知边界（方案 §3.1 接受此限制），
  // 探针记录当前行为，供后续评估是否需要"守卫不过则继续扫描"。spec 未要求多目录
  // fallback，故标 probe；若绿按 spec 语义（返回空）实现则 probe 绿，不阻塞。
  it('test_probe_cross_dir_fallback_stops_at_first_sort_match_even_if_guard_rejects', () => {
    // 假设的预期行为: 两目录都含 sid.jsonl，sort 靠前的 dirX 文件 cwd=X（≠请求 Y），
    // dirY 文件 cwd=Y（=请求）。理想行为应继续扫描到 dirY 命中；当前实现 first-match
    // 即 dirX，守卫拒绝 → 返回空，即使 dirY 有匹配文件。
    // spec 哪里没说清: 方案 §3.1 只说"多个目录同名时排序保证确定性，守卫负责验证；
    // 守卫不过照样返回空"，未规定是否应继续扫描下一个目录。
    // 为什么重要: 同 sessionId 跨不同 cwd 项目目录撞名虽罕见，但若发生，搬迁会话
    // 在"旧目录残留 + 新目录正本"并存时会读到空。EnterWorktree 搬迁是 move（旧目录
    // 应无残留），故现实概率低——这正是降级为 probe 而非 anchor 的原因。
    //
    // 可观察构造: 请求一个主目录不存在的 cwd(/real/cwd/Z)，强制走跨目录兜底；dirX
    // (cwd=X) 与 dirY(cwd=Y) 都含 sid 文件但都不含 Z。first-match=dirX 被守卫拒绝后
    // 不继续到 dirY → 返回空（两文件都不含 Z，无论是否继续扫描结果都是空，但锁定了
    // "first-match + 守卫" 的确定行为不抛错、不泄漏）。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-relocate-probe1-'));
    try {
      const sid = 'clash-sid';
      const dirX = path.join(localTmp, '-real-cwd-X');
      fs.mkdirSync(dirX, { recursive: true });
      fs.writeFileSync(
        path.join(dirX, `${sid}.jsonl`),
        '{"type":"user","cwd":"/real/cwd/X","message":{"role":"user","content":"x"}}\n' +
          '{"type":"assistant","cwd":"/real/cwd/X","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":10,"output_tokens":1}}}\n',
      );
      const dirY = path.join(localTmp, '-real-cwd-Y');
      fs.mkdirSync(dirY, { recursive: true });
      fs.writeFileSync(
        path.join(dirY, `${sid}.jsonl`),
        '{"type":"user","cwd":"/real/cwd/Y","message":{"role":"user","content":"y"}}\n' +
          '{"type":"assistant","cwd":"/real/cwd/Y","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"y"}],"usage":{"input_tokens":20,"output_tokens":2}}}\n',
      );

      // 请求 cwd=Z（无主目录），走跨目录兜底；两候选文件都不含 Z → 守卫拒绝。
      // 锁定行为: 返回空，不抛错，不泄漏 X 或 Y 的内容。
      const result = readSessionContent(sid, '/real/cwd/Z', { projectsDir: localTmp });
      expect(result.events).toEqual([]);
      expect(result.usage).toBeUndefined();
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_probe_cross_dir_fallback_returns_empty_when_projects_dir_missing', () => {
    // 边界探针 (T4): projectsDir 本身不存在时，readSessionContent 主目录 miss，
    // 跨目录兜底 findSessionFileInProjects 对不存在的 projectsDir readdirSync 抛错
    // 被 catch → undefined → 返回空。验证不抛未捕获异常、确定返回空。
    // spec 依据: 方案 §3.1 findSessionFileInProjects try/catch readdirSync。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-relocate-probe2-'));
    try {
      const missingProjects = path.join(localTmp, 'does-not-exist');
      const result = readSessionContent('any-sid', '/any/cwd', { projectsDir: missingProjects });
      expect(result.events).toEqual([]);
      expect(result.usage).toBeUndefined();
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });
});

describe('listClaudeSessions - EnterWorktree relocated session', () => {
  // P1 regression: Claude EnterWorktree 搬迁 session 后，transcript 文件移至新 cwd 的项目目录，
  // 但文件首条 cwd 仍是搬迁前的原目录。readSessionContent 使用 jsonlContainsCwd（任一 cwd
  // 匹配即可）能正确读取；但 listClaudeSessions 使用 readCwdFromJsonl（仅首条 cwd）过滤，
  // 导致搬迁后的 session 不出现在 /resume 列表中。两者 cwd 判断逻辑不一致。
  //
  // 场景：session 首条 cwd=/home/user/proj（原目录），搬迁后 cwd=/home/user/proj/.claude/worktrees/fix
  // 文件仅存在于搬迁后目录的 encoded 项目目录下。用户在 worktree 目录执行 /resume 时：
  // - readSessionContent(sid, worktreeCwd) → jsonlContainsCwd 扴到 worktreeCwd → ✅ 能读
  // - listClaudeSessions(worktreeCwd) → readCwdFromJsonl 只看首条=原目录 ≠ worktreeCwd → ❌ 不列出
  //
  // 构造方式：复用 readSessionContent 测试的 writeRelocatedSession 模式——文件仅写在 B 的
  // 项目目录，首条 cwd 是 A，请求 B。

  function writeRelocatedSessionForList(projectsDir: string, sid: string): void {
    const encodedB = '/home/user/proj-worktree'.replace(/\//g, '-');
    const dirB = path.join(projectsDir, encodedB);
    fs.mkdirSync(dirB, { recursive: true });
    const lines = [
      '{"type":"system","subtype":"init","session_id":"' +
        sid +
        '","cwd":"/home/user/proj","model":"opus"}',
      '{"type":"user","cwd":"/home/user/proj","message":{"role":"user","content":"fix the bug"}}',
      '{"type":"assistant","cwd":"/home/user/proj","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"working on it"}],"usage":{"input_tokens":100,"output_tokens":10}}}',
      // EnterWorktree: cwd switches to the worktree directory
      '{"type":"user","cwd":"/home/user/proj-worktree","message":{"role":"user","content":"continue in worktree"}}',
      '{"type":"assistant","cwd":"/home/user/proj-worktree","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"done in worktree"}],"usage":{"input_tokens":200,"output_tokens":20}}}',
    ];
    fs.writeFileSync(path.join(dirB, `${sid}.jsonl`), lines.join('\n') + '\n');
  }

  it('test_anchor_list_includes_relocated_session_when_post_relocate_cwd_matches', () => {
    // 验证行为: listClaudeSessions 对搬迁后的 worktree cwd(/home/user/proj-worktree)
    //           应列出该 session，与 readSessionContent 读取结果一致。
    // 缺失后果: /resume 列表看不到搬迁后的 session；自动恢复也找不到。
    // 依据: P1 描述——listClaudeSessions 应复用与 readSessionContent 一致的 cwd 判断逻辑。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-list-relocate-1-'));
    try {
      const sid = 'relocated-for-list-1';
      writeRelocatedSessionForList(localTmp, sid);

      // readSessionContent 确认：readSessionContent 用 jsonlContainsCwd 能读到
      const content = readSessionContent(sid, '/home/user/proj-worktree', {
        projectsDir: localTmp,
      });
      expect(content.events.length).toBeGreaterThan(0);

      // listClaudeSessions 对同一 cwd 应也能列出该 session（当前失败：首条 cwd ≠ worktree）
      const sessions = listClaudeSessions('/home/user/proj-worktree', { projectsDir: localTmp });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(sid);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_getNewestSession_finds_relocated_session_when_post_relocate_cwd_matches', () => {
    // 验证行为: getNewestSession 对搬迁后的 worktree cwd 应返回该 session，
    //           用于自动恢复场景（bridge 重启后恢复上次 session）。
    // 缺失后果: 自动恢复找不到搬迁后的 session，每次重启都开新 session。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-list-relocate-2-'));
    try {
      const sid = 'relocated-for-list-2';
      writeRelocatedSessionForList(localTmp, sid);

      const newest = getNewestSession('/home/user/proj-worktree', { projectsDir: localTmp });
      expect(newest).toBeDefined();
      expect(newest?.sessionId).toBe(sid);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_list_includes_relocated_session_from_original_cwd', () => {
    // 验证行为: 从原 cwd(/home/user/proj) 请求列表时，session 文件已搬迁到 B 的
    //           项目目录，A 的目录下没有该文件。listClaudeSessions 通过跨目录兜底
    //           扫描 scanRelocatedSessions 找到 B 目录下的文件并验证 cwd 包含 A
    //           → 列出该 session。与 readSessionContent 行为一致。
    // 依据: P1 修复 2026-08-10，scanClaudeSessions 增加跨目录 fallback + cwd 守卫
    //       从 readCwdFromJsonl 改为 jsonlContainsCwd。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-list-relocate-3-'));
    try {
      const sid = 'relocated-for-list-3';
      writeRelocatedSessionForList(localTmp, sid);

      // A 的 encoded 目录下没有文件 → 主扫描找不到，但跨目录兜底扫描 B 目录，
      // jsonlContainsCwd 确认文件包含 cwd=A → 列出
      const content = readSessionContent(sid, '/home/user/proj', { projectsDir: localTmp });
      expect(content.events.length).toBeGreaterThan(0);

      const sessions = listClaudeSessions('/home/user/proj', { projectsDir: localTmp });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(sid);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });
});

describe('isClaudeSessionActive - EnterWorktree relocated session', () => {
  // P1 follow-up: isClaudeSessionActive must use the same cross-dir fallback
  // + jsonlContainsCwd guard as readSessionContent and listClaudeSessions,
  // otherwise a relocated session can be listed but falsely reported as inactive.

  function writeRelocatedSessionForActive(projectsDir: string, sid: string): string {
    const encodedB = '/home/user/proj-worktree'.replace(/\//g, '-');
    const dirB = path.join(projectsDir, encodedB);
    fs.mkdirSync(dirB, { recursive: true });
    const lines = [
      '{"type":"system","subtype":"init","session_id":"' +
        sid +
        '","cwd":"/home/user/proj","model":"opus"}',
      '{"type":"user","cwd":"/home/user/proj","message":{"role":"user","content":"hi"}}',
      '{"type":"assistant","cwd":"/home/user/proj","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":100,"output_tokens":10}}}',
      '{"type":"user","cwd":"/home/user/proj-worktree","message":{"role":"user","content":"next"}}',
      '{"type":"assistant","cwd":"/home/user/proj-worktree","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":200,"output_tokens":20}}}',
    ];
    const filePath = path.join(dirB, `${sid}.jsonl`);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    // Touch mtime to now so isSessionActive doesn't reject by STALE_MS
    const now = new Date();
    fs.utimesSync(filePath, now, now);
    return filePath;
  }

  it('test_anchor_is_active_finds_relocated_session_from_worktree_cwd', () => {
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-active-relocate-1-'));
    try {
      const sid = 'relocated-for-active-1';
      writeRelocatedSessionForActive(localTmp, sid);

      // File is in B's dir (worktree), not A's. isClaudeSessionActive must
      // use findSessionFileInProjects + jsonlContainsCwd to locate and verify.
      const active = isClaudeSessionActive(sid, '/home/user/proj-worktree', {
        projectsDir: localTmp,
      });
      expect(active).toBe(true);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_is_active_finds_relocated_session_from_original_cwd', () => {
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-active-relocate-2-'));
    try {
      const sid = 'relocated-for-active-2';
      writeRelocatedSessionForActive(localTmp, sid);

      // From original cwd — file not in A's dir, cross-dir fallback needed
      const active = isClaudeSessionActive(sid, '/home/user/proj', {
        projectsDir: localTmp,
      });
      expect(active).toBe(true);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_is_active_rejects_foreign_cwd_for_relocated_session', () => {
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-active-relocate-3-'));
    try {
      const sid = 'relocated-for-active-3';
      writeRelocatedSessionForActive(localTmp, sid);

      // Foreign cwd not in the jsonl — must return false even with cross-dir fallback
      const active = isClaudeSessionActive(sid, '/real/cwd/C', { projectsDir: localTmp });
      expect(active).toBe(false);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_is_active_returns_false_when_no_file_found', () => {
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-active-relocate-4-'));
    try {
      const sid = 'nonexistent-session';
      writeRelocatedSessionForActive(localTmp, 'other-session');

      const active = isClaudeSessionActive(sid, '/home/user/proj-worktree', {
        projectsDir: localTmp,
      });
      expect(active).toBe(false);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });
});

describe('listClaudeSessions - S2 relocated-out gap fix', () => {
  // S2 fix: removed primarySessions.length === 0 guard so relocated-out
  // sessions are visible even when the primary dir has other sessions.
  // scanRelocatedSessions now uses readCwdFromJsonl (first cwd only)
  // instead of jsonlContainsCwd (full-file scan) for ~10× performance.

  /**
   * Write a normal session in the PRIMARY project dir for a given cwd.
   * This simulates sessions that were NOT relocated — they stay in their
   * original project directory.
   */
  function writeNormalSession(projectsDir: string, cwd: string, sid: string): void {
    const encoded = cwd.replace(/\//g, '-');
    const dir = path.join(projectsDir, encoded);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${cwd}","model":"opus"}`,
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"normal session ${sid}"}]}}`,
    ];
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
  }

  /**
   * Write a relocated-out session: started in `originCwd` but the transcript
   * was moved to `targetCwd`'s project dir (by EnterWorktree). The first cwd
   * in the JSONL is `originCwd` (the pre-relocate path).
   */
  function writeRelocatedOutSession(
    projectsDir: string,
    originCwd: string,
    targetCwd: string,
    sid: string,
  ): void {
    const encodedTarget = targetCwd.replace(/\//g, '-');
    const dirTarget = path.join(projectsDir, encodedTarget);
    fs.mkdirSync(dirTarget, { recursive: true });
    const lines = [
      `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${originCwd}","model":"opus"}`,
      `{"type":"user","cwd":"${originCwd}","message":{"role":"user","content":"started in origin"}}`,
      `{"type":"assistant","cwd":"${originCwd}","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"working"}],"usage":{"input_tokens":100,"output_tokens":10}}}`,
      `{"type":"user","cwd":"${targetCwd}","message":{"role":"user","content":"relocated"}}`,
      `{"type":"assistant","cwd":"${targetCwd}","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"done in worktree"}],"usage":{"input_tokens":200,"output_tokens":20}}}`,
    ];
    fs.writeFileSync(path.join(dirTarget, `${sid}.jsonl`), lines.join('\n') + '\n');
  }

  it('test_anchor_relocated_out_visible_when_primary_has_other_sessions', () => {
    // S2 core fix: primary dir has 2 normal sessions + 3 relocated-out sessions
    // in other project dirs. All 5 should appear in the list.
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-s2-gap-1-'));
    try {
      const cwd = '/home/user/proj';

      // 2 normal sessions in the primary dir
      writeNormalSession(localTmp, cwd, 'normal-1');
      writeNormalSession(localTmp, cwd, 'normal-2');

      // 3 relocated-out sessions: started in cwd, moved to different worktrees
      writeRelocatedOutSession(localTmp, cwd, '/home/user/proj-worktree-a', 'relocated-1');
      writeRelocatedOutSession(localTmp, cwd, '/home/user/proj-worktree-b', 'relocated-2');
      writeRelocatedOutSession(localTmp, cwd, '/home/user/proj-worktree-c', 'relocated-3');

      const sessions = listClaudeSessions(cwd, { projectsDir: localTmp });
      const ids = sessions.map((s) => s.sessionId);

      // All 5 sessions should be found (2 normal + 3 relocated-out)
      expect(ids).toContain('normal-1');
      expect(ids).toContain('normal-2');
      expect(ids).toContain('relocated-1');
      expect(ids).toContain('relocated-2');
      expect(ids).toContain('relocated-3');
      expect(sessions).toHaveLength(5);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_seen_ids_prevents_duplicate_when_same_sid_in_primary_and_cross_dir', () => {
    // If the same sessionId appears in both the primary dir and a cross-dir
    // scan, the result should contain it only once (seenIds dedup).
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-s2-dedup-'));
    try {
      const cwd = '/home/user/proj';

      // Write a normal session in the primary dir
      const encoded = cwd.replace(/\//g, '-');
      const primaryDir = path.join(localTmp, encoded);
      fs.mkdirSync(primaryDir, { recursive: true });
      fs.writeFileSync(
        path.join(primaryDir, 'shared-sid.jsonl'),
        `{"type":"system","subtype":"init","session_id":"shared-sid","cwd":"${cwd}","model":"opus"}\n` +
          '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"in primary"}]}}\n',
      );

      // Write the same sessionId in a cross-dir project dir
      const otherDir = path.join(localTmp, '-home-user-other');
      fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(
        path.join(otherDir, 'shared-sid.jsonl'),
        `{"type":"system","subtype":"init","session_id":"shared-sid","cwd":"${cwd}","model":"opus"}\n` +
          '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"in other"}]}}\n',
      );

      const sessions = listClaudeSessions(cwd, { projectsDir: localTmp });
      const matching = sessions.filter((s) => s.sessionId === 'shared-sid');
      expect(matching).toHaveLength(1);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_later_cwd_visible_when_file_stays_in_origin_dir', () => {
    // session-index 修复: 文件在 A 的项目目录、但 cwdSet 含 {A, C} 时，查 C
    // 必须列出该 session。旧 S2 实现用 readCwdFromJsonl（仅首条 cwd）做跨目录
    // 兜底，firstCwd=A ≠ C 被跳过；统一 parser 的完整 cwd 集合修掉这个缺口
    // （A→B→C 连续搬迁场景的同一家族，见 session-index-manual.md「核心 bug 锚点」）。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-s2-limit-'));
    try {
      // Session started in A, visited C later. File is in A's project dir.
      const encodedA = '/home/user/proj-a'.replace(/\//g, '-');
      const dirA = path.join(localTmp, encodedA);
      fs.mkdirSync(dirA, { recursive: true });
      fs.writeFileSync(
        path.join(dirA, 'cross-proj.jsonl'),
        '{"type":"system","subtype":"init","session_id":"cross-proj","cwd":"/home/user/proj-a","model":"opus"}\n' +
          '{"type":"user","cwd":"/home/user/proj-a","message":{"role":"user","content":"start in a"}}\n' +
          '{"type":"user","cwd":"/home/user/proj-c","message":{"role":"user","content":"cd to c"}}\n',
      );

      const sessions = listClaudeSessions('/home/user/proj-c', {
        projectsDir: localTmp,
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('cross-proj');
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_phase1_still_finds_relocated_in_sessions', () => {
    // Phase 1 (scanDirForSessions) uses jsonlContainsCwd (any cwd match).
    // A session that was relocated INTO the primary dir has firstCwd ≠ queryCwd
    // but a later cwd matches → Phase 1 must still find it.
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-s2-phase1-'));
    try {
      const cwd = '/home/user/proj-b';
      const encoded = cwd.replace(/\//g, '-');
      const primaryDir = path.join(localTmp, encoded);
      fs.mkdirSync(primaryDir, { recursive: true });

      // Session started in proj-a, relocated INTO proj-b (file now in proj-b's dir)
      fs.writeFileSync(
        path.join(primaryDir, 'moved-in.jsonl'),
        '{"type":"system","subtype":"init","session_id":"moved-in","cwd":"/home/user/proj-a","model":"opus"}\n' +
          '{"type":"user","cwd":"/home/user/proj-a","message":{"role":"user","content":"start in a"}}\n' +
          '{"type":"user","cwd":"/home/user/proj-b","message":{"role":"user","content":"relocated to b"}}\n',
      );

      const sessions = listClaudeSessions(cwd, { projectsDir: localTmp });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('moved-in');
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });
});

describe('listClaudeSessions - session-index A→B→C integration', () => {
  // session-index-manual.md 核心 bug: EnterWorktree 连续搬迁 A→B→C 后，transcript
  // 文件物理位于 C 的项目目录，cwdSet = {A, B, C}。旧 scanRelocatedSessions 用
  // readCwdFromJsonl 只取首条 cwd(A) 判等，查 B 时 A !== B 被跳过 → /resume 列表漏列。
  // 索引按完整 cwd 集合查询，三段 cwd 任一都可列出。
  function writeAbcRelocatedSession(projectsDir: string, sid: string): void {
    const encodedC = '/home/user/proj-c'.replace(/\//g, '-');
    const dirC = path.join(projectsDir, encodedC);
    fs.mkdirSync(dirC, { recursive: true });
    const lines = [
      '{"type":"system","subtype":"init","session_id":"' +
        sid +
        '","cwd":"/home/user/proj-a","model":"opus"}',
      '{"type":"user","cwd":"/home/user/proj-a","message":{"role":"user","content":"start in a"}}',
      '{"type":"assistant","cwd":"/home/user/proj-a","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"working"}],"usage":{"input_tokens":100,"output_tokens":10}}}',
      '{"type":"user","cwd":"/home/user/proj-b","message":{"role":"user","content":"enter worktree b"}}',
      '{"type":"assistant","cwd":"/home/user/proj-b","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"done in b"}],"usage":{"input_tokens":200,"output_tokens":20}}}',
      '{"type":"user","cwd":"/home/user/proj-c","message":{"role":"user","content":"enter worktree c"}}',
      '{"type":"assistant","cwd":"/home/user/proj-c","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"done in c"}],"usage":{"input_tokens":300,"output_tokens":30}}}',
    ];
    fs.writeFileSync(path.join(dirC, `${sid}.jsonl`), lines.join('\n') + '\n');
  }

  it('test_anchor_list_includes_intermediate_cwd_after_a_b_c_relocation', () => {
    // 验证行为: A→B→C 搬迁后，文件在 C 目录、首条 cwd 是 A，listClaudeSessions(B)
    // 必须列出该 session（完整 cwd 集合含 B）。
    // 缺失后果: /resume 在中间 cwd(B) 看不到搬迁会话，自动恢复找不到 B 的 session。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-abc-list-'));
    try {
      const sid = 'abc-relocated-session';
      writeAbcRelocatedSession(localTmp, sid);

      const sessions = listClaudeSessions('/home/user/proj-b', { projectsDir: localTmp });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(sid);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });
});

describe('readSessionContent / isClaudeSessionActive - session-index guard integration', () => {
  // Slice 3（session-index-manual.md）: 按 ID 恢复与活跃判断走索引定位，定位后
  // re-stat 比 fingerprint 做实时守卫（拍板 3）；索引 miss / 未构建走旧 fallback。
  // 以下 fixture 全部用合成数据（AABB UUID / /home/user/... / "placeholder"）。

  const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
  const CWD_A = '/home/user/project-a';
  const CWD_B = '/home/user/project-b';

  function writeSessionFile(
    projectsDir: string,
    dirName: string,
    sid: string,
    cwdSet: string[],
    tailLines: string[] = [],
  ): string {
    const dir = path.join(projectsDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [
      `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${cwdSet[0]}","model":"opus"}`,
      ...cwdSet.map(
        (c, i) =>
          `{"type":"user","cwd":"${c}","message":{"role":"user","content":"placeholder ${i}"}}`,
      ),
      ...tailLines,
    ];
    const filePath = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    return filePath;
  }

  it('test_anchor_index_read_prefers_path_with_matching_cwd_over_direct_dir', () => {
    // 核心红测试: 请求 cwd B 时，B 的 encoded 目录下存在同名但 cwd 不匹配的文件，
    // 真正含 cwd B 的 session 在另一个项目目录。旧实现直接命中错误文件 → 守卫拒绝
    // → 空结果（/resume 读空、token 统计漂移）。索引按 sessionId 检查全部路径，
    // 用 cwdSet 过滤到正确文件。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-idx-guard-collide-'));
    try {
      // 错误文件: 位于 B 的 encoded 目录，但 cwdSet 只有 A（lossy 编码碰撞的现实形态）
      const encodedB = CWD_B.replace(/\//g, '-');
      writeSessionFile(localTmp, encodedB, SID, [CWD_A]);
      // 正确文件: 位于 A 的 encoded 目录，cwdSet = {A, B}
      const encodedA = CWD_A.replace(/\//g, '-');
      writeSessionFile(
        localTmp,
        encodedA,
        SID,
        [CWD_A, CWD_B],
        [
          '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"real b session"}],"usage":{"input_tokens":10,"output_tokens":5}}}',
        ],
      );

      // 构建索引（列表触发首次全量扫描）
      const sessions = listClaudeSessions(CWD_A, { projectsDir: localTmp });
      // 同一 sessionId 命中两个路径时列表去重为 1；索引仍记录两个路径供按 ID 定位
      expect(sessions).toHaveLength(1);

      const result = readSessionContent(SID, CWD_B, { projectsDir: localTmp });
      expect(result.events.map((e) => e.content)).toContain('real b session');
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_index_read_reparses_on_fingerprint_change_and_accepts_new_cwd', () => {
    // 拍板 3 正向: 索引构建后文件被 append（fingerprint 变），再次读取必须重解析
    // 单文件后再守卫，不能用过期 cwdSet 拒绝新 cwd。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-idx-guard-pos-'));
    try {
      const encodedA = CWD_A.replace(/\//g, '-');
      writeSessionFile(localTmp, encodedA, SID, [CWD_A]);

      const sessions = listClaudeSessions(CWD_A, { projectsDir: localTmp });
      expect(sessions).toHaveLength(1);

      // append B 段 → fingerprint 变化
      fs.appendFileSync(
        path.join(localTmp, encodedA, `${SID}.jsonl`),
        `{"type":"user","cwd":"${CWD_B}","message":{"role":"user","content":"worktree b"}}\n` +
          '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"done in b"}],"usage":{"input_tokens":20,"output_tokens":10}}}\n',
      );

      const result = readSessionContent(SID, CWD_B, { projectsDir: localTmp });
      expect(result.events.map((e) => e.content)).toContain('done in b');
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_index_read_rejects_cwd_removed_after_indexing', () => {
    // 拍板 3 反向: 索引构建时 cwdSet 含 B；文件随后被重写为不含 B。定位后 re-stat
    // 发现 fingerprint 变 → 重解析 → 守卫拒绝。禁止用过期索引放行（foreign cwd 泄漏）。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-idx-guard-neg-'));
    try {
      const encodedA = CWD_A.replace(/\//g, '-');
      writeSessionFile(
        localTmp,
        encodedA,
        SID,
        [CWD_A, CWD_B],
        [
          '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"with b"}]}}',
        ],
      );

      const sessions = listClaudeSessions(CWD_A, { projectsDir: localTmp });
      expect(sessions).toHaveLength(1);

      // 重写文件: 只剩 A 段（B 消失）
      writeSessionFile(
        localTmp,
        encodedA,
        SID,
        [CWD_A],
        [
          '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"without b"}]}}',
        ],
      );

      const result = readSessionContent(SID, CWD_B, { projectsDir: localTmp });
      expect(result.events).toEqual([]);
      expect(result.usage).toBeUndefined();
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_index_read_falls_back_to_projects_scan_on_miss', () => {
    // 索引 miss（新文件在构建后才出现）→ 精确 sessionId 全目录 fallback 仍工作。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-idx-guard-miss-'));
    try {
      const encodedA = CWD_A.replace(/\//g, '-');
      writeSessionFile(localTmp, encodedA, SID, [CWD_A]);

      listClaudeSessions(CWD_A, { projectsDir: localTmp });

      // 构建后新增 session（不在索引里）
      const newSid = 'bbbbbbbb-1111-2222-3333-444444444444';
      writeSessionFile(
        localTmp,
        encodedA,
        newSid,
        [CWD_A],
        [
          '{"type":"assistant","message":{"id":"m9","role":"assistant","content":[{"type":"text","text":"new session"}]}}',
        ],
      );

      const result = readSessionContent(newSid, CWD_A, { projectsDir: localTmp });
      expect(result.events.map((e) => e.content)).toContain('new session');
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });

  it('test_anchor_index_active_rejects_cwd_removed_after_indexing', () => {
    // isClaudeSessionActive 同守卫: 索引过期 cwdSet 含 B，文件重写后不含 B →
    // re-stat 重解析 → 拒绝（false），禁止误报活跃。
    const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-idx-guard-active-'));
    try {
      const encodedA = CWD_A.replace(/\//g, '-');
      writeSessionFile(
        localTmp,
        encodedA,
        SID,
        [CWD_A, CWD_B],
        [
          '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"still going"}]}}',
        ],
      );

      listClaudeSessions(CWD_A, { projectsDir: localTmp });

      writeSessionFile(
        localTmp,
        encodedA,
        SID,
        [CWD_A],
        [
          '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"done"}]}}',
        ],
      );

      expect(isClaudeSessionActive(SID, CWD_B, { projectsDir: localTmp })).toBe(false);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });
});
