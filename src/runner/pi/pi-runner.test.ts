import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiRunner } from './index.js';
import type { SystemInitEvent, AssistantEvent, ResultEvent, UserEvent } from '../types.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-pi-runner-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createMockPi(script: string): string {
  const scriptPath = path.join(tmpDir, 'mock-pi');
  fs.writeFileSync(scriptPath, `#!/bin/bash\n${script}`, 'utf-8');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('PiRunner', () => {
  it('test_anchor_basic_flow_normalizes_to_agent_events', async () => {
    const mockPi = createMockPi(`
      echo '{"type":"session","version":3,"id":"sess-1","cwd":"/tmp","model":"glm-5.2"}'
      echo '{"type":"message_start","message":{"role":"assistant","content":[]}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"Let me think"}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":"Let me think"}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":1}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Hello!"}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"Hello!"}}'
      echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me think"},{"type":"text","text":"Hello!"}]}}'
      echo '{"type":"agent_end","messages":[]}'
    `);

    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // Should yield: SystemInit, Assistant(thinking+text), Result
    expect(events).toHaveLength(3);
    const sysEvent = events[0] as SystemInitEvent;
    expect(sysEvent.type).toBe('system');
    expect(sysEvent.subtype).toBe('init');
    expect(sysEvent.session_id).toBe('sess-1');
    expect(sysEvent.model).toBe('glm-5.2');

    const assistantEvent0 = events[1] as AssistantEvent;
    expect(assistantEvent0.type).toBe('assistant');
    const content = assistantEvent0.message.content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('thinking');
    expect((content[0] as { thinking: string }).thinking).toBe('Let me think');
    expect(content[1].type).toBe('text');
    expect((content[1] as { text: string }).text).toBe('Hello!');

    const resultEvent0 = events[2] as ResultEvent;
    expect(resultEvent0.type).toBe('result');
    expect(resultEvent0.subtype).toBe('success');
    expect(resultEvent0.session_id).toBe('sess-1');
    expect(runner.isRunning).toBe(false);
  });

  it('test_anchor_tool_call_flow_maps_toolcall_and_toolresult', async () => {
    const mockPi = createMockPi(`
      echo '{"type":"session","id":"sess-2","cwd":"/tmp","model":"glm-5.2"}'
      echo '{"type":"message_start","message":{"role":"assistant","content":[]}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0}}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"id":"call_1","name":"read","arguments":{"path":"package.json"}}}}'
      echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"package.json"}}]}}'
      echo '{"type":"message_start","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"{\\"name\\":\\"test\\"}"}],"isError":false}}'
      echo '{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"{\\"name\\":\\"test\\"}"}],"isError":false}}'
      echo '{"type":"agent_end","messages":[]}'
    `);

    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('read package.json', { cwd: '/tmp' })) {
      events.push(event);
    }

    // SystemInit, Assistant(tool_use), User(tool_result), Result
    expect(events).toHaveLength(4);

    const assistantEvent = events.find((e) => e.type === 'assistant') as AssistantEvent | undefined;
    expect(assistantEvent).toBeDefined();
    const toolUse = assistantEvent!.message.content[0] as {
      type: string;
      id: string;
      name: string;
      input: unknown;
    };
    expect(toolUse.type).toBe('tool_use');
    expect(toolUse.id).toBe('call_1');
    expect(toolUse.name).toBe('read');
    expect(toolUse.input).toEqual({ path: 'package.json' });

    const userEvent = events.find((e) => e.type === 'user') as UserEvent | undefined;
    expect(userEvent).toBeDefined();
    const toolResult = userEvent!.message.content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.tool_use_id).toBe('call_1');
    expect(toolResult.is_error).toBe(false);
  });

  it('test_anchor_spawn_failure_yields_auth_error_event', async () => {
    const runner = new PiRunner({
      workspace: 'test',
      binary: '/nonexistent/pi-binary',
      pidDir: tmpDir,
    });
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    const errEvent = events[0] as ResultEvent;
    expect(errEvent.type).toBe('result');
    expect(errEvent.subtype).toBe('error');
    expect(errEvent.errorMessage).toContain('不可用');
  });

  it('test_anchor_nonzero_exit_emits_result_error_with_stderr', async () => {
    const mockPi = createMockPi(`
      echo 'API key invalid' >&2
      exit 1
    `);

    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // P2#6: non-zero exit emits result/error (not throw) so bridge finalizes
    // correctly instead of catching a throw on an already-terminal session.
    expect(events).toHaveLength(1);
    const errEvent = events[0] as ResultEvent;
    expect(errEvent.type).toBe('result');
    expect(errEvent.subtype).toBe('error');
    expect(errEvent.errorMessage).toMatch(/code=1/);
    expect(errEvent.errorMessage).toMatch(/API key invalid/);
    expect(runner.isRunning).toBe(false);
  });

  it('test_anchor_resume_passes_session_id_argument', async () => {
    const mockPi = createMockPi(`
      echo "$@" > ${tmpDir}/args.txt
      echo '{"type":"session","id":"sess-r","cwd":"/tmp","model":"glm-5.2"}'
      echo '{"type":"agent_end","messages":[]}'
    `);

    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp', sessionId: 'sess-resume-1' })) {
      events.push(event);
    }

    const args = fs.readFileSync(path.join(tmpDir, 'args.txt'), 'utf-8');
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-resume-1');
  });

  it('test_anchor_error_isolation_malformed_event_does_not_kill_stream', async () => {
    // Inject a malformed event (valid JSON but missing required fields that will
    // cause normalize to throw). The stream should continue and still yield
    // the subsequent valid events.
    const mockPi = createMockPi(`
      echo '{"type":"session","id":"sess-e","cwd":"/tmp","model":"glm-5.2"}'
      echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"oops"}}'
      echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}'
      echo '{"type":"agent_end","messages":[]}'
    `);

    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // The message_update without a preceding message_start(assistant) won't crash —
    // accumulator guards with currentContentIndex check. SystemInit + Assistant + Result.
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].type).toBe('system');

    // Verify the warn was NOT called for parse errors (createJSONLStream handles those)
    // but the stream completed successfully
    const resultEvent = events.find((e) => e.type === 'result') as ResultEvent | undefined;
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.subtype).toBe('success');
  });

  it('test_anchor_stop_immediate_kills_running_process', async () => {
    // exec sleep replaces bash so SIGTERM closes stdout
    const mockPi = createMockPi(`
      echo '{"type":"session","id":"sess-s","cwd":"/tmp","model":"glm-5.2"}'
      exec sleep 10
    `);

    const runner = new PiRunner({
      workspace: 'test',
      binary: mockPi,
      pidDir: tmpDir,
      stopGraceMs: 500,
    });
    const runPromise = (async () => {
      for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
        // consume
      }
    })();

    await new Promise((r) => setTimeout(r, 200));
    expect(runner.isRunning).toBe(true);

    await runner.stop({ immediate: true });

    // After SIGKILL, isRunning should be false (signalCode !== null)
    expect(runner.isRunning).toBe(false);

    await runPromise;
  });

  it('test_anchor_usage_accumulates_across_messages_in_a_run', async () => {
    // A single run with an agentic tool loop produces multiple assistant
    // messages, each carrying per-message (non-cumulative) usage. The run
    // card must show the SUM (turn total), not the last message's value
    // (which shrinks across messages).
    const mockPi = createMockPi(`
      echo '{"type":"session","id":"sess-multi","cwd":"/tmp","model":"glm-5.2"}'
      echo '{"type":"message_start","message":{"role":"user","content":[]}}'
      echo '{"type":"message_end","message":{"role":"user","content":[]}}'
      echo '{"type":"message_start","message":{"role":"assistant","content":[]}}'
      echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"x"}}],"usage":{"input":4849,"output":37,"cacheRead":0,"cacheWrite":0,"totalTokens":4886}}}'
      echo '{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"ok"}],"isError":false}}'
      echo '{"type":"turn_end","message":{"usage":{"input":4849,"output":37,"cacheRead":0,"cacheWrite":0,"totalTokens":4886}}}'
      echo '{"type":"message_start","message":{"role":"assistant","content":[]}}'
      echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1813,"output":3,"cacheRead":4800,"cacheWrite":0,"totalTokens":6616}}}'
      echo '{"type":"turn_end","message":{"usage":{"input":1813,"output":3,"cacheRead":4800,"cacheWrite":0,"totalTokens":6616}}}'
      echo '{"type":"agent_end","messages":[]}'
    `);

    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('read x then say done', { cwd: '/tmp' })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as ResultEvent | undefined;
    expect(result).toBeDefined();
    expect(result!.usage).toBeDefined();
    // Summed across both assistant messages (NOT the last message's 3):
    expect(result!.usage!.output_tokens).toBe(40); // 37 + 3
    expect(result!.usage!.input_tokens).toBe(6662); // 4849 + 1813
    expect(result!.usage!.cache_read_tokens).toBe(4800); // 0 + 4800
    expect(result!.usage!.cache_creation_tokens).toBe(0);
    // total_tokens tracks the LAST message's total (context water level), not
    // the sum - so contextLength = 6616, while Total display = max(6616, sum).
    expect(result!.usage!.total_tokens).toBe(6616);
  });

  it('test_anchor_kind_declared_correctly', () => {
    const runner = new PiRunner({ workspace: 'test', pidDir: tmpDir });
    expect(runner.kind).toBe('pi');
  });

  it('test_anchor_spawn_args_include_provider_model_thinking', async () => {
    const mockPi = createMockPi(`
      echo "$@" > ${tmpDir}/args.txt
      echo '{"type":"session","id":"s","cwd":"/tmp","model":"glm-5.2"}'
      echo '{"type":"agent_end","messages":[]}'
    `);

    const runner = new PiRunner({
      workspace: 'test',
      binary: mockPi,
      pidDir: tmpDir,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      thinking: 'high',
    });
    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }

    const args = fs.readFileSync(path.join(tmpDir, 'args.txt'), 'utf-8');
    expect(args).toContain('--mode');
    expect(args).toContain('json');
    expect(args).toContain('--provider');
    expect(args).toContain('anthropic');
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-20250514');
    expect(args).toContain('--thinking');
    expect(args).toContain('high');
    expect(args).toContain('--tools');
  });

  it('test_anchor_provider_error_message_end_yields_result_error', async () => {
    // 复现生产 bug：pi 的 LLM provider 连接失败时，message_end 携带
    // stopReason="error" + errorMessage + 空 content，进程 exit 0。
    // 当前 PiEventAccumulator 忽略 stopReason/errorMessage，emit 空
    // AssistantEvent，且 hasAgentTerminalError() 恒 false，导致
    // SpawningRunner.buildResultEvent 看到 code=0 产出 success result —
    // 用户看到"已完成"卡片却没有任何内容或错误提示。
    //
    // 预期：result event subtype 必须是 'error'，且 errorMessage 透传
    // provider 报的 "Connection error."，让用户看到真实失败原因。
    //
    // 依据：pi session jsonl 铁证（2026-07-29 real session captured），
    // 4 条 {stopReason:"error",errorMessage:"Connection error.",content:[]}。
    const mockPi = createMockPi(`
      echo '{"type":"session","id":"sess-err","cwd":"/tmp","model":"glm-5.1"}'
      echo '{"type":"message_start","message":{"role":"assistant","content":[]}}'
      echo '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0},"stopReason":"error","errorMessage":"Connection error."}}'
      echo '{"type":"agent_end","messages":[]}'
    `);

    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('check recent runs for issues', { cwd: '/tmp' })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as ResultEvent | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe('error');
    expect(result!.errorMessage).toContain('Connection error.');
  });

  it('test_anchor_empty_error_message_falls_back_to_nonempty_result_error', async () => {
    // T4 边界：pi 的 error message_end 携带 stopReason="error" 但
    // errorMessage 为空字符串（provider 返回异常但无 message，或解析丢失）。
    // getTerminalError 当前用 `?? 'pi reported an error'` 只防 undefined
    // 不防空字符串——空字符串透传到 result.errorMessage，卡片显示
    // "⚠️ 运行出错\n\n"（空），用户看不到任何错误信息。
    //
    // 预期：errorMessage 为空时必须回退到非空 fallback，保证用户始终
    // 能看到"出错了"的明确提示，不出现空错误。
    //
    // 依据：run-renderer.ts:608 `state.errorMsg ?? '未知错误'` 同样只防
    // undefined 不防空字符串；getTerminalError 应在源头保证非空。
    const mockPi = createMockPi(`
      echo '{"type":"session","id":"sess-empty","cwd":"/tmp","model":"glm-5.1"}'
      echo '{"type":"message_start","message":{"role":"assistant","content":[]}}'
      echo '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0},"stopReason":"error","errorMessage":""}}'
      echo '{"type":"agent_end","messages":[]}'
    `);

    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });
    const events = [];
    for await (const event of runner.run('hi', { cwd: '/tmp' })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as ResultEvent | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe('error');
    expect(result!.errorMessage).toBeTruthy();
    expect(result!.errorMessage!.length).toBeGreaterThan(0);
  });
});
