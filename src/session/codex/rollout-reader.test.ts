import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readCodexRollout,
  listCodexRollouts,
  readCodexSessionContent,
  isCodexSessionActive,
} from '../../session/codex/rollout-reader.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Path must resolve to src/logger (the reader imports '../../logger/index.js');
// the previous '../logger/index.js' pointed at a non-existent src/session/logger
// and silently left the mock dead.
vi.mock('../../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-rollout-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: create a test rollout file
function createRolloutFile(filename: string, content: string): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('codex-rollout-reader', () => {
  describe('readCodexRollout', () => {
    it('parses session_meta and response_item lines', () => {
      const content = `{"type":"session_meta","payload":{"session_id":"019f-test","cwd":"/tmp/project","originator":"lark-remote"},"timestamp":"2026-07-13T10:00:00.000Z"}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]},"timestamp":"2026-07-13T10:00:01.000Z"}
{"type":"event_msg","payload":{"type":"user_message","message":"Hello"},"timestamp":"2026-07-13T10:00:01.000Z"}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"text","text":"Hi there!"}]},"timestamp":"2026-07-13T10:00:02.000Z"}
`;
      const filePath = createRolloutFile('rollout-2026-07-13T10-00-00-019f-test.jsonl', content);
      const entry = readCodexRollout(filePath);

      expect(entry).not.toBeNull();
      expect(entry!.threadId).toBe('019f-test');
      expect(entry!.cwd).toBe('/tmp/project');
      expect(entry!.firstUserMessage).toBe('Hello');
      expect(entry!.events).toHaveLength(2);
    });

    it('returns null for non-existent file', () => {
      const entry = readCodexRollout(path.join(tmpDir, 'nonexistent.jsonl'));
      expect(entry).toBeNull();
    });

    it('returns null for file without session_meta', () => {
      const content = `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}`;
      const filePath = createRolloutFile('rollout-no-meta.jsonl', content);
      const entry = readCodexRollout(filePath);
      expect(entry).toBeNull();
    });

    it('skips malformed JSON lines', () => {
      const content = `{"type":"session_meta","payload":{"session_id":"019f-err","cwd":"/tmp","originator":"lark-remote"}}
not valid json
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Good"}]}}
`;
      const filePath = createRolloutFile('rollout-with-errors.jsonl', content);
      const entry = readCodexRollout(filePath);

      expect(entry).not.toBeNull();
      expect(entry!.threadId).toBe('019f-err');
      expect(entry!.events).toHaveLength(1);
    });

    it('extracts first user message correctly', () => {
      const content = `{"type":"session_meta","payload":{"session_id":"019f-msg","cwd":"/tmp","originator":"lark-remote"}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"text","text":"Hello!"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"First user message"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"First user message"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Second user message"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"Second user message"}}
`;
      const filePath = createRolloutFile('rollout-multi.jsonl', content);
      const entry = readCodexRollout(filePath);

      expect(entry).not.toBeNull();
      expect(entry!.firstUserMessage).toBe('First user message');
    });
  });

  describe('listCodexRollouts', () => {
    it('applies limit', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '13');
      fs.mkdirSync(sessionsDir, { recursive: true });

      for (let i = 0; i < 5; i++) {
        const file = path.join(sessionsDir, `rollout-${i}.jsonl`);
        fs.writeFileSync(
          file,
          `{"type":"session_meta","payload":{"session_id":"${i}","cwd":"/tmp","originator":"x"}}`,
          'utf-8',
        );
      }

      const result = listCodexRollouts({ codexHome: tmpDir, limit: 3 });
      expect(result.entries).toHaveLength(3);
    });

    it('filters by cwd', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '13');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const file1 = path.join(sessionsDir, 'rollout-1.jsonl');
      const file2 = path.join(sessionsDir, 'rollout-2.jsonl');

      fs.writeFileSync(
        file1,
        '{"type":"session_meta","payload":{"session_id":"s1","cwd":"/project/a","originator":"x"}}',
        'utf-8',
      );
      fs.writeFileSync(
        file2,
        '{"type":"session_meta","payload":{"session_id":"s2","cwd":"/project/b","originator":"x"}}',
        'utf-8',
      );

      const result = listCodexRollouts({ codexHome: tmpDir, cwd: '/project/a' });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].threadId).toBe('s1');
      expect(result.total).toBe(1);
    });

    it('returns empty array for non-existent codex home', () => {
      const result = listCodexRollouts({ codexHome: path.join(tmpDir, 'nonexistent') });
      expect(result).toEqual({ entries: [], total: 0 });
    });
  });

  describe('readCodexSessionContent', () => {
    it('returns session content for matching sessionId', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '13');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const file = path.join(sessionsDir, 'rollout-019f-target.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-target","cwd":"/tmp","originator":"lark-remote"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"What is 2+2?"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"What is 2+2?"}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"text","text":"It's 4."}]}}
`,
        'utf-8',
      );

      const content = readCodexSessionContent('019f-target', { codexHome: tmpDir });

      expect(content.events).toHaveLength(2);
      expect(content.displayTitle).toContain('What is 2+2?');
    });

    it('displayTitle excludes injected AGENTS.md / environment_context, uses last real user input (regression 2026-07-13)', () => {
      // Regression 2026-07-13: codex writes AGENTS.md project rules and
      // <environment_context> as `role:"user"` response_items. The reader
      // used the FIRST role:user message as displayTitle/recap, so the
      // auto-resume card showed "AGENTS.md instructions" as "最近输入".
      // Real user input is identifiable by a paired event_msg/user_message.
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '13');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const file = path.join(sessionsDir, 'rollout-019f-inject.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-inject","cwd":"/tmp/proj","originator":"lark-remote"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\\n\\n<INSTRUCTIONS>\\n# Claude rules"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"continue fixing"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"continue fixing"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\\n  <current_date>2026-07-13</current_date>\\n</environment_context>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"commit & push"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"commit & push"}}
`,
        'utf-8',
      );

      const content = readCodexSessionContent('019f-inject', { codexHome: tmpDir });
      // displayTitle = LAST real user input, never the injected AGENTS.md/env.
      expect(content.displayTitle).toBe('commit & push');
      expect(content.displayTitle).not.toContain('AGENTS.md');
      expect(content.displayTitle).not.toContain('environment_context');
      // recap is undefined (codex has no compact summary).
      expect(content.recap).toBeUndefined();
    });

    it('firstUserMessage / lastRealUserMessage skip injected user messages', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '13');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-019f-entry.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-entry","cwd":"/tmp/proj","originator":"lark-remote"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\\n<INSTRUCTIONS>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"continue fixing"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"continue fixing"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"commit & push"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"commit & push"}}
