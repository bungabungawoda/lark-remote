/**
 * Integration tests for KimiAcpRunner against a mock ACP server process.
 *
 * Uses the same mock-server pattern as codex app-server-integration.test.ts:
 * a shared mock server script (acp-server.mjs) reads scenario config from
 * a JSON file passed as argv[2], then responds to JSON-RPC messages over
 * stdio, simulating the kimi acp protocol.
 *
 * Test fixture data uses AABB UUIDs and /home/user/project paths
 * (CLAUDE.md red line: no real user data in test fixtures).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { rmRf } from '../../../../tests/lib/tmp-cleanup.js';
import { join } from 'node:path';
import type { AgentEvent } from '../../types.js';
import { KimiAcpRunner } from './runner.js';
import {
  writeMockAcpServer,
  writeScenario,
  collectEvents,
  readCapture,
} from '../../../../tests/lib/mock-acp-server.js';
import { createStubSessionReader } from '../../../../tests/lib/bridge-stubs.js';
import { KimiSessionReader } from '../../../session/kimi/sessions.js';
import { currentPlatform, isWin32 } from '../../../platform/select.js';

const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

// =============================================================================
// Custom inline terminal mock server
// =============================================================================
// The shared writeScenario mock cannot drive terminal/* because it must read
// the client-generated terminalId from the create response before sending the
// next request. This helper mirrors the real kimi acp-terminal flow:
//   default: create -> output polls (until pollForOutput / pollForTruncated)
//            -> wait_for_exit -> release -> end_turn;
//   killAfterCreate: create -> kill -> end_turn (interrupt path, no release).
// Every client->server message is captured for wire-shape assertions.

interface TerminalMockServerOptions {
  capturePath: string;
  workspace: string;
  script: string;
  /** Script writes its own pid to this file first; kill waits for it (deterministic). */
  pidPath?: string;
  outputByteLimit?: number;
  /** Poll success condition: output response contains this substring (default 'hello'). */
  pollForOutput?: string;
  /** Poll success condition: output response has truncated === true. */
  pollForTruncated?: boolean;
  /** Send terminal/kill right after create (interrupt path, no release). */
  killAfterCreate?: boolean;
  /** Delay between output polls (real server polls every 250ms). */
  pollIntervalMs?: number;
  /**
   * Mirror the real kimi acp-server terminal correlation: emit a Bash
   * tool_call notification before create, an in_progress tool_call_update
   * with a terminal embed after create, and a completed terminal embed
   * update after wait_for_exit (2026-08-23 regression coverage).
   */
  sendTerminalEmbedUpdates?: boolean;
}

function writeTerminalMockServer(
  tmpDir: string,
  opts: TerminalMockServerOptions,
): { wrapper: string } {
  const configPath = join(tmpDir, 'terminal-server-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      sessionId: SESSION_ID,
      capturePath: opts.capturePath,
      workspace: opts.workspace,
      script: opts.script,
      pidPath: opts.pidPath ?? null,
      outputByteLimit: opts.outputByteLimit ?? 4194304,
      pollForOutput: opts.pollForOutput ?? 'hello',
      pollForTruncated: opts.pollForTruncated ?? false,
      killAfterCreate: opts.killAfterCreate ?? false,
      pollIntervalMs: opts.pollIntervalMs ?? 250,
      sendTerminalEmbedUpdates: opts.sendTerminalEmbedUpdates ?? false,
    }),
  );
  const server = join(tmpDir, 'terminal-server.mjs');
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rl = createInterface({ input: process.stdin });
const capturePath = config.capturePath;
const pollIntervalMs = config.pollIntervalMs;
let promptId = null;
let terminalId = null;
let outputPolls = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const sendPromptResult = () => {
  if (promptId === null) return;
  send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  promptId = null;
};

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (capturePath) appendFileSync(capturePath, JSON.stringify(msg) + '\\n');

  // Response to one of our terminal requests (has id, no method).
  if (msg.method === undefined && msg.id !== undefined) {
    if (msg.id === 100) {
      if (msg.error) {
        // create rejected: nothing to poll, end the turn so the test fails
        // fast on the missing marker/wire responses.
        sendPromptResult();
        return;
      }
      terminalId = msg.result && msg.result.terminalId;
      if (config.killAfterCreate) {
        const sendKill = () => send({ jsonrpc: '2.0', id: 104, method: 'terminal/kill', params: { sessionId: config.sessionId, terminalId } });
        if (!config.pidPath) {
          sendKill();
          return;
        }
        // 轮询 pid 文件存在再 kill：消除「固定延迟 vs bash 写文件」的竞态。
        let waited = 0;
        const pollPid = () => {
          if (existsSync(config.pidPath) || waited >= 2000) {
            sendKill();
            return;
          }
          waited += 50;
          setTimeout(pollPid, 50);
        };
        pollPid();
        return;
      }
      if (config.sendTerminalEmbedUpdates) {
        // acp-server onTerminalCreated: attach the terminal embed to the
        // in-flight Bash call (no status field).
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: config.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: '7:tool_terminal_test',
              content: [{ type: 'terminal', terminalId }],
            },
          },
        });
      }
      // 真实服务端每 250ms 轮询一次 output；零延迟连打会在 bash 启动前
      // 耗尽轮询次数。这里保留同样的轮询节奏。
      setTimeout(() => send({ jsonrpc: '2.0', id: 101, method: 'terminal/output', params: { sessionId: config.sessionId, terminalId } }), pollIntervalMs);
      return;
    }
    if (msg.id === 104) {
      // kill 响应 → 结束 turn（中断路径不回 release）。
      sendPromptResult();
      return;
    }
    if (msg.id === 101 || (typeof msg.id === 'number' && msg.id >= 201 && msg.id <= 205)) {
      const output = msg.result && typeof msg.result.output === 'string' ? msg.result.output : '';
      const truncated = msg.result && msg.result.truncated === true;
      const done = config.pollForTruncated ? truncated : output.includes(config.pollForOutput);
      if (done) {
        send({ jsonrpc: '2.0', id: 102, method: 'terminal/wait_for_exit', params: { sessionId: config.sessionId, terminalId } });
      } else if (outputPolls < 5) {
        outputPolls += 1;
        setTimeout(() => send({ jsonrpc: '2.0', id: 200 + outputPolls, method: 'terminal/output', params: { sessionId: config.sessionId, terminalId } }), pollIntervalMs);
      } else {
        // 轮询耗尽：仍走 wait/release 让 turn 正常结束（断言会暴露缺失）。
        send({ jsonrpc: '2.0', id: 102, method: 'terminal/wait_for_exit', params: { sessionId: config.sessionId, terminalId } });
      }
      return;
    }
    if (msg.id === 102) {
      if (config.sendTerminalEmbedUpdates) {
        // acp-server onToolResult: terminal-backed call finalises with the
        // terminal embed + status; the real output lives client-side.
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: config.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: '7:tool_terminal_test',
              status: 'completed',
              content: [{ type: 'terminal', terminalId }],
            },
          },
        });
      }
      send({ jsonrpc: '2.0', id: 103, method: 'terminal/release', params: { sessionId: config.sessionId, terminalId } });
      return;
    }
    if (msg.id === 103) {
      sendPromptResult();
      return;
    }
    return;
  }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'kimi-acp', version: '0.36.0' } } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: config.sessionId, configOptions: [] } });
    return;
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    if (config.sendTerminalEmbedUpdates) {
      // Real kimi emits the tool_call notification BEFORE delegating the
      // Bash execution to the client (terminal/create).
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: config.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: '7:tool_terminal_test',
            title: 'Bash',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: config.script },
          },
        },
      });
    }
    send({
      jsonrpc: '2.0', id: 100, method: 'terminal/create',
      params: {
        sessionId: config.sessionId,
        command: 'bash',
        args: ['-c', config.script],
        env: [{ name: 'TERM', value: 'dumb' }],
        cwd: config.workspace,
        outputByteLimit: config.outputByteLimit,
      },
    });
    return;
  }
  // Default: accept unknown client requests (e.g. session/set_mode).
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
  }
});
`,
  );
  // 与 writeScenario 同理由：win32 用 .cmd 垫片直启 node，避免 Git Bash 慢启动
  let wrapper: string;
  if (process.platform === 'win32') {
    wrapper = join(tmpDir, 'terminal-server.cmd');
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${server}" "${configPath}" %*\r\n`);
  } else {
    wrapper = join(tmpDir, 'terminal-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec "${process.execPath}" "${server}" "${configPath}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
  }
  return { wrapper };
}

