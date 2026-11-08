/**
 * Integration tests for QoderAcpRunner against a mock ACP server process.
 *
 * Same mock-server pattern as codebuddy: a shared mock server script
 * (acp-server.mjs) reads scenario config from a JSON file passed as argv[2],
 * then responds to JSON-RPC over stdio. protocol='qoder' 只影响 initialize
 * 回显的 agentName；runner 的 spawn 旗标落在 configPath 之后，mock 忽略。
 *
 * Test fixture data uses AABB UUIDs and /home/user/project paths
 * (red line: no real user data in test fixtures).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../../types.js';
import {
  QoderAcpRunner,
  formatContextWindow,
  qoderAcpSpawnArgs,
  type QoderAcpRunnerOptions,
} from './runner.js';
import {
  writeMockAcpServer,
  writeScenario,
  collectEvents,
  readCapture,
} from '../../../../tests/lib/mock-acp-server.js';
import { createStubSessionReader } from '../../../../tests/lib/bridge-stubs.js';
import { rmRf } from '../../../../tests/lib/tmp-cleanup.js';

const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

describe('QoderAcpRunner', () => {
  let tmpDir: string;
  let serverScript: string;

  function makeRunner(wrapper: string, extra?: Partial<QoderAcpRunnerOptions>): QoderAcpRunner {
    return new QoderAcpRunner({
      kind: 'qoder',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      turnIdleTimeoutMs: 30_000,
      ...extra,
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-qoder-acp-'));
    serverScript = writeMockAcpServer(tmpDir);
  });

  afterEach(() => {
    rmRf(tmpDir);
  });

  it('runs a full turn: text deltas on the assistant channel + success result with usage', async () => {
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'qoder', {
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
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
              used: 23456,
              size: 1000000,
            },
          },
        },
      ],
    });

    const runner = makeRunner(wrapper);
    const events = await collectEvents(runner, 'hello', { cwd });

    const initIdx = events.findIndex((e) => e.type === 'system' && e.subtype === 'init');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect((events[initIdx] as AgentEvent & { session_id?: string }).session_id).toBe(SESSION_ID);
    expect(events.some((e) => e.type === 'turn_started')).toBe(true);

    const assistantTexts = events
      .filter((e) => e.type === 'assistant')
      .flatMap(
        (e) =>
          (e as { message: { content: Array<{ type: string; text?: string }> } }).message.content,
      )
      .filter((c) => c.type === 'text');
    expect(assistantTexts.map((c) => c.text)).toEqual(['你', '好']);

    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(resultIdx).toBeGreaterThan(initIdx);
    const result = events[resultIdx] as AgentEvent & {
      subtype?: string;
      usage?: { total_tokens?: number; context_limit?: number };
    };
    expect(result.subtype).toBe('success');
    expect(result.usage?.total_tokens).toBe(23456);
    expect(result.usage?.context_limit).toBe(1000000);

    await runner.dispose();
  });

  it('applies permission mode via session/set_mode on every turn (unconditional)', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'qoder', {
      capturePath,
    });
    const runner = makeRunner(wrapper, { permissionMode: 'acceptEdits' });

    await collectEvents(runner, 'hello', { cwd });

    const calls = readCapture(capturePath);
    const modeCall = calls.find((m) => m.method === 'session/set_mode') as
      { params?: { modeId?: string } } | undefined;
    expect(modeCall?.params?.modeId).toBe('acceptEdits');

    await runner.dispose();
  });

  it('normalizes legacy snake_case permission modes to ACP mode ids', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'qoder', {
      capturePath,
    });
    // stream-json 时代的旧配置值：bypass_permissions → ACP 'yolo'
    const runner = makeRunner(wrapper, { permissionMode: 'bypass_permissions' });

    await collectEvents(runner, 'hello', { cwd });

    const calls = readCapture(capturePath);
    const modeCall = calls.find((m) => m.method === 'session/set_mode') as
      { params?: { modeId?: string } } | undefined;
    expect(modeCall?.params?.modeId).toBe('yolo');

    await runner.dispose();
  });

  it('sends session/set_mode with default even when unconfigured (no stale mode retention)', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'qoder', {
      capturePath,
    });
    const runner = makeRunner(wrapper);

    await collectEvents(runner, 'hello', { cwd });

    const calls = readCapture(capturePath);
    const modeCall = calls.find((m) => m.method === 'session/set_mode') as
      { params?: { modeId?: string } } | undefined;
    expect(modeCall?.params?.modeId).toBe('default');

    await runner.dispose();
  });

  it('spawns --acp with model/effort/context-window flags from config', () => {
    expect(
      qoderAcpSpawnArgs({ model: 'dfmodel', reasoningEffort: 'max', contextWindow: 1000000 }),
    ).toEqual([
      '--acp',
      '--model',
      'dfmodel',
      '--reasoning-effort',
      'max',
      '--context-window',
      '1000000',
    ]);
    // 未配置只带 --acp（跟随 Qoder settings.json）
    expect(qoderAcpSpawnArgs({})).toEqual(['--acp']);
  });

  it('surfaces approval requests and echoes the chosen option back', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'qoder', {
      capturePath,
      sendApproval: true,
    });
    const runner = makeRunner(wrapper);

    // 响应必须在 run 期间回（turn 结算会清 pendingApprovals），经 onEvent 钩子。
    const events = await collectEvents(runner, 'hello', { cwd }, async (ev) => {
      if (ev.type === 'approval_requested') {
        await runner.respondApproval((ev as { requestId: number }).requestId, {
          action: 'accept',
        });
      }
    });

    const approval = events.find((e) => e.type === 'approval_requested') as
      | { view?: { command?: string; availableDecisions?: string[] }; requestId?: number }
      | undefined;
    expect(approval).toBeDefined();
    expect(approval?.view?.command).toBe('ls /home/user/project');
    expect(approval?.view?.availableDecisions).toContain('acceptForSession');

    // 等响应落到 mock 的 capture（respond 是 fire-and-forget）
    await new Promise((r) => setTimeout(r, 100));
    const calls = readCapture(capturePath);
    const response = calls.find(
      (m) => (m as { id?: unknown }).id === 42 && m.method === undefined,
    ) as { result?: { outcome?: { outcome?: string; optionId?: string } } } | undefined;
    expect(response?.result?.outcome?.outcome).toBe('selected');
    expect(response?.result?.outcome?.optionId).toBe('once');

    await runner.dispose();
  });

  it('resumes an existing session via session/resume when sessionId is provided', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'qoder', {
      capturePath,
    });
    const runner = makeRunner(wrapper);

    const events = await collectEvents(runner, 'hello', { cwd, sessionId: SESSION_ID });

    const result = events.find((e) => e.type === 'result') as { subtype?: string };
    expect(result.subtype).toBe('success');
    const calls = readCapture(capturePath);
    const resume = calls.find((m) => m.method === 'session/resume') as
      { params?: { sessionId?: string } } | undefined;
    expect(resume?.params?.sessionId).toBe(SESSION_ID);
    expect(calls.find((m) => m.method === 'session/new')).toBeUndefined();

    await runner.dispose();
  });

  it('reuses the connection-open session on the next turn instead of re-resuming (already-open regression)', async () => {
    // 1.1.84 真机：turn 结束后会话在长驻连接上保持 active，再发
    // session/resume 被拒 "already open (state=active)"。同一 runner（同
    // cwd 缓存连接）的第二轮必须跳过 resume 直接 prompt。
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'qoder', {
      capturePath,
    });
    const runner = makeRunner(wrapper);

    // 第一轮：无 sessionId → session/new 建会话并登记为本连接的 open 会话
    const first = await collectEvents(runner, '第一轮', { cwd });
    expect((first.find((e) => e.type === 'result') as { subtype?: string }).subtype).toBe(
      'success',
    );

    // 第二轮：桥写回的 sessionId 与连接上的 open 会话相同 → reuse，不发 resume
    const second = await collectEvents(runner, '第二轮', { cwd, sessionId: SESSION_ID });
    expect((second.find((e) => e.type === 'result') as { subtype?: string }).subtype).toBe(
      'success',
    );

    const calls = readCapture(capturePath);
    expect(calls.filter((m) => m.method === 'session/resume')).toEqual([]);
    const prompts = calls.filter((m) => m.method === 'session/prompt');
    expect(prompts).toHaveLength(2);
    const news = calls.filter((m) => m.method === 'session/new');
    expect(news).toHaveLength(1);

    await runner.dispose();
  });

  it('runCompact reuses the connection-open session (no resume) but cold-resumes otherwise', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'qoder', {
      capturePath,
    });
    const runner = makeRunner(wrapper);

    // 先建会话（登记 open），随后 compact 同一会话：不 resume，直接 /compact
    await collectEvents(runner, '先说句话', { cwd });
    const events = [];
    for await (const event of runner.runCompact('compact', { cwd, sessionId: SESSION_ID })) {
      events.push(event);
    }
    expect((events.find((e) => e.type === 'result') as { subtype?: string }).subtype).toBe(
      'success',
    );

    const calls = readCapture(capturePath);
    expect(calls.filter((m) => m.method === 'session/resume')).toEqual([]);
    const compactPrompt = calls.filter((m) => m.method === 'session/prompt').pop() as
      { params?: { prompt?: Array<{ text?: string }> } } | undefined;
    expect(compactPrompt?.params?.prompt?.[0]?.text).toBe('/compact');

    await runner.dispose();
  });

  it('runCompact sends /compact as prompt text on the resumed session', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'qoder', {
      capturePath,
    });
    const runner = makeRunner(wrapper);

    const events = [];
    for await (const event of runner.runCompact('compact', { cwd, sessionId: SESSION_ID })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as { subtype?: string };
    expect(result.subtype).toBe('success');
    const calls = readCapture(capturePath);
    const prompt = calls.find((m) => m.method === 'session/prompt') as
      { params?: { prompt?: Array<{ text?: string }> } } | undefined;
    expect(prompt?.params?.prompt?.[0]?.text).toBe('/compact');

    await runner.dispose();
  });

  it('getStatusInfo reports acp mode with normalized permission mode', () => {
    const runner = makeRunner('unused-wrapper', {
      model: 'dfmodel',
      reasoningEffort: 'max',
      permissionMode: 'dont_ask',
    });
    const status = runner.getStatusInfo();
    expect(status.model).toBe('dfmodel');
    expect(status.reasoning).toBe('max');
    expect(status.extras).toEqual({ mode: 'acp', permissionMode: 'dontAsk' });
  });

  it('getStatusInfo formats contextWindow human-readable (/s 可读性)', () => {
    const runner = makeRunner('unused-wrapper', { contextWindow: 1000000 });
    expect(runner.getStatusInfo().extras).toEqual({
      mode: 'acp',
      permissionMode: 'default',
      contextWindow: '1M',
    });
  });
});

describe('formatContextWindow', () => {
  it('million-range → M, thousand-range → K, small → as-is', () => {
    expect(formatContextWindow(1000000)).toBe('1M');
    expect(formatContextWindow(1_500_000)).toBe('1.5M');
    expect(formatContextWindow(2000000)).toBe('2M');
    expect(formatContextWindow(500000)).toBe('500K');
    expect(formatContextWindow(262144)).toBe('262K');
    expect(formatContextWindow(999)).toBe('999');
  });
});
