/**
 * Integration tests for OpencodeAcpRunner against a mock ACP server process.
 *
 * Same mock-server pattern as kimi/acp/runner.test.ts: a shared mock server
 * script (acp-server.mjs) reads scenario config from a JSON file passed as
 * argv[2], then responds to JSON-RPC messages over stdio, simulating the
 * opencode acp protocol (shapes from opencode dev@1c965451b5:
 * packages/opencode/src/acp/service.ts + permission.ts + event.ts).
 *
 * Test fixture data uses AABB UUIDs and /home/user/project paths
 * (CLAUDE.md red line: no real user data in test fixtures).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../../types.js';
import { OpencodeAcpRunner, type OpencodeAcpRunnerOptions } from './runner.js';
import {
  writeMockAcpServer,
  writeScenario,
  collectEvents,
  readCapture,
} from '../../../../tests/lib/mock-acp-server.js';
import { createStubSessionReader } from '../../../../tests/lib/bridge-stubs.js';

const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

/** Mode configOptions returned by session/new and session/resume. */
const MODE_CONFIG_OPTIONS = [
  { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'build' },
];

function makeRunner(wrapper: string, extra?: Partial<OpencodeAcpRunnerOptions>): OpencodeAcpRunner {
  return new OpencodeAcpRunner({
    kind: 'opencode',
    sessionReader: createStubSessionReader(),
    binary: wrapper,
    acpArgs: [],
    turnIdleTimeoutMs: 30_000,
    ...extra,
  });
}

