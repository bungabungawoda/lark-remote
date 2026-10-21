/**
 * KimiSessionReader 契约：默认 limit、损坏 state.json 降级、工具事件展示、
 * usage 聚合（session 级 / 残缺行 / maxEvents 无关 / subagent）、
 * isSessionActive 的 tail-only 读取与 step.end 判定。
 *
 * 合并自 kimi-default-limit / kimi-reader-corrupt-state-json /
 * kimi-session-tool-events / kimi-session-usage-aggregation /
 * kimi-session-usage-malformed-record / kimi-session-usage-maxevents /
 * kimi-session-usage-subagent-aggregation / kimi-session-active-tail /
 * kimi-session-active-tail-ordering。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KimiSessionReader } from '../../../src/session/kimi/sessions.js';
import type { SessionContent } from '../../../src/runner/index.js';

const { jsonlSpy } = vi.hoisted(() => ({
  jsonlSpy: {
    readJsonlLines: vi.fn(),
    readLastJsonlLine: vi.fn(),
    findJsonlLine: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

// Spy the shared jsonl module. Real implementations are delegated so parity
// still works; call counts are tracked for the tail-only invariant.
vi.mock('../../../src/session/common/jsonl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/session/common/jsonl.js')>();
  jsonlSpy.readJsonlLines.mockImplementation(actual.readJsonlLines);
  jsonlSpy.readLastJsonlLine.mockImplementation(actual.readLastJsonlLine);
  jsonlSpy.findJsonlLine.mockImplementation(actual.findJsonlLine);
  return {
    ...actual,
    readJsonlLines: jsonlSpy.readJsonlLines,
    readLastJsonlLine: jsonlSpy.readLastJsonlLine,
    findJsonlLine: jsonlSpy.findJsonlLine,
  };
});

function usageRecordLine(
  usage: {
    inputOther: number;
    output: number;
    inputCacheRead: number;
    inputCacheCreation?: number;
  },
  time: number,
): string {
  return JSON.stringify({
    type: 'usage.record',
    model: 'kimi-code/k3',
    usage,
    usageScope: 'turn',
    time,
  });
}

let kimiDir: string;
let cwd: string;
let sessionDir: string;
let realCwd: string;
let reader: KimiSessionReader;

beforeEach(() => {
  kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-session-kimi-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-session-cwd-'));
  realCwd = fs.realpathSync(cwd);
  sessionDir = path.join(kimiDir, 'session_x');
  fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(
    path.join(kimiDir, 'session_index.jsonl'),
    JSON.stringify({ sessionId: 'session_x', sessionDir, workDir: realCwd }) + '\n',
  );
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T01:00:00.000Z',
      title: 't',
      isCustomTitle: false,
      workDir: realCwd,
    }),
  );
  reader = new KimiSessionReader(kimiDir);
  jsonlSpy.readJsonlLines.mockClear();
  jsonlSpy.readLastJsonlLine.mockClear();
  jsonlSpy.findJsonlLine.mockClear();
});

afterEach(() => {
  fs.rmSync(kimiDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function writeWire(lines: unknown[], dir = sessionDir): void {
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  const wirePath = path.join(dir, 'agents', 'main', 'wire.jsonl');
  fs.mkdirSync(path.dirname(wirePath), { recursive: true });
  fs.writeFileSync(wirePath, body, 'utf-8');
}

describe('KimiSessionReader', () => {
  it('test_anchor_kimi_list_sessions_default_limit_20', () => {
    const SESSION_COUNT = 15;
    const sessionIds: string[] = [];
    const indexLines: string[] = [];
    for (let i = 0; i < SESSION_COUNT; i++) {
      const sessionId = `kimi-sess-${String(i).padStart(2, '0')}`;
      const dir = path.join(kimiDir, 'sessions', sessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'state.json'),
        JSON.stringify({
          createdAt: new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),
          updatedAt: new Date(Date.UTC(2026, 6, 1, 0, i, 1)).toISOString(),
          title: `kimi session ${i}`,
          isCustomTitle: true,
          workDir: realCwd,
          lastPrompt: `prompt ${i}`,
        }),
        'utf-8',
      );
      sessionIds.push(sessionId);
      indexLines.push(JSON.stringify({ sessionId, sessionDir: dir, workDir: realCwd }));
    }
    fs.writeFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      indexLines.join('\n') + '\n',
      'utf-8',
    );

    // No opts: default limit must be 20 → all 15 fixture sessions returned.
    const result = reader.listSessions(cwd);

    expect(result.sessions).toHaveLength(SESSION_COUNT);
    expect(result.total).toBe(SESSION_COUNT);
    expect(result.sessions.map((s) => s.sessionId).sort()).toEqual([...sessionIds].sort());
  });

  it('test_anchor_kimi_reader_corrupt_state_json_does_not_throw_into_router_card_path', () => {
    // 损坏形态：kimi CLI 崩溃/被杀时 state.json 半截写入的截断 JSON。
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      '{"createdAt":"2026-07-18T00:00:00.000Z","workDir":"/',
    );
    // wire.jsonl 完好：session 聚合数据本身没有任何问题。
    writeWire([
      usageRecordLine(
        { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
        1784380436258,
      ),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'hello' } },
        time: 1784380436259,
      }),
      usageRecordLine(
        { inputOther: 2000, output: 200, inputCacheRead: 6000, inputCacheCreation: 400 },
        1784380436260,
      ),
    ]);

    let thrown: unknown;
    let content: SessionContent | undefined;
    try {
      content = reader.readSessionContent('session_x', cwd);
    } catch (err) {
      thrown = err;
    }

    expect(
      thrown,
      `readSessionContent 不应把 ${String((thrown as Error)?.name)} 抛给 router 卡片路径`,
    ).toBeUndefined();
    expect(content, 'readSessionContent 必须返回 SessionContent').toBeDefined();
    expect(Array.isArray(content!.events), 'events 必须为数组').toBe(true);

    // 降级契约：跳过损坏的 state.json 继续读 wire → 全 session 聚合幸存。
    const wireAggregateSurvived = content!.usage?.outputTokens === 300; // 100+200
    expect(
      wireAggregateSurvived,
      `损坏 state.json 下应保留 wire 聚合（outputTokens=300）；实际 usage=${JSON.stringify(content!.usage)}`,
    ).toBe(true);
  });

  it('test_anchor_kimi_tool_call_and_result_appear_in_display_events', () => {
    const t = 1784380436258;
    writeWire([
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'read the config file' }],
        origin: { kind: 'user' },
        time: t,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'think', think: 'hmm' } },
        time: t + 1,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          toolCallId: 'tool_1',
          name: 'Read',
          args: { path: '/tmp/config.yaml' },
        },
        time: t + 2,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.result', toolCallId: 'tool_1', result: { output: 'model: kimi-k2' } },
        time: t + 3,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', toolCallId: 'tool_2', name: 'Bash', args: { command: 'ls' } },
        time: t + 4,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'tool_2',
          result: { isError: true, output: 'command failed' },
        },
        time: t + 5,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: '已读完' } },
        time: t + 6,
      },
    ]);

    const content = reader.readSessionContent('session_x', cwd, { maxEvents: 50 });
    const events = content.events;

    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse, 'tool.call 必须转成 tool_use 展示事件').toBeDefined();
    expect(toolUse!.content).toBe('Read({"path":"/tmp/config.yaml"})');

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].content).toBe('model: kimi-k2');
    expect(toolResults[1].content).toBe('command failed');

    expect(events.some((e) => e.content === 'hmm')).toBe(false);
    expect(events.some((e) => e.type === 'text' && e.content === '已读完')).toBe(true);
  });

  it('test_anchor_kimi_usage_aggregates_all_usage_records_session_wide', () => {
    const records = [
      { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
      { inputOther: 2000, output: 200, inputCacheRead: 6000, inputCacheCreation: 300 },
      { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
    ];
    writeWire(records.map((usage, i) => usageRecordLine(usage, 1784380436258 + i)));

    const usage = reader.readSessionContent('session_x', cwd).usage;
    expect(usage, 'readSessionContent 应返回 usage').toBeDefined();

    expect(usage!.inputTokens).toBe(6000);
    expect(usage!.outputTokens).toBe(600);
    expect(usage!.cacheReadTokens).toBe(18000);
    expect(usage!.cacheCreationTokens).toBe(900);
    expect(usage!.totalTokens).toBe(25500);
    expect(usage!.contextLength).toBe(10400);
    expect(usage!.cumulativeInputTokens).toBe(6000);
    expect(usage!.cumulativeOutputTokens).toBe(600);
  });

  it('test_anchor_kimi_usage_malformed_record_does_not_poison_aggregates', () => {
    const records = [
      { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
      // 残缺行：缺 inputCacheCreation
      { inputOther: 2000, output: 200, inputCacheRead: 6000 },
      { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
    ];
    writeWire(records.map((usage, i) => usageRecordLine(usage, 1784380436258 + i)));

    const usage = reader.readSessionContent('session_x', cwd).usage;
    expect(usage, 'readSessionContent 应返回 usage').toBeDefined();

    const fields = {
      inputTokens: usage!.inputTokens,
      outputTokens: usage!.outputTokens,
      cacheReadTokens: usage!.cacheReadTokens,
      cacheCreationTokens: usage!.cacheCreationTokens,
      totalTokens: usage!.totalTokens,
      contextLength: usage!.contextLength,
    };
    for (const [name, value] of Object.entries(fields)) {
      expect(
        Number.isFinite(value),
        `usage.${name} 应为有限数，实际为 ${String(value)}（残缺 usage.record 污染聚合）`,
      ).toBe(true);
    }

    expect(usage!.inputTokens).toBe(6000);
    expect(usage!.outputTokens).toBe(600);
    expect(usage!.cacheReadTokens).toBe(18000);
    expect(usage!.cacheCreationTokens).toBe(600); // 200+0(缺失)+400
    expect(usage!.totalTokens).toBe(25200);
    expect(usage!.contextLength).toBe(10400);
  });

  it('test_anchor_kimi_usage_aggregation_is_independent_of_maxevents_slice', () => {
    const records = [
      { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
      { inputOther: 2000, output: 200, inputCacheRead: 6000, inputCacheCreation: 300 },
      { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
    ];
    // 每条 usage.record 之间插入 8 行 content.part 噪音，让 record 落在尾部切片之外。
    const wireLines: unknown[] = [];
    records.forEach((usage, i) => {
      wireLines.push(usageRecordLine(usage, 1784380436258 + i));
      for (let j = 0; j < 8; j++) {
        wireLines.push({
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'text', text: `noise-${i}-${j}` } },
          time: 1784380436258 + i * 100 + j,
        });
      }
    });
    writeWire(wireLines);

    const content = reader.readSessionContent('session_x', cwd, { maxEvents: 5 });
    expect(content.events.length).toBeLessThanOrEqual(5);

    const usage = content.usage;
    expect(usage, 'readSessionContent 应返回 usage').toBeDefined();
    expect(usage!.inputTokens).toBe(6000);
    expect(usage!.outputTokens).toBe(600);
    expect(usage!.cacheReadTokens).toBe(18000);
    expect(usage!.cacheCreationTokens).toBe(900);
    expect(usage!.totalTokens).toBe(25500);
    expect(usage!.contextLength).toBe(10400);
  });

  it('test_anchor_kimi_usage_aggregates_subagent_wire_files_session_wide', () => {
    const agent0 = path.join(sessionDir, 'agents', 'agent-0');
    const agent1 = path.join(sessionDir, 'agents', 'agent-1');
    fs.mkdirSync(agent0, { recursive: true });
    fs.mkdirSync(agent1, { recursive: true });

    writeWire([
      usageRecordLine(
        { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
        1784380436258,
      ),
      usageRecordLine(
        { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
        1784380436259,
      ),
    ]);
    fs.writeFileSync(
      path.join(agent0, 'wire.jsonl'),
      usageRecordLine(
        { inputOther: 10000, output: 1000, inputCacheRead: 20000, inputCacheCreation: 2000 },
        1784380436300,
      ) + '\n',
    );
    fs.writeFileSync(
      path.join(agent1, 'wire.jsonl'),
      usageRecordLine(
        { inputOther: 20000, output: 2000, inputCacheRead: 30000, inputCacheCreation: 3000 },
        1784380436400,
      ) + '\n',
    );

    const usage = reader.readSessionContent('session_x', cwd).usage;
    expect(usage, 'readSessionContent 应返回 usage').toBeDefined();

    expect(usage!.inputTokens, 'subagent 消耗同属本 session 计费').toBe(34000);
    expect(usage!.outputTokens).toBe(3400);
    expect(usage!.cacheReadTokens).toBe(62000);
    expect(usage!.cacheCreationTokens).toBe(5600);
    expect(usage!.totalTokens).toBe(105000);
    expect(usage!.contextLength, 'contextLength 仍取 main 末条 record').toBe(10400);
  });

  // ── isSessionActive tail-only ─────────────────────────────────────
  function writeBigWire(sessionIdSuffix: string): string {
    // 180 step.begin 噪音 + step.end + 尾随 usage.record（真实事件序）。
    const lines: unknown[] = [];
    for (let i = 0; i < 180; i++) {
      lines.push({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', step: i },
        time: i,
      });
    }
    lines.push({
      type: 'context.append_loop_event',
      event: { type: 'step.end', step: 180 },
      time: 180,
    });
    lines.push(
      usageRecordLine({ inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }, 181),
    );
    void sessionIdSuffix;
    writeWire(lines);
    return path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  }

  it('test_anchor_p2_5_kimi_isession_active_no_full_slurp', () => {
    const wirePath = writeBigWire('red');
    const nonEmpty = fs
      .readFileSync(wirePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;
    expect(nonEmpty).toBe(182);

    jsonlSpy.readJsonlLines.mockClear();
    void reader.isSessionActive('session_x', cwd);

    // 全量 slurp 不得发生在 wire.jsonl 上（tail-only）。
    const wireSlurpCalls = jsonlSpy.readJsonlLines.mock.calls.filter(
      (call) => call[0] === wirePath,
    );
    expect(wireSlurpCalls).toHaveLength(0);
  });

  it('test_anchor_p2_5_kimi_isession_active_parity_step_end_inactive', () => {
    writeBigWire('parity');
    expect(reader.isSessionActive('session_x', cwd)).toBe(false);
  });

  it('test_anchor_kimi_completed_turn_trailing_usage_record_not_reported_as_finalizing', () => {
    const base = 1784380436258;
    writeWire([
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'hello' }],
        origin: { kind: 'user' },
        time: base,
      },
      { type: 'context.append_loop_event', event: { type: 'step.begin', step: 1 }, time: base + 1 },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', step: 1, part: { type: 'text', text: 'answer' } },
        time: base + 2,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.end',
          step: 1,
          usage: { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
        },
        time: base + 3,
      },
      usageRecordLine(
        { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
        base + 4,
      ),
    ]);

    expect(
      reader.isSessionActive('session_x', cwd),
      'step.end 已落盘的 session 应判定为已完成（末行尾随 usage.record 不代表仍在运行）',
    ).toBe(false);

    const content = reader.readSessionContent('session_x', cwd);
    expect(content.usage?.inputTokens, '尾随 usage.record 必须仍计入聚合').toBe(3000);
    expect(content.usage?.totalTokens).toBe(3000 + 300 + 7000 + 400);
  });
});
