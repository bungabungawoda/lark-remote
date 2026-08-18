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
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../../types.js';
import { KimiAcpRunner } from './runner.js';
import { writeMockAcpServer, writeScenario } from '../../../../tests/lib/mock-acp-server.js';
import { createStubSessionReader } from '../../../../tests/lib/bridge-stubs.js';
import { KimiSessionReader } from '../../../session/kimi/sessions.js';

const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

describe('KimiAcpRunner', () => {
  let tmpDir: string;
  let serverScript: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-kimi-runner-'));
    serverScript = writeMockAcpServer(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd: workspace })) {
      events.push(event);
    }

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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd: workspace })) {
      events.push(event);
    }

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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd: workspace })) {
      events.push(event);
    }

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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd: workspace, sessionId: SESSION_ID })) {
      events.push(event);
    }

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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('think', { cwd: workspace })) {
      events.push(event);
    }

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
              title: 'Bash',
              kind: 'execute',
              status: 'in_progress',
              rawInput: { command: 'ls' },
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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('list files', { cwd: workspace })) {
      events.push(event);
    }

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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('do something', { cwd: workspace })) {
      events.push(event);
      if (event.type === 'approval_requested') {
        await runner.respondApproval(event.requestId, { action: 'decline' });
      }
    }

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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('do something', { cwd: workspace })) {
      events.push(event);
      if (event.type === 'approval_requested') {
        await runner.respondApproval(event.requestId, { action: 'cancel' });
      }
    }

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

  it('returns live usage authority', () => {
    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: 'kimi',
      acpArgs: [],
    });

    expect(runner.getUsageAuthority()).toBe('live');
  });

  it('has workspace lifetime', () => {
    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: 'kimi',
      acpArgs: [],
    });

    expect(runner.lifetime).toBe('workspace');
  });

  it('kills no orphans (managed by connection manager)', () => {
    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: 'kimi',
      acpArgs: [],
    });
    // killOrphan is a no-op — just verify it doesn't throw
    expect(() => runner.killOrphan()).not.toThrow();
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
      compactPollTimeoutMs: 5000,
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

  it('runCompact times out polling with a WARN and still succeeds when no compaction record appears (R2)', async () => {
    const { wrapper, workspace } = writeScenario(tmpDir, serverScript, 'kimi', {
      delayMs: 20,
      compactionRecordDelayMs: null,
    });
    const { kimiDir } = makeKimiSessionDir(workspace);

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: new KimiSessionReader(kimiDir),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
      compactPollTimeoutMs: 1000,
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.runCompact('', {
      cwd: workspace,
      sessionId: SESSION_ID,
    })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    await runner.dispose();
  }, 10000);

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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd: workspace })) {
      events.push(event);
    }
    await runner.dispose();

    const received = readFileSync(capturePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params?: unknown });

    const initialize = received.find((m) => m.method === 'initialize');
    expect(initialize?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd: workspace })) {
      events.push(event);
    }

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

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd: workspace })) {
      events.push(event);
    }

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

    // Spawn counter: first invocation crashes, second succeeds
    const spawnCountFile = join(tmpDir, 'spawn-count');
    const wrapper = join(tmpDir, 'retry-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh
if [ ! -f "${spawnCountFile}" ]; then printf '0\\n' > "${spawnCountFile}"; fi
n=$(cat "${spawnCountFile}")
n=$((n+1))
printf '%s\\n' "$n" > "${spawnCountFile}"
if [ "$n" -eq 1 ]; then
  exec "${process.execPath}" "${serverScript}" "${crashConfigPath}"
else
  exec "${process.execPath}" "${serverScript}" "${normalConfigPath}"
fi
`,
    );
    chmodSync(wrapper, 0o755);

    const runner = new KimiAcpRunner({
      kind: 'kimi',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd: crashWorkspace })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    // Should have spawned twice (crash + retry)
    expect(Number(readFileSync(spawnCountFile, 'utf8').trim())).toBe(2);

    await runner.dispose();
  });
});