`,
        'utf-8',
      );
      const entry = readCodexRollout(file);
      expect(entry!.firstUserMessage).toBe('continue fixing');
      expect(entry!.lastRealUserMessage).toBe('commit & push');
      expect(entry!.firstUserMessage).not.toContain('AGENTS.md');
    });

    it('returns empty events for non-existent session', () => {
      const content = readCodexSessionContent('019f-does-not-exist', { codexHome: tmpDir });
      expect(content.events).toHaveLength(0);
    });
  });

  describe('readCodexSessionContent usage extraction (ccusage-aligned)', () => {
    it('test_anchor_codex_usage_extracts_model_context_window', () => {
      // 验证：token_count 事件带 model_context_window 时，usage.contextLimit
      // 必须等于该值，Run 卡片才能显示 "Context - X (Y%)"。
      // 缺失/错误会导致百分比分母缺失，卡片只能显示绝对量。
      // 依据：codex token_count.info.model_context_window（CLI 与 AppServer
      // 均上报，实测 rollout JSONL 形如
      // {"type":"event_msg","payload":{"type":"token_count","info":{...,"model_context_window":258400}}}）。
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '17');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-019f-ctx.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-ctx","cwd":"/tmp"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":15006,"cached_input_tokens":6400,"output_tokens":500,"total_tokens":15506},"total_token_usage":{"input_tokens":15006,"cached_input_tokens":6400,"output_tokens":500,"total_tokens":15506},"model_context_window":258400}}}
`,
        'utf-8',
      );

      const content = readCodexSessionContent('019f-ctx', { codexHome: tmpDir });
      expect(content.usage).toBeDefined();
      expect(content.usage!.contextLimit).toBe(258400);
    });

    it('test_anchor_codex_usage_omits_context_limit_when_window_absent', () => {
      // 验证：老版本 / 无 model_context_window 的 token_count 数据，usage 仍正常提取，
      // 但 contextLimit 必须为 undefined —— "不支持就不填"，不能编造或除零。
      // 缺失/错误会导致：旧数据被塞进错误百分比，或渲染 NaN%/Infinity%。
      // 依据：spec 摘要第 3 条；实测旧 rollout 的 token_count 只有 last/total_token_usage。
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '18');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-019f-noctx.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-noctx","cwd":"/tmp"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"total_tokens":120},"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"total_tokens":120}}}}
`,
        'utf-8',
      );

      const content = readCodexSessionContent('019f-noctx', { codexHome: tmpDir });
      expect(content.usage).toBeDefined();
      expect(content.usage!.inputTokens).toBe(60);
      expect(content.usage!.contextLimit).toBeUndefined();
    });

    it('extracts last token_count usage with input=raw-cached, cacheCreation=0', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '14');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-019f-usage.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-usage","cwd":"/tmp"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":15006,"cached_input_tokens":6400,"output_tokens":500,"total_tokens":15506},"total_token_usage":{"input_tokens":15006,"cached_input_tokens":6400,"output_tokens":500,"total_tokens":15506}}}}
`,
        'utf-8',
      );

      const content = readCodexSessionContent('019f-usage', { codexHome: tmpDir });
      expect(content.usage).toBeDefined();
      // input = raw - cached (ccusage semantics, matches live codex translator)
      expect(content.usage!.inputTokens).toBe(8606); // 15006 - 6400
      expect(content.usage!.cacheReadTokens).toBe(6400);
      // Codex never reports cache creation
      expect(content.usage!.cacheCreationTokens).toBe(0);
      expect(content.usage!.totalTokens).toBe(15506);
    });

    it('falls back to total - previous_total when last_token_usage is absent', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '15');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-019f-diff.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-diff","cwd":"/tmp"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"total_tokens":110}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":90,"output_tokens":30,"total_tokens":230}}}}
