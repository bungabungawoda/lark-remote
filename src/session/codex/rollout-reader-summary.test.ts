import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRollout, metaLine } from '../../../tests/lib/codex-rollout-fixture.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readCodexSessionSummary,
  readCodexSessionContent,
  clearSessionIndexCache,
} from './rollout-reader.js';

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-summary-test-'));
  clearSessionIndexCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearSessionIndexCache();
});

const TOKEN_EVENT = JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      last_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        total_tokens: 150,
      },
      total_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        total_tokens: 150,
      },
      model_context_window: 200000,
    },
  },
});

describe('codex-rollout-reader readCodexSessionSummary', () => {
  it('returns displayTitle + usage parity with full content, without events', () => {
    createRollout(
      tmpDir,
      'rollout-summary.jsonl',
      [
        metaLine('summary-sess', '/tmp'),
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"First input"}]}}',
        '{"type":"event_msg","payload":{"type":"user_message","message":"First input"}}',
        '{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"text","text":"reply one"}]}}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Second input"}]}}',
        '{"type":"event_msg","payload":{"type":"user_message","message":"Second input"}}',
        TOKEN_EVENT,
      ].join('\n'),
    );

    const summary = readCodexSessionSummary('summary-sess', { codexHome: tmpDir });
    const full = readCodexSessionContent('summary-sess', { codexHome: tmpDir });

    // 摘要必须与全量读取的展示字段完全一致（标题 = 最后一条真实用户输入 + 用量）。
    expect(summary.displayTitle).toBe(full.displayTitle);
    expect(summary.displayTitle).toBe('Second input');
    expect(summary.usage).toEqual(full.usage);
    // 摘要不构造 events 数组 —— 这是 readSessionSummary 相对 readSessionContent 的核心收益。
    expect('events' in summary).toBe(false);
  });

  it('respects cwd guard (empty summary on cwd mismatch)', () => {
    createRollout(
      tmpDir,
      'rollout-summary-cwd.jsonl',
      [
        metaLine('summary-cwd', '/home/user/project-a'),
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
        '{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}',
      ].join('\n'),
    );

    expect(
      readCodexSessionSummary('summary-cwd', {
        codexHome: tmpDir,
        cwd: '/home/user/project-b',
      }),
    ).toEqual({});
  });

  it('returns empty summary for unknown session id', () => {
    expect(readCodexSessionSummary('ghost-id', { codexHome: tmpDir })).toEqual({});
  });
});
