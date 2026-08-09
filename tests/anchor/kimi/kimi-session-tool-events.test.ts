/**
 * Anchor Test: kimi wire.jsonl 的 tool.call / tool.result 必须出现在 catch-up 展示中
 *
 * Bug: readSessionContent 原实现按"猜测的结构"解析工具事件——期望 content.part
 * 里带 part.type === 'tool_call' / 'tool_result'。2026-07-25
 * 对照真实 ~/.kimi-code wire.jsonl 验证：工具事件是独立的 loop event
 * `tool.call`（name/args/toolCallId）和 `tool.result`（toolCallId + result，
 * result 形状为 {output} / {output,note} / {isError,output}），content.part 只有
 * think/text。旧分支永不命中 → kimi 会话的 /resume 卡片静默丢弃全部工具调用与结果。
 *
 * 重要性：catch-up 卡片是用户恢复会话上下文的主要途径，工具调用历史缺失会让
 * 用户无法判断 agent 之前做过什么操作。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KimiSessionReader } from '../../../src/session/kimi/sessions.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

describe('KimiSessionReader tool.call/tool.result display events', () => {
  let kimiDir: string;
  let cwd: string;
  let sessionDir: string;
  let reader: KimiSessionReader;

  beforeEach(() => {
    kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-tool-events-kimi-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-tool-events-cwd-'));
    sessionDir = path.join(kimiDir, 'session_x');
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });

    const realCwd = fs.realpathSync(cwd);

    fs.writeFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_x', sessionDir, workDir: realCwd }) + '\n',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T01:00:00.000Z',
        title: 't',
        isCustomTitle: false,
        workDir: realCwd,
      }),
    );
    reader = new KimiSessionReader(kimiDir);
  });

  afterEach(() => {
    fs.rmSync(kimiDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test_anchor_kimi_tool_call_and_result_appear_in_display_events', () => {
    const t = 1784380436258;
    const wireLines = [
      JSON.stringify({
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'read the config file' }],
        origin: { kind: 'user' },
        time: t,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'think', think: 'hmm' } },
        time: t + 1,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          toolCallId: 'tool_1',
          name: 'Read',
          args: { path: '/tmp/config.yaml' },
        },
        time: t + 2,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'tool_1',
          result: { output: 'model: kimi-k2' },
        },
        time: t + 3,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          toolCallId: 'tool_2',
          name: 'Bash',
          args: { command: 'ls' },
        },
        time: t + 4,
      }),
      // { isError, output } 变体
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'tool_2',
          result: { isError: true, output: 'command failed' },
        },
        time: t + 5,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: '已读完' } },
        time: t + 6,
      }),
    ];
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      wireLines.join('\n') + '\n',
    );

    const content = reader.readSessionContent('session_x', cwd, { maxEvents: 50 });
    const events = content.events;

    // tool.call → tool_use，格式与旧实现一致：name(argsJSON)
    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse, 'tool.call 必须转成 tool_use 展示事件').toBeDefined();
    expect(toolUse!.content).toBe('Read({"path":"/tmp/config.yaml"})');

    // tool.result → tool_result，content 取 result.output
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].content).toBe('model: kimi-k2');
    // { isError, output } 变体同样取 output
    expect(toolResults[1].content).toBe('command failed');

    // think 仍跳过、text 仍展示
    expect(events.some((e) => e.content === 'hmm')).toBe(false);
    expect(events.some((e) => e.type === 'text' && e.content === '已读完')).toBe(true);
  });
});