`,
        'utf-8',
      );
      const content = readCodexSessionContent('019f-diff', { codexHome: tmpDir });
      expect(content.usage).toBeDefined();
      // last turn diff: 200-100=100 input, 90-40=50 cached, 30-10=20 output, 230-110=120 total
      expect(content.usage!.inputTokens).toBe(50); // 100 - 50
      expect(content.usage!.cacheReadTokens).toBe(50);
      expect(content.usage!.totalTokens).toBe(120);
    });

    it('extracts cumulative usage from final total_token_usage', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '16');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-019f-cum.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-cum","cwd":"/tmp"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"total_tokens":110}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":20,"total_tokens":80},"total_token_usage":{"input_tokens":200,"cached_input_tokens":90,"output_tokens":30,"total_tokens":230}}}}
`,
        'utf-8',
      );
      const content = readCodexSessionContent('019f-cum', { codexHome: tmpDir });
      expect(content.usage).toBeDefined();
      // per-turn = last_token_usage: non-cached input = 50-10 = 40, output = 20
      expect(content.usage!.inputTokens).toBe(40);
      expect(content.usage!.outputTokens).toBe(20);
      // cumulative = final total_token_usage: non-cached input = 200-90 = 110, output = 30
      expect(content.usage!.cumulativeInputTokens).toBe(110);
      expect(content.usage!.cumulativeOutputTokens).toBe(30);
    });

    it('counts compacted events and reports post-compact context when session ends with compact', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '17');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-019f-compact.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-compact","cwd":"/tmp"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20430,"cached_input_tokens":0,"output_tokens":605,"total_tokens":21035},"total_token_usage":{"input_tokens":45106,"cached_input_tokens":24576,"output_tokens":695,"total_tokens":45801}}}}
{"type":"compacted","payload":{"message":"summary text","window_number":1}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"total_tokens":4777},"total_token_usage":{"input_tokens":45106,"cached_input_tokens":24576,"output_tokens":695,"total_tokens":45801}}}}
`,
        'utf-8',
      );
      const content = readCodexSessionContent('019f-compact', { codexHome: tmpDir });
      expect(content.usage).toBeDefined();
      expect(content.usage!.compactCount).toBe(1);
      // 压缩收尾 token_count 增量全 0，contextLength 用 total_tokens（压缩后窗口）
      expect(content.usage!.contextLength).toBe(4777);
      // 压缩前水位与压缩后同口径（total_tokens）：最近一次非零 token_count 的
      // total = input 20430 + output 605 = 21035（review P3-9 单位统一）。
      expect(content.usage!.compactPreContextLength).toBe(21035);
    });

    it('keeps normal-turn context after compact and still counts compactions', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '18');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-019f-compact-then-run.jsonl');
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"session_id":"019f-compact-then-run","cwd":"/tmp"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20430,"cached_input_tokens":0,"output_tokens":605,"total_tokens":21035},"total_token_usage":{"input_tokens":45106,"cached_input_tokens":24576,"output_tokens":695,"total_tokens":45801}}}}
{"type":"compacted","payload":{"message":"summary text","window_number":1}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"total_tokens":4777},"total_token_usage":{"input_tokens":45106,"cached_input_tokens":24576,"output_tokens":695,"total_tokens":45801}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":25000,"cached_input_tokens":0,"output_tokens":100,"total_tokens":25100},"total_token_usage":{"input_tokens":70106,"cached_input_tokens":24576,"output_tokens":795,"total_tokens":70901}}}}
`,
        'utf-8',
      );
      const content = readCodexSessionContent('019f-compact-then-run', { codexHome: tmpDir });
      expect(content.usage).toBeDefined();
      expect(content.usage!.compactCount).toBe(1);
      // 压缩后有普通 turn：水位回归该 turn，压缩前水位不再暴露
      expect(content.usage!.contextLength).toBe(25000);
      expect(content.usage!.compactPreContextLength).toBeUndefined();
    });
  });

  describe('isCodexSessionActive', () => {
    it('returns true for recently modified session', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '13');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const file = path.join(sessionsDir, 'rollout-active.jsonl');
      fs.writeFileSync(
        file,
        '{"type":"session_meta","payload":{"session_id":"019f-active","cwd":"/tmp","originator":"x"}}',
        'utf-8',
      );

      // Touch the file to make it recent
      const now = Date.now();
      fs.utimesSync(file, now / 1000, now / 1000);

      const active = isCodexSessionActive('019f-active', {
        codexHome: tmpDir,
        activeThresholdMs: 60_000,
      });
      expect(active).toBe(true);
    });

    it('returns false for old session', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '07', '13');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const file = path.join(sessionsDir, 'rollout-old.jsonl');
      fs.writeFileSync(
        file,
        '{"type":"session_meta","payload":{"session_id":"019f-old","cwd":"/tmp","originator":"x"}}',
        'utf-8',
      );

      // Set mtime to 30 minutes ago
      const oldTime = (Date.now() - 30 * 60 * 1000) / 1000;
      fs.utimesSync(file, oldTime, oldTime);

      const active = isCodexSessionActive('019f-old', {
        codexHome: tmpDir,
        activeThresholdMs: 10 * 60 * 1000,
      });
      expect(active).toBe(false);
    });

    it('returns false for non-existent session', () => {
      const active = isCodexSessionActive('019f-nonexistent', { codexHome: tmpDir });
      expect(active).toBe(false);
    });
  });

  // codex CLI ≥0.153.4 把顶层 `user_message` 事件换成了
  // `event_msg` → `item_completed`（item.type === 'UserMessage'），导致
  // displayTitle 静默变空、/resume 卡片只剩 sessionId（2026-09 事故）。
  // 这些用例锁定「两套词表都要认」的契约。
  describe('item_completed channel (codex CLI ≥0.153.4 vocabulary drift)', () => {
    /** Build a new-format rollout file; `text` is the human input. */
    function newFormatLine(sessionId: string, ...lines: string[]): string {
      return [
        `{"type":"session_meta","payload":{"session_id":"${sessionId}","cwd":"/home/user/project","originator":"lark-remote"}}`,
        ...lines,
      ].join('\n');
    }

    function itemCompletedUserMessage(text: string): string {
      return JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: { type: 'UserMessage', id: 'item-1', content: [{ type: 'text', text }] },
        },
      });
    }

    it('reads first/last human input from item_completed UserMessage', () => {
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '09', '10');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-new-format.jsonl');
      fs.writeFileSync(
        file,
        newFormatLine(
          'aaaaaaa1-1111-2222-3333-444444444444',
          itemCompletedUserMessage('first human turn'),
          itemCompletedUserMessage('last human turn'),
        ),
        'utf-8',
      );

      const entry = readCodexRollout(file);
      expect(entry).not.toBeNull();
      expect(entry!.firstUserMessage).toBe('first human turn');
      expect(entry!.lastRealUserMessage).toBe('last human turn');
    });

    it('excludes injected AGENTS.md response_items, keeps only UserMessage text', () => {
      // 新词表下注入脚手架仍是 response_item role:user，没有 UserMessage 事件，
      // 因此绝不会被当成真人输入。
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '09', '10');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-new-inject.jsonl');
      fs.writeFileSync(
        file,
        newFormatLine(
          'aaaaaaa2-1111-2222-3333-444444444444',
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '# AGENTS.md instructions\n<INSTRUCTIONS>' }],
            },
          }),
          itemCompletedUserMessage('真实输入'),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: '<environment_context>…</environment_context>' },
              ],
            },
          }),
        ),
        'utf-8',
      );

      const content = readCodexSessionContent('aaaaaaa2-1111-2222-3333-444444444444', {
        codexHome: tmpDir,
      });
      expect(content.displayTitle).toBe('真实输入');
      expect(content.displayTitle).not.toContain('AGENTS.md');
      expect(content.displayTitle).not.toContain('environment_context');
    });

    it('takes only the text part of a UserMessage, ignoring injected skill parts', () => {
      // `$skill-name` 调用会把 skill 文件作为 content 的一部分注入同一
      // UserMessage；skill 部分绝不能进标题。
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '09', '10');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-new-skill.jsonl');
      fs.writeFileSync(
        file,
        newFormatLine(
          'aaaaaaa3-1111-2222-3333-444444444444',
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'item_completed',
              item: {
                type: 'UserMessage',
                id: 'item-1',
                content: [
                  { type: 'text', text: 'placeholder skill invocation' },
                  { type: 'skill', name: 'neat-freak', path: '/home/user/.agents/skills/SKILL.md' },
                ],
              },
            },
          }),
        ),
        'utf-8',
      );

      const entry = readCodexRollout(file);
      expect(entry!.lastRealUserMessage).toBe('placeholder skill invocation');
      expect(entry!.lastRealUserMessage).not.toContain('SKILL.md');
    });

    it('keeps both channels readable when a session mixes legacy and item events', () => {
      // 过渡期（0.147–0.149）同一 CLI 世代可能先用旧词表起会话、升级后用新词表
      // 追加；两段都要按顺序识别。
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '09', '10');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-mixed.jsonl');
      fs.writeFileSync(
        file,
        newFormatLine(
          'aaaaaaa4-1111-2222-3333-444444444444',
          '{"type":"event_msg","payload":{"type":"user_message","message":"legacy turn"}}',
          itemCompletedUserMessage('item turn'),
        ),
        'utf-8',
      );

      const entry = readCodexRollout(file);
      expect(entry!.firstUserMessage).toBe('legacy turn');
      expect(entry!.lastRealUserMessage).toBe('item turn');
    });

    it('test_anchor_codex_drift_probe_warns_when_injected_user_items_have_no_human_message', () => {
      // 漂移探针：一旦出现「有 role:user 注入但识别不出真人输入」，说明 codex
      // 又换了词表，必须留 WARN（displayTitle 静默变空正是 2026-09 的事故形态）。
      mockLogger.warn.mockClear();
      const sessionsDir = path.join(tmpDir, 'sessions', '2026', '09', '10');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const file = path.join(sessionsDir, 'rollout-drift.jsonl');
      fs.writeFileSync(
        file,
        newFormatLine(
          'aaaaaaa5-1111-2222-3333-444444444444',
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '# AGENTS.md instructions' }],
            },
          }),
        ),
        'utf-8',
      );

      const entry = readCodexRollout(file);
      expect(entry!.firstUserMessage).toBe('(no user message)');
      expect(entry!.lastRealUserMessage).toBe('');
      const warned = mockLogger.warn.mock.calls.some((call) =>
        String(call[0]).includes('no human user message recognised'),
      );
      expect(warned).toBe(true);
    });
  });
});