describe('KimiAcpRunner', () => {
  let tmpDir: string;
  let serverScript: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-kimi-runner-'));
    serverScript = writeMockAcpServer(tmpDir);
  });

  afterEach(() => {
    // win32：子进程退出后句柄释放有毫秒级延迟，直接 rmSync 会 EBUSY
    rmRf(tmpDir);
  });

  /**
   * Build a temp kimi config dir with a session that the runner's
   * KimiSessionReader can resolve (session_index.jsonl + state.json +
   * wire.jsonl). All fixture data is synthetic (AABB UUIDs, tmp paths).
   */
  function makeKimiSessionDir(workspace: string): {
    kimiDir: string;
    wirePath: string;
  } {
    // Reader's cwd guard compares against fs.realpathSync(cwd); on macOS the
    // tmpdir lives under /var → /private/var, so canonicalize before writing.
    const canonicalWorkspace = realpathSync(workspace);
    const kimiDir = join(tmpDir, 'kimi-dir');
    const sessionDir = join(kimiDir, 'sessions', SESSION_ID);
    const agentsDir = join(sessionDir, 'agents', 'main');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(kimiDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: SESSION_ID, sessionDir, workDir: canonicalWorkspace }) + '\n',
    );
    writeFileSync(
      join(sessionDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: canonicalWorkspace, createdAt: 0, updatedAt: 0 }),
    );
    const wirePath = join(agentsDir, 'wire.jsonl');
    writeFileSync(
      wirePath,
      '{"type":"usage.record","model":"test-model","usage":{"inputOther":1000,"output":500},"time":1000}\n',
    );
    return { kimiDir, wirePath };
  }

  it('pins ConnectionBasedRunner contract: workspace lifetime and live usage authority', () => {
    // 基类 ConnectionBasedRunner 的常量真值（lifetime='workspace' /
    // getUsageAuthority()='live'）无独立测试文件，用真实 KimiAcpRunner 实例钉住。
    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: serverScript,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    expect(runner.lifetime).toBe('workspace');
    expect(runner.getUsageAuthority()).toBe('live');
  });

  it('runs a full turn with text notifications and success result', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello, world!' },
            },
          },
        },
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: { sessionUpdate: 'usage_update', used: 12345, size: 200000 },
          },
        },
      ],
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'hello', { cwd: workspace });

    // Must have synthetic init
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
    expect(init).toBeDefined();
    expect((init as AgentEvent & { session_id?: string }).session_id).toBe(SESSION_ID);

    // Must have turn_started
    const turnStarted = events.find((e) => e.type === 'turn_started');
    expect(turnStarted).toBeDefined();

    // Must have text snapshot (turn_diff; assistant/text would be a delta
    // contract violation — see translator.ts handleAgentMessageChunk).
    const textDiffs = events.filter((e) => e.type === 'turn_diff' && 'text' in e);
    expect(textDiffs.length).toBeGreaterThan(0);

    // Must have result with success
    const result = events.find((e) => e.type === 'result') as
      | (AgentEvent & {
          subtype?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            context_limit?: number;
          };
        })
      | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');
    // R1: usage_update {used, size} → total_tokens/context_limit, no invented split
    expect(result?.usage?.total_tokens).toBe(12345);
    expect(result?.usage?.context_limit).toBe(200000);
    expect(result?.usage?.input_tokens).toBeUndefined();
    expect(result?.usage?.output_tokens).toBeUndefined();

    // Init must come before result
    const initIdx = events.findIndex((e) => e.type === 'system' && e.subtype === 'init');
    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(resultIdx).toBeGreaterThan(initIdx);

    await runner.dispose();
  });

  it('maps cancelled stopReason to interrupted (independent terminal state)', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      stopReason: 'cancelled',
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'hello', { cwd: workspace });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    // §4.2: cancelled is independent terminal state, MUST NOT merge into error
    expect(result?.subtype).toBe('interrupted');

    await runner.dispose();
  });

  it('maps error stopReason to error result', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      stopReason: 'tool_error',
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'hello', { cwd: workspace });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string; errorMessage?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('error');
    expect(result?.errorMessage).toContain('tool_error');

    await runner.dispose();
  });

  it('resumes an existing session by sessionId', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi');

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'hello', { cwd: workspace, sessionId: SESSION_ID });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string; session_id?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');
    expect(result?.session_id).toBe(SESSION_ID);

    await runner.dispose();
  });

  it('emits thinking events from agent_thought_chunk', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'Let me think...' },
            },
          },
        },
      ],
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'think', { cwd: workspace });

    const thinking = events.filter((e) => e.type === 'turn_diff' && 'reasoning' in e);
    expect(thinking.length).toBeGreaterThan(0);

    await runner.dispose();
  });

  it('emits tool_use and tool_result events', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-001',
              // Bash 的 tool 通知已被 runner 过滤（terminal 下放自产事件），
              // 这里用 Read 验证 translator 的通用 tool_call → tool_use 映射。
              title: 'Read',
              kind: 'read',
              status: 'in_progress',
              rawInput: { file_path: 'a.ts' },
            },
          },
        },
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-001',
              status: 'completed',
              rawOutput: 'a.ts',
            },
          },
        },
      ],
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'list files', { cwd: workspace });

    // Should have tool_use in assistant events
    const toolUse = events.find(
      (e) =>
        e.type === 'assistant' &&
        'message' in e &&
        Array.isArray(
          (e as { message?: { content?: Array<{ type?: string }> } }).message?.content,
        ) &&
        (e as { message: { content: Array<{ type: string }> } }).message.content.some(
          (c) => c.type === 'tool_use',
        ),
    );
    expect(toolUse).toBeDefined();

    // Should have tool_result in user events
    const toolResult = events.find(
      (e) =>
        e.type === 'user' &&
        'message' in e &&
        Array.isArray(
          (e as { message?: { content?: Array<{ type?: string }> } }).message?.content,
        ) &&
        (e as { message: { content: Array<{ type: string }> } }).message.content.some(
          (c) => c.type === 'tool_result',
        ),
    );
    expect(toolResult).toBeDefined();

    await runner.dispose();
  });

  it('surfaces approval requests and responds via respondApproval', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      sendApproval: true,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      permissionMode: 'manual',
      turnIdleTimeoutMs: 30_000,
    });

    const events: AgentEvent[] = [];
    let approvalResponded = false;
    for await (const event of runner.run('do something', { cwd: workspace })) {
      events.push(event);
      if (event.type === 'approval_requested') {
        expect(event.kind).toBe('command');
        await runner.respondApproval(event.requestId, { action: 'accept' });
        approvalResponded = true;
      }
    }

    expect(approvalResponded).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    await runner.dispose();
  });

  it('surfaces elicitation form questions and answers via respondApproval', async () => {
    const capturePath = join(tmpDir, 'received.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      sendElicitation: true,
      holdPromptUntilResponse: true,
      capturePath,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events: AgentEvent[] = [];
    let questionSeen = false;
    for await (const event of runner.run('ask me', { cwd: workspace })) {
      events.push(event);
      if (event.type === 'approval_requested' && event.kind === 'question') {
        questionSeen = true;
        expect(event.view.questions).toHaveLength(2);
        expect(event.view.questions?.[1]?.multiSelect).toBe(true);
        expect(event.view.intro).toBe('Which database?\nPick frameworks');
        // 文本 key 答案（按题面标题）→ 序号回编 content{q0,q1}
        await runner.respondApproval(event.requestId, {
          action: 'answer',
          answers: {
            Setup: 'PostgreSQL',
            Frameworks: ['React', 'Vue'],
          },
        });
      }
    }

    expect(questionSeen).toBe(true);
    expect(events.some((e) => e.type === 'result')).toBe(true);

    const received = readFileSync(capturePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id?: number; result?: unknown });
    const elicitationResponse = received.find((m) => m.id === 44 && m.result);
    expect(elicitationResponse?.result).toEqual({
      action: 'accept',
      content: { q0: 'PostgreSQL', q1: ['React', 'Vue'] },
    });

    await runner.dispose();
  });

  it('declines elicitation form with action decline', async () => {
    const capturePath = join(tmpDir, 'received.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      sendElicitation: true,
      holdPromptUntilResponse: true,
      capturePath,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    for await (const event of runner.run('ask me', { cwd: workspace })) {
      if (event.type === 'approval_requested' && event.kind === 'question') {
        await runner.respondApproval(event.requestId, { action: 'decline' });
      }
    }

    const received = readFileSync(capturePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id?: number; result?: unknown });
    const elicitationResponse = received.find((m) => m.id === 44 && m.result);
    expect(elicitationResponse?.result).toEqual({ action: 'decline' });

    await runner.dispose();
  });

  it('declines approval with reject_once option', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      sendApproval: true,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      permissionMode: 'manual',
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(
      runner,
      'do something',
      { cwd: workspace },
      async (event) => {
        if (event.type === 'approval_requested') {
          await runner.respondApproval(event.requestId, { action: 'decline' });
        }
      },
    );

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    await runner.dispose();
  });

  it('responds accept_for_session by echoing the approve_always optionId (§P4)', async () => {
    const capturePath = join(tmpDir, 'approval-capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      sendApproval: true,
      capturePath,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      permissionMode: 'manual',
      turnIdleTimeoutMs: 30_000,
    });

    const events: AgentEvent[] = [];
    let approvalResponded = false;
    for await (const event of runner.run('do something', { cwd: workspace })) {
      events.push(event);
      if (event.type === 'approval_requested') {
        await runner.respondApproval(event.requestId, { action: 'accept_for_session' });
        approvalResponded = true;
      }
    }

    expect(approvalResponded).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    // §P4: acceptForSession 决策 → always 类 optionId（approve_always），逐字 echo
    const approvalResponse = readFileSync(capturePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id?: unknown; method?: unknown; result?: unknown })
      .find((m) => m.id === 42 && m.method === undefined);
    expect(approvalResponse).toBeDefined();
    expect(approvalResponse?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'approve_always' },
    });

    await runner.dispose();
  });

  it('updateApprovalMode hot-applies permissionMode via session/set_mode and updates status (§P5)', async () => {
    const capturePath = join(tmpDir, 'mode-capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      sendApproval: true,
      capturePath,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      permissionMode: 'manual',
      turnIdleTimeoutMs: 30_000,
    });

    let hotApplied = false;
    for await (const event of runner.run('do something', { cwd: workspace })) {
      if (event.type === 'approval_requested') {
        await runner.updateApprovalMode({ permissionMode: 'yolo' });
        hotApplied = true;
        // 本地缓存立即生效：/s（getStatusInfo extras）必须马上看到新模式
        expect(runner.getStatusInfo().extras?.permissionMode).toBe('yolo');
        await runner.respondApproval(event.requestId, { action: 'accept' });
      }
    }

    expect(hotApplied).toBe(true);
    // setupTurn 先发 manual（无条件），热更后再发 yolo —— 最后一条必须是 yolo
    const setModes = readFileSync(capturePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: { modeId?: string } })
      .filter((m) => m.method === 'session/set_mode');
    expect(setModes.at(-1)?.params?.modeId).toBe('yolo');
    expect(runner.getStatusInfo().extras?.permissionMode).toBe('yolo');

    await runner.dispose();
  });

  it('updateApprovalMode without active session updates the status cache only (§P5)', async () => {
    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      permissionMode: 'manual',
    });

    await runner.updateApprovalMode({ permissionMode: 'auto' });
    expect(runner.getStatusInfo().extras?.permissionMode).toBe('auto');

    await runner.dispose();
  });

  it('pushes the configured model via session/set_config_option (CC: migration regression)', async () => {
    // 旧 KimiRunner 通过 -m 传模型；迁移到纯 ACP 后模型只用于 /status 展示。
    // 必须像 opencode 一样在 setupTurn 里 session/new|resume 后 session/set_config_option 下发，
    // 否则实际跑的是 kimi 默认模型（CC-07）。
    const capturePath = join(tmpDir, 'model-capture.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      capturePath,
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-code/k3',
        },
      ],
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      permissionMode: 'manual',
      model: 'myprovider/DeepSeek-V4-Pro',
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'hello', { cwd: workspace });
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');

    const setConfigs = readFileSync(capturePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .filter((m) => m.method === 'session/set_config_option');
    expect(setConfigs.length).toBeGreaterThan(0);
    expect(setConfigs[0].params).toMatchObject({
      sessionId: SESSION_ID,
      configId: 'model',
      value: 'myprovider/DeepSeek-V4-Pro',
    });

    await runner.dispose();
  });

  it('cancels approval with cancelled outcome', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      sendApproval: true,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      permissionMode: 'manual',
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(
      runner,
      'do something',
      { cwd: workspace },
      async (event) => {
        if (event.type === 'approval_requested') {
          await runner.respondApproval(event.requestId, { action: 'cancel' });
        }
      },
    );

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();

    await runner.dispose();
  });

  it('stop during an in-flight turn emits interrupted subtype', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      delayMs: 3000, // delay prompt response for 3s
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'working...' },
            },
          },
        },
      ],
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

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
      (AgentEvent & { subtype?: string; errorMessage?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('interrupted');

    await runner.dispose();
  }, 15000);

  it('reports status info with mode and permission mode', () => {
    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: 'kimi',
      acpArgs: [],
      permissionMode: 'manual',
      model: 'kimi-code/k3',
    });

    const info = runner.getStatusInfo();
    expect(info.kind).toBe('kimi');
    expect(info.model).toBe('kimi-code/k3');
    expect(info.extras?.mode).toBe('acp');
    expect(info.extras?.permissionMode).toBe('manual');
  });

  it('runCompact requires a sessionId', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi');

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.runCompact('', { cwd: workspace })) {
      events.push(event);
    }

    // Without sessionId → error result
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string; errorMessage?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('error');
    expect(result?.errorMessage).toContain('sessionId');

    await runner.dispose();
  });

  it('runCompact sends /compact prompt with compaction operationKind', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi');

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.runCompact('', {
      cwd: workspace,
      sessionId: SESSION_ID,
    })) {
      events.push(event);
    }

    // Must have turn_started with operationKind=compaction
    const turnStarted = events.find((e) => e.type === 'turn_started') as
      (AgentEvent & { operationKind?: string }) | undefined;
    expect(turnStarted).toBeDefined();
    expect(turnStarted?.operationKind).toBe('compaction');

    // Must have a result
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();

    await runner.dispose();
  });

  it('runCompact waits for the wire.jsonl compaction record before producing the result (R2)', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      // Compaction text chunk flows during the background compaction…
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Context compaction started…' },
            },
          },
        },
      ],
      // …but the context.apply_compaction record lands AFTER the prompt
      // settles (real kimi: ~8s). The runner must poll for it.
      delayMs: 20,
      compactionRecordDelayMs: 600,
    });
    const { kimiDir, wirePath } = makeKimiSessionDir(workspace);
    const doneMarker = join(tmpDir, 'compaction-done.marker');
    // Re-write the scenario with the marker path wired into the mock config.
    const configPath = join(tmpDir, 'server-config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.wirePath = wirePath;
    config.doneMarker = doneMarker;
    writeFileSync(configPath, JSON.stringify(config));

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: new KimiSessionReader(kimiDir),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
      compactIdleTimeoutMs: 5000,
    });

    const events: AgentEvent[] = [];
    const runStartMs = Date.now();
    let resultAtMs: number | undefined;
    for await (const event of runner.runCompact('', {
      cwd: workspace,
      sessionId: SESSION_ID,
    })) {
      events.push(event);
      if (event.type === 'result') resultAtMs = Date.now();
    }

    // Compaction text chunk must flow as turn_diff text snapshot (R1 restore;
    // snapshot semantics, not assistant/text delta semantics).
    const hasCompactionText = events.some(
      (e) =>
        e.type === 'turn_diff' &&
        'text' in e &&
        JSON.stringify(e).includes('Context compaction started'),
    );
    expect(hasCompactionText).toBe(true);

    // Result must NOT be produced before the record hit disk (R2: otherwise
    // the dispose/exit race kills the background compaction).
    const markerStat = statSync(doneMarker);
    expect(resultAtMs).toBeDefined();
    expect(resultAtMs!).toBeGreaterThanOrEqual(markerStat.mtimeMs);
    // …and it must arrive well before the poll timeout (5s): a timeout
    // fallback would silently pass the marker check while the record was
    // written later by the mock. Real polling observes the record at ~0.7-1.7s.
    expect(resultAtMs! - runStartMs).toBeLessThan(4000);

    // Post-run jsonl readback sees the compaction stats.
    const content = new KimiSessionReader(kimiDir).readSessionContent(SESSION_ID, workspace, {
      maxEvents: 0,
    });
    expect(content.usage?.compactCount).toBe(1);
    expect(content.usage?.compactPreContextLength).toBe(30000);

    await runner.dispose();
  }, 15000);

  it('sends literal outbound wire shapes: initialize / session/new / session/set_mode (R4)', async () => {
    const capturePath = join(tmpDir, 'received.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      capturePath,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    await collectEvents(runner, 'hello', { cwd: workspace });
    await runner.dispose();

    const received = readFileSync(capturePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params?: unknown });

    const initialize = received.find((m) => m.method === 'initialize');
    expect(initialize?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        // fs 保持关闭：kimi 服务端在 fs 能力为 false 时走本地磁盘兜底
        // （acpFsService.ts AcpHostFileSystem.inner），读写正常；声明 true
        // 则改发 fs/* reverse RPC，lark-remote 未实现，文件读写会失败。
        fs: { readTextFile: false, writeTextFile: false },
        // terminal 常开：yolo/auto 自主跑命令；manual 走 session/request_permission 审批。
        terminal: true,
        // AskUserQuestion 走 elicitation form（原生多题多选）。elicitation.form
        // 必须是对象（ACP SDK zod: z.record），布尔 true 会被 kimi 服务端丢弃
        // → 多选回退成 request_permission 单选桥（勾一个选项即提交）。
        elicitation: { form: {} },
      },
    });

    const sessionNew = received.find((m) => m.method === 'session/new');
    expect(sessionNew?.params).toEqual({ cwd: workspace, mcpServers: [] });

    const setMode = received.find((m) => m.method === 'session/set_mode');
    expect(setMode?.params).toEqual({
      sessionId: SESSION_ID,
      modeId: 'default',
    });
    // Explicit regression: old 'mode' field name must not leak onto the wire.
    expect(JSON.stringify(setMode?.params)).not.toContain('"mode"');
  });

  it('sends session/set_mode unconditionally — yolo included (R6: fresh sessions start in default=manual, skipping yolo stalls tool calls on unanswered approvals)', async () => {
    const capturePath = join(tmpDir, 'received.jsonl');
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      capturePath,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      permissionMode: 'yolo',
      turnIdleTimeoutMs: 30_000,
    });

    for await (const _event of runner.run('hello', { cwd: workspace })) {
      // drain
    }
    await runner.dispose();

    const received = readFileSync(capturePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params?: unknown });

    const setMode = received.find((m) => m.method === 'session/set_mode');
    expect(setMode?.params).toEqual({
      sessionId: SESSION_ID,
      modeId: 'yolo',
    });
  });

  it('prevents concurrent runs', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      delayMs: 1000,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    // Start first run
    const firstRun = (async () => {
      const events: AgentEvent[] = [];
      for await (const event of runner.run('first', { cwd: workspace })) {
        events.push(event);
      }
      return events;
    })();

    // Wait for first run to be active
    for (let i = 0; i < 100 && !runner.isRunning; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Second run should throw
    await expect(
      (async () => {
        for await (const _ of runner.run('second', { cwd: workspace })) {
          // no-op
        }
      })(),
    ).rejects.toThrow('already running');

    await firstRun;
    await runner.dispose();
  }, 10000);

  it('auto-responds cancelled to question elicitation (no toolCall)', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      sendQuestion: true,
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'I will skip the question.' },
            },
          },
        },
      ],
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'hello', { cwd: workspace });

    // No approval_requested event should be emitted for question elicitation
    const approvals = events.filter((e) => e.type === 'approval_requested');
    expect(approvals).toHaveLength(0);

    // Turn should still complete successfully
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    await runner.dispose();
  });

  it('times out a turn when no notifications arrive within idle window', async () => {
    // Server sends prompt response with a long delay (far beyond the 200ms
    // idle timeout), and no notifications. The runner should detect the idle
    // timeout, send session/cancel, and emit an error result.
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      delayMs: 5000, // prompt response arrives after 5s — way beyond idle
      notifications: [], // no notifications to keep lastEventAt stale
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 200, // very short idle timeout
    });

    const events = await collectEvents(runner, 'hello', { cwd: workspace });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string; errorMessage?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('error');
    expect(result?.errorMessage).toContain('timed out');

    await runner.dispose();
  }, 10000);

  it('recovers from connection loss during setup (respawn and retry)', async () => {
    // First scenario: crash after init
    const crashConfigPath = join(tmpDir, 'crash-config.json');
    writeFileSync(crashConfigPath, JSON.stringify({ sessionId: SESSION_ID, crashAfterInit: true }));
    const crashWorkspace = join(tmpDir, 'crash-workspace');
    mkdirSync(crashWorkspace, { recursive: true });

    // Second scenario: normal operation
    const normalConfigPath = join(tmpDir, 'normal-config.json');
    writeFileSync(normalConfigPath, JSON.stringify({ sessionId: SESSION_ID }));
    const normalWorkspace = join(tmpDir, 'normal-workspace');
    mkdirSync(normalWorkspace, { recursive: true });

    // Spawn counter: first invocation crashes, second succeeds.
    // 平台中立 launcher（Node）——不再写 POSIX `#!/bin/sh` wrapper：Windows 既不能
    // 直接执行无扩展名脚本、shell 算术也不可用。
    const spawnCountFile = join(tmpDir, 'spawn-count');
    const launcher = join(tmpDir, 'retry-server.mjs');
    writeFileSync(
      launcher,
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n` +
        `import { spawnSync } from 'node:child_process';\n` +
        `const countFile = ${JSON.stringify(spawnCountFile)};\n` +
        `const n = (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8').trim()) : 0) + 1;\n` +
        `writeFileSync(countFile, String(n));\n` +
        `const configPath = n === 1 ? ${JSON.stringify(crashConfigPath)} : ${JSON.stringify(normalConfigPath)};\n` +
        `const { status } = spawnSync(process.execPath, [${JSON.stringify(serverScript)}, configPath], { stdio: 'inherit' });\n` +
        `process.exit(status ?? 0);\n`,
    );

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: process.execPath,
      acpArgs: [launcher],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'hello', { cwd: crashWorkspace });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    // Should have spawned twice (crash + retry)
    expect(Number(readFileSync(spawnCountFile, 'utf8').trim())).toBe(2);

    await runner.dispose();
  });

  it('stop during setup (session/new pending) emits interrupted, does not run the turn (CC-01)', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      delayNewMs: 500, // session/new 阻塞 500ms，制造「连接已建、session 未建立」的启动窗口
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'SHOULD-NOT-RUN' },
            },
          },
        },
      ],
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      permissionMode: 'manual',
      turnIdleTimeoutMs: 30_000,
    });

    const events: AgentEvent[] = [];
    const runPromise = (async () => {
      for await (const event of runner.run('hello', { cwd: workspace })) {
        events.push(event);
      }
    })();

    // 在 setup（session/new）尚未完成时按 /stop：旧实现 currentSessionId() 为 null →
    // stop() 提前 return 不置 stopRequested → turn 照常执行。
    await new Promise((resolve) => setTimeout(resolve, 80));
    await runner.stop();
    await runPromise;

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('interrupted');
    // 关键：不得产出真实 agent 文本（turn 被取消而非继续执行）
    const assistantTexts = events.filter(
      (e) => e.type === 'assistant' || (e.type === 'turn_diff' && 'text' in e),
    );
    expect(assistantTexts).toHaveLength(0);

    await runner.dispose();
  });

  // 依赖真实 `bash -c`（POSIX）：kimi terminal/create 协议固定 bash，Windows 需
  // Git Bash 在 PATH。门控到 win32 具备该前置为止。
  it.skipIf(isWin32(currentPlatform))('executes kimi terminal/create bash commands locally and serves output/wait_for_exit/release (terminal protocol)', async () => {
    const capturePath = join(tmpDir, 'terminal-capture.jsonl');
    const markerPath = join(tmpDir, 'terminal-marker.txt');
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    // stdout 也要有 hello（output 轮询断言），marker 文件同时落盘（本地执行断言）。
    const { wrapper } = writeTerminalMockServer(tmpDir, {
      capturePath,
      workspace,
      script: `echo hello | tee ${JSON.stringify(markerPath)}`,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'run bash', { cwd: workspace });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    // Proves the client really spawned `bash -c <script>` locally.
    expect(readFileSync(markerPath, 'utf8')).toContain('hello');

    // Wire-shape assertions against the captured client->server messages.
    const captured = readCapture(capturePath);
    const createResp = captured.find((m) => m.id === 100);
    expect(createResp).toBeDefined();
    expect(createResp?.error).toBeUndefined();
    const createResult = createResp?.result as { terminalId?: string } | undefined;
    expect(createResult?.terminalId).toBeTypeOf('string');
    expect((createResult?.terminalId ?? '').length).toBeGreaterThan(0);

    const outputResps = captured.filter(
      (m) => m.id === 101 || (typeof m.id === 'number' && m.id >= 201 && m.id <= 205),
    );
    expect(outputResps.length).toBeGreaterThan(0);
    const outputWithHello = outputResps.find((m) => {
      if (m.error !== undefined) return false;
      const output = (m.result as { output?: string } | undefined)?.output ?? '';
      return output.includes('hello');
    });
    expect(outputWithHello).toBeDefined();

    const waitResp = captured.find((m) => m.id === 102);
    expect(waitResp).toBeDefined();
    expect(waitResp?.error).toBeUndefined();
    const waitResult = waitResp?.result as
      { exitCode?: number | null; signal?: string | null } | undefined;
    expect(waitResult?.exitCode).toBe(0);
    expect(waitResult?.signal).toBeNull();

    const releaseResp = captured.find((m) => m.id === 103);
    expect(releaseResp).toBeDefined();
    expect(releaseResp?.error).toBeUndefined();

    await runner.dispose();
  });

  it.skipIf(isWin32(currentPlatform))('emits runner-owned Bash tool_use/tool_result with command and local output (terminal visibility)', async () => {
    const capturePath = join(tmpDir, 'terminal-enrich-capture.jsonl');
    const markerPath = join(tmpDir, 'terminal-enrich-marker.txt');
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const { wrapper } = writeTerminalMockServer(tmpDir, {
      capturePath,
      workspace,
      script: `echo hello | tee ${JSON.stringify(markerPath)}`,
      // 模拟真实 kimi acp-server：tool_call 通知 + terminal embed 更新。
      sendTerminalEmbedUpdates: true,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'run bash', { cwd: workspace });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    // runner 自产 assistant/tool_use（Bash 面板，带真实命令），且仅一份
    // （kimi 的 Bash 通知必须被过滤，否则双份面板）。
    const bashToolUses = events.filter(
      (e) =>
        e.type === 'assistant' &&
        (
          e as { message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> } }
        ).message?.content?.filter((c) => c.type === 'tool_use' && c.name === 'Bash').length === 1,
    );
    expect(bashToolUses.length).toBe(1);
    const bashToolUse = (
      bashToolUses[0] as {
        message?: {
          content?: Array<{ type?: string; name?: string; input?: { command?: string } }>;
        };
      }
    ).message?.content?.find((c) => c.type === 'tool_use');
    expect(bashToolUse?.input?.command).toContain('echo hello');

    // runner 自产 tool_result 必须带上本地缓冲的真实输出。
    const toolResults = events.filter(
      (
        e,
      ): e is AgentEvent & { message?: { content?: Array<{ type?: string; content?: string }> } } =>
        e.type === 'user' &&
        (e as { message?: { content?: unknown[] } }).message?.content?.some(
          (c) => (c as { type?: string }).type === 'tool_result',
        ),
    );
    expect(toolResults.length).toBeGreaterThan(0);
    const outputs = toolResults.flatMap((e) =>
      (e.message?.content ?? [])
        .filter((c) => c.type === 'tool_result')
        .map((c) => c.content ?? ''),
    );
    expect(outputs.some((o) => o.includes('hello'))).toBe(true);

    await runner.dispose();
  });

  it.skipIf(isWin32(currentPlatform))('terminal/kill really terminates a long-running local bash process (kill regression)', async () => {
    const capturePath = join(tmpDir, 'terminal-kill-capture.jsonl');
    const pidPath = join(tmpDir, 'terminal-pid.txt');
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const { wrapper } = writeTerminalMockServer(tmpDir, {
      capturePath,
      workspace,
      pidPath,
      killAfterCreate: true,
      // $$ 是 bash 自身 PID；sleep 30 保证 kill 到达前进程一定还在跑。
      script: `echo $$ > ${JSON.stringify(pidPath)}; sleep 30`,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'run bash', { cwd: workspace });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    const captured = readCapture(capturePath);
    const killResp = captured.find((m) => m.id === 104);
    expect(killResp).toBeDefined();
    expect(killResp?.error).toBeUndefined();

    // 核心断言：kill 响应后 bash 必须真的死掉（负 PID 杀进程组），不能只回 {}。
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    expect(Number.isInteger(pid)).toBe(true);
    let dead = false;
    try {
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          dead = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(dead).toBe(true);
    } finally {
      // 测试失败时兜底清理，避免孤儿 sleep 进程污染后续用例。
      if (!dead) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }

    await runner.dispose();
  });

  it.skipIf(isWin32(currentPlatform))('buffers terminal output byte-accurately: intact UTF-8 and outputByteLimit enforced', async () => {
    const capturePath = join(tmpDir, 'terminal-buffer-capture.jsonl');
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const { wrapper } = writeTerminalMockServer(tmpDir, {
      capturePath,
      workspace,
      pollForTruncated: true,
      outputByteLimit: 5,
      // 第一个 write 只有 1 字节（多字节字符被拆到两个 chunk），随后补全；
      // 总输出 '你你好' 9 字节 > 5 字节上限，必须截断且不产生 U+FFFD。
      script: `printf '\\xe4'; sleep 0.05; printf '\\xbd\\xa0\\xe4\\xbd\\xa0\\xe5\\xa5\\xbd'`,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'run bash', { cwd: workspace });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    const captured = readCapture(capturePath);
    const outputResps = captured.filter(
      (m) => m.id === 101 || (typeof m.id === 'number' && m.id >= 201 && m.id <= 205),
    );
    expect(outputResps.length).toBeGreaterThan(0);

    // 字节准确截断：truncated 响应的输出不得超过 outputByteLimit（5 字节）。
    const truncatedResp = outputResps.find((m) => {
      if (m.error !== undefined) return false;
      return (m.result as { truncated?: boolean } | undefined)?.truncated === true;
    });
    expect(truncatedResp).toBeDefined();
    const truncatedOutput = (truncatedResp?.result as { output?: string }).output ?? '';
    expect(Buffer.byteLength(truncatedOutput)).toBeLessThanOrEqual(5);

    // 跨 chunk 拆分多字节字符不得产生 U+FFFD 替换符。
    for (const m of outputResps) {
      const output = (m.result as { output?: string } | undefined)?.output ?? '';
      expect(output.includes('\uFFFD')).toBe(false);
    }

    await runner.dispose();
  });

  it.skipIf(isWin32(currentPlatform))('reports truncated when output exactly reaches outputByteLimit (spec: buffer >= limit)', async () => {
    const capturePath = join(tmpDir, 'terminal-exact-cap-capture.jsonl');
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const { wrapper } = writeTerminalMockServer(tmpDir, {
      capturePath,
      workspace,
      pollForTruncated: true,
      outputByteLimit: 5,
      // 'hello' 恰好 5 字节 = outputByteLimit：契约要求 truncated=true（缓冲>=上限），
      // 且恰好填满时不能丢数据（输出仍应完整）。
      script: `printf 'hello'`,
    });

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events = await collectEvents(runner, 'run bash', { cwd: workspace });

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    const captured = readCapture(capturePath);
    const outputResps = captured.filter(
      (m) => m.id === 101 || (typeof m.id === 'number' && m.id >= 201 && m.id <= 205),
    );
    expect(outputResps.length).toBeGreaterThan(0);
    const truncatedResp = outputResps.find((m) => {
      if (m.error !== undefined) return false;
      return (m.result as { truncated?: boolean } | undefined)?.truncated === true;
    });
    expect(truncatedResp).toBeDefined();
    const truncatedOutput = (truncatedResp?.result as { output?: string }).output ?? '';
    expect(truncatedOutput).toBe('hello');

    await runner.dispose();
  });

  // =========================================================================
  // runCompact 等待机制（kimi-compact-wait-redesign §5.2）
  // 压缩是完整 LLM 请求（时长无上限）：删除「固定 30s 超时 = 成功」的旧语义，
  // 改为等 wire 终态记录（complete/apply/cancel），沉默超过 compactIdleTimeoutMs
  // 才放弃。测试用 bounded race 驱动真实 mock server，红绿差异确定、不依赖 fake timer。
  // =========================================================================
  describe('KimiAcpRunner runCompact 等待机制（§5.2）', () => {
    function sleepReal(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitForResult(
      events: AgentEvent[],
      timeoutMs: number,
    ): Promise<AgentEvent | undefined> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = events.find((e) => e.type === 'result');
        if (result) return result;
        await sleepReal(50);
      }
      return undefined;
    }

    function startRunCompactCollect(
      runner: KimiAcpRunner,
      workspace: string,
    ): { events: AgentEvent[]; done: Promise<void> } {
      const events: AgentEvent[] = [];
      const done = (async () => {
        for await (const event of runner.runCompact('', {
          cwd: workspace,
          sessionId: SESSION_ID,
        })) {
          events.push(event);
        }
      })();
      return { events, done };
    }

    it('runCompact 落 cancel 记录 → error result「压缩未完成」', async () => {
      const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
        delayMs: 0,
      });
      const { kimiDir, wirePath } = makeKimiSessionDir(workspace);
      const runner = new KimiAcpRunner({
        kind: 'kimi',
        sessionReader: new KimiSessionReader(kimiDir),
        binary: wrapper,
        acpArgs: [],
        turnIdleTimeoutMs: 30_000,
        compactIdleTimeoutMs: 5000,
      });
      const { events, done } = startRunCompactCollect(runner, workspace);

      // prompt settle 后落 cancel：引擎失败/取消共用 full_compaction.cancel。
      // Windows 握手可达数秒，固定一次 append 会落在 baseline 建立之前被
      // 「已有记录」吸收（等待器只看新增）；周期性 append 保证 baseline 之后
      // 必然出现新增 cancel 记录，posix 上第一条即触发，语义不变。
      const cancelTimer = setInterval(() => {
        appendFileSync(
          wirePath,
          JSON.stringify({ type: 'full_compaction.cancel', time: Date.now() }) + '\n',
        );
      }, 1000);
      const result = await waitForResult(events, 15000);
      clearInterval(cancelTimer);
      if (!result) await runner.stop();
      await done;

      expect(result?.subtype).toBe('error');
      expect(result?.errorMessage).toContain('压缩未完成');

      await runner.dispose();
    }, 20000);

    it('runCompact 等待超过旧 30s 上限的 complete 记录 → 不误报完成（等记录落盘）', async () => {
      const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
        delayMs: 0,
      });
      const { kimiDir, wirePath } = makeKimiSessionDir(workspace);
      const runner = new KimiAcpRunner({
        kind: 'kimi',
        sessionReader: new KimiSessionReader(kimiDir),
        binary: wrapper,
        acpArgs: [],
        turnIdleTimeoutMs: 30_000,
        // 沉默窗口 6s 远大于 complete 记录落盘时刻（2.5s）：新实现必须等到
        // 记录（结果晚于落盘），绝不在记录前报完成。
        compactIdleTimeoutMs: 6000,
      });
      const { events, done } = startRunCompactCollect(runner, workspace);

      const startedAtMs = Date.now();
      const appendTimer = setTimeout(() => {
        appendFileSync(
          wirePath,
          JSON.stringify({ type: 'full_compaction.complete', time: Date.now() }) + '\n',
        );
      }, 2500);
      let resultAtMs = 0;
      const result = await waitForResult(events, 8000);
      if (result) resultAtMs = Date.now();
      clearTimeout(appendTimer);
      if (!result) await runner.stop();
      await done;

      expect(result?.subtype).toBe('success');
      // 结果必须晚于 complete 记录落盘时刻（旧实现 1s 假成功 → 必然提前 → 红）。
      expect(resultAtMs).toBeGreaterThanOrEqual(startedAtMs + 2500);

      await runner.dispose();
    }, 20000);

    it('runCompact 沉默超时不再假成功：无记录 → error result「压缩状态未知」', async () => {
      const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
        delayMs: 0,
      });
      const { kimiDir } = makeKimiSessionDir(workspace);
      const runner = new KimiAcpRunner({
        kind: 'kimi',
        sessionReader: new KimiSessionReader(kimiDir),
        binary: wrapper,
        acpArgs: [],
        turnIdleTimeoutMs: 30_000,
        compactIdleTimeoutMs: 1000,
      });
      const { events, done } = startRunCompactCollect(runner, workspace);

      const result = await waitForResult(events, 5000);
      if (!result) await runner.stop();
      await done;

      expect(result?.subtype).toBe('error');
      expect(result?.errorMessage).toContain('压缩状态未知');

      await runner.dispose();
    }, 20000);

    it('runCompact 等待期间 stop → interrupted（停止等待，压缩仍在后台）', async () => {
      const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
        delayMs: 0,
      });
      const { kimiDir } = makeKimiSessionDir(workspace);
      const runner = new KimiAcpRunner({
        kind: 'kimi',
        sessionReader: new KimiSessionReader(kimiDir),
        binary: wrapper,
        acpArgs: [],
        turnIdleTimeoutMs: 30_000,
      });
      const { events, done } = startRunCompactCollect(runner, workspace);

      await sleepReal(500); // prompt settle + 轮询已开始，等待中
      await runner.stop();
      const result = await waitForResult(events, 3000);
      await done;

      expect(result?.subtype).toBe('interrupted');

      await runner.dispose();
    }, 15000);
  });
});