describe('OpencodeAcpRunner', () => {
  let tmpDir: string;
  let serverScript: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-opencode-acp-'));
    serverScript = writeMockAcpServer(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs a full turn: streaming text deltas on the assistant channel + success result + usage folded', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      configOptions: MODE_CONFIG_OPTIONS,
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg-aaaa',
              content: { type: 'text', text: '你' },
            },
          },
        },
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg-aaaa',
              content: { type: 'text', text: '好' },
            },
          },
        },
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'usage_update',
              used: 12345,
              size: 200000,
              cost: { amount: 0.42, currency: 'USD' },
            },
          },
        },
      ],
    });

    const runner = makeRunner(wrapper);
    const events = await collectEvents(runner, 'hello', { cwd: workspace });

    // Synthetic init first (app-server/ACP has no wire init)
    const initIdx = events.findIndex((e) => e.type === 'system' && e.subtype === 'init');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect((events[initIdx] as AgentEvent & { session_id?: string }).session_id).toBe(SESSION_ID);

    // turn_started present
    expect(events.some((e) => e.type === 'turn_started')).toBe(true);

    // Text arrives as assistant delta events (NOT turn_diff snapshots)
    const assistantTexts = events
      .filter((e) => e.type === 'assistant')
      .flatMap(
        (e) =>
          (e as { message: { content: Array<{ type: string; text?: string }> } }).message.content,
      )
      .filter((c) => c.type === 'text');
    expect(assistantTexts.map((c) => c.text)).toEqual(['你', '好']);
    expect(events.some((e) => e.type === 'turn_diff')).toBe(false);

    // Result success with usage folded from usage_update
    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(resultIdx).toBeGreaterThan(initIdx);
    const result = events[resultIdx] as AgentEvent & {
      subtype?: string;
      usage?: { total_tokens?: number; context_limit?: number };
      total_cost_usd?: number;
    };
    expect(result.subtype).toBe('success');
    expect(result.usage?.total_tokens).toBe(12345);
    expect(result.usage?.context_limit).toBe(200000);
    expect(result.total_cost_usd).toBe(0.42);

    await runner.dispose();
  });

  it('maps cancelled stopReason to interrupted (independent terminal state)', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      stopReason: 'cancelled',
    });
    const runner = makeRunner(wrapper);
    const events = await collectEvents(runner, 'hello', { cwd: workspace });
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('interrupted');
    await runner.dispose();
  });

  it('resumes an existing session by sessionId (session/resume, no session/new)', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', { capturePath });
    const runner = makeRunner(wrapper);
    const events = await collectEvents(runner, 'hello', { cwd: workspace, sessionId: SESSION_ID });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    const methods = readCapture(capturePath).map((m) => m.method);
    expect(methods).toContain('session/resume');
    expect(methods).not.toContain('session/new');
    await runner.dispose();
  });

  it('applies the configured model via session/set_config_option when it differs from the session default', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      capturePath,
      configOptions: [
        ...MODE_CONFIG_OPTIONS,
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'opencode/big-pickle',
        },
      ],
    });
    const runner = makeRunner(wrapper, { model: 'myprovider/DeepSeek-V4-Pro' });
    const events = await collectEvents(runner, 'hello', { cwd: workspace });
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    const calls = readCapture(capturePath).filter((m) => m.method === 'session/set_config_option');
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toMatchObject({
      sessionId: SESSION_ID,
      configId: 'model',
      value: 'myprovider/DeepSeek-V4-Pro',
    });
    await runner.dispose();
  });

  it('skips the model wire call when the session already runs the configured model', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      capturePath,
      configOptions: [
        ...MODE_CONFIG_OPTIONS,
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'myprovider/DeepSeek-V4-Pro',
        },
      ],
    });
    const runner = makeRunner(wrapper, { model: 'myprovider/DeepSeek-V4-Pro' });
    const events = await collectEvents(runner, 'hello', { cwd: workspace });
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    const calls = readCapture(capturePath).filter((m) => m.method === 'session/set_config_option');
    expect(calls).toHaveLength(0);
    await runner.dispose();
  });

  it('surfaces approval requests and echoes the allow optionId on accept', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      sendApproval: true,
      holdPromptUntilResponse: true,
      capturePath,
    });

    const runner = makeRunner(wrapper);
    let approvalResponded = false;
    const events = await collectEvents(runner, 'do something', { cwd: workspace }, async (ev) => {
      if (ev.type === 'approval_requested') {
        expect(ev.kind).toBe('command');
        await runner.respondApproval(ev.requestId, { action: 'accept' });
        approvalResponded = true;
      }
    });

    expect(approvalResponded).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    // optionId echo: accept → 'once' (kind allow_once), echoed verbatim
    const approvalResponse = readCapture(capturePath).find((m) => m.id === 42 && !m.method);
    expect(approvalResponse).toBeDefined();
    expect(approvalResponse?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    });
    await runner.dispose();
  });

  it('declines approval by echoing the reject optionId', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      sendApproval: true,
      holdPromptUntilResponse: true,
      capturePath,
    });

    const runner = makeRunner(wrapper);
    const events = await collectEvents(runner, 'do something', { cwd: workspace }, async (ev) => {
      if (ev.type === 'approval_requested') {
        await runner.respondApproval(ev.requestId, { action: 'decline' });
      }
    });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    const approvalResponse = readCapture(capturePath).find((m) => m.id === 42 && !m.method);
    expect(approvalResponse?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    await runner.dispose();
  });

  it('responds accept_for_session by echoing the always optionId (§P4)', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      sendApproval: true,
      holdPromptUntilResponse: true,
      capturePath,
    });

    const runner = makeRunner(wrapper);
    let approvalResponded = false;
    const events = await collectEvents(runner, 'do something', { cwd: workspace }, async (ev) => {
      if (ev.type === 'approval_requested') {
        await runner.respondApproval(ev.requestId, { action: 'accept_for_session' });
        approvalResponded = true;
      }
    });

    expect(approvalResponded).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    // §P4: acceptForSession 决策 → always 类 optionId（'always'），逐字 echo
    const approvalResponse = readCapture(capturePath).find((m) => m.id === 42 && !m.method);
    expect(approvalResponse).toBeDefined();
    expect(approvalResponse?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'always' },
    });
    await runner.dispose();
  });

  it('updateApprovalMode hot-applies mode via session/set_mode and updates status (§P5)', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      sendApproval: true,
      holdPromptUntilResponse: true,
      capturePath,
      // 当前会话已是 build（与默认配置一致）→ setupTurn 不发 set_mode，
      // 捕获到的唯一 session/set_mode 必须来自热更
      configOptions: MODE_CONFIG_OPTIONS,
    });

    const runner = makeRunner(wrapper);
    let hotApplied = false;
    const events = await collectEvents(runner, 'do something', { cwd: workspace }, async (ev) => {
      if (ev.type === 'approval_requested') {
        await runner.updateApprovalMode({ mode: 'plan' });
        hotApplied = true;
        // 本地刷新：opencode set_mode 无通知，getStatusInfo 必须立即反映
        expect(runner.getStatusInfo().extras?.sessionMode).toBe('plan');
        await runner.respondApproval(ev.requestId, { action: 'accept' });
      }
    });

    expect(hotApplied).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    const setMode = readCapture(capturePath).find((m) => m.method === 'session/set_mode');
    expect(setMode).toBeDefined();
    expect(setMode?.params).toEqual({ sessionId: SESSION_ID, modeId: 'plan' });
    expect(runner.getStatusInfo().extras?.sessionMode).toBe('plan');

    await runner.dispose();
  });

  it('updateApprovalMode without active session updates the status cache only (§P5)', async () => {
    const runner = makeRunner('unused');

    await runner.updateApprovalMode({ mode: 'plan' });
    expect(runner.getStatusInfo().extras?.sessionMode).toBe('plan');

    await runner.dispose();
  });

  it('stop during an in-flight prompt sends session/cancel (notification) and does NOT kill the process', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const pidPath = join(tmpDir, 'server.pid');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      holdPromptUntilCancel: true,
      capturePath,
      pidPath,
    });

    const runner = makeRunner(wrapper);
    const events: AgentEvent[] = [];
    const runPromise = (async () => {
      for await (const event of runner.run('hello', { cwd: workspace })) {
        events.push(event);
      }
    })();

    // Wait for synthetic init (turn setup complete) before stopping
    for (let i = 0; i < 200 && !events.some((e) => e.type === 'system'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events.some((e) => e.type === 'system')).toBe(true);

    await runner.stop();
    await runPromise;

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('interrupted');

    // Process NOT killed: the same mock server connection still serves a
    // second run (pid unchanged, no respawn). The second run's round trip
    // also guarantees the mock has processed every prior stdin line
    // (including session/cancel) before we read the capture file.
    const pid1 = readFileSync(pidPath, 'utf8').trim();
    const events2 = await collectEvents(runner, 'again', { cwd: workspace });
    const result2 = events2.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result2?.subtype).toBe('success');
    const pid2 = readFileSync(pidPath, 'utf8').trim();
    expect(pid2).toBe(pid1);

    // session/cancel must be a notification (no id)
    const cancel = readCapture(capturePath).find((m) => m.method === 'session/cancel');
    expect(cancel).toBeDefined();
    expect(cancel?.id).toBeUndefined();
    expect((cancel?.params as { sessionId?: string })?.sessionId).toBe(SESSION_ID);

    await runner.dispose();
  }, 15000);

  it('runCompact requires a sessionId', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {});
    const runner = makeRunner(wrapper);
    const events: AgentEvent[] = [];
    for await (const event of runner.runCompact('compact', { cwd: workspace })) {
      events.push(event);
    }
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string; errorMessage?: string }) | undefined;
    expect(result?.subtype).toBe('error');
    expect(result?.errorMessage).toContain('sessionId');
    await runner.dispose();
  });

  it('runCompact sends /compact prompt after resume with compaction operationKind', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', { capturePath });
    const runner = makeRunner(wrapper);

    const events: AgentEvent[] = [];
    for await (const event of runner.runCompact('compact', {
      cwd: workspace,
      sessionId: SESSION_ID,
    })) {
      events.push(event);
    }

    const turnStarted = events.find((e) => e.type === 'turn_started') as
      (AgentEvent & { operationKind?: string }) | undefined;
    expect(turnStarted?.operationKind).toBe('compaction');
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    const captured = readCapture(capturePath);
    const methods = captured.map((m) => m.method);
    // resume before prompt (compact reuses the existing session)
    expect(methods.indexOf('session/resume')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('session/prompt')).toBeGreaterThan(methods.indexOf('session/resume'));
    const prompt = captured.find((m) => m.method === 'session/prompt');
    expect((prompt?.params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]?.text).toBe(
      '/compact',
    );
    await runner.dispose();
  });

  it('fs/write_text_file server request is fault-tolerantly rejected (method not found), turn still succeeds', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      sendFsWrite: true,
      holdPromptUntilResponse: true,
      capturePath,
    });

    const runner = makeRunner(wrapper);
    const events = await collectEvents(runner, 'edit file', { cwd: workspace });
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    // We never declared the fs capability — refuse with JSON-RPC -32601
    const fsResponse = readCapture(capturePath).find((m) => m.id === 43 && !m.method);
    expect(fsResponse).toBeDefined();
    expect((fsResponse?.error as { code?: number })?.code).toBe(-32601);
    await runner.dispose();
  });

  it('getStatusInfo extras report acp mode and the current session mode from configOptions', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', {
      configOptions: MODE_CONFIG_OPTIONS,
    });
    const runner = makeRunner(wrapper);

    // Before any session: only the protocol mode is reported
    expect(runner.getStatusInfo().extras).toEqual({ mode: 'acp' });

    await collectEvents(runner, 'hello', { cwd: workspace });

    const info = runner.getStatusInfo();
    expect(info.kind).toBe('opencode');
    expect(info.extras?.mode).toBe('acp');
    expect(info.extras?.sessionMode).toBe('build');

    await runner.dispose();
  });

  it('returns live usage authority and workspace lifetime', () => {
    const runner = makeRunner('unused');
    expect(runner.getUsageAuthority()).toBe('live');
    expect(runner.lifetime).toBe('workspace');
  });

  it('sends literal outbound wire shapes: initialize / session/new / session/prompt', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'opencode', { capturePath });
    const runner = makeRunner(wrapper);
    await collectEvents(runner, 'hello', { cwd: workspace });

    const captured = readCapture(capturePath);
    const init = captured.find((m) => m.method === 'initialize');
    expect(init?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    const newReq = captured.find((m) => m.method === 'session/new');
    expect((newReq?.params as { mcpServers?: unknown[] })?.mcpServers).toEqual([]);
    expect(typeof (newReq?.params as { cwd?: string })?.cwd).toBe('string');

    const prompt = captured.find((m) => m.method === 'session/prompt');
    expect(prompt?.params).toEqual({
      sessionId: SESSION_ID,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await runner.dispose();
  });
});
