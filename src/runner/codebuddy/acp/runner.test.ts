/**
 * Integration tests for CodebuddyAcpRunner against a mock ACP server process.
 *
 * Same mock-server pattern as opencode/kimi: a shared mock server script
 * (acp-server.mjs) reads scenario config from a JSON file passed as argv[2],
 * then responds to JSON-RPC over stdio. protocol='codebuddy' 只影响 initialize
 * 回显的 agentName。
 *
 * Test fixture data uses AABB UUIDs and /home/user/project paths
 * (red line: no real user data in test fixtures).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../../types.js';
import {
  CODEBUDDY_RESOLVE_INTERRUPTION_METHOD,
  CodebuddyAcpRunner,
  sessionCurrentFrom,
  type CodebuddyAcpRunnerOptions,
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

describe('CodebuddyAcpRunner', () => {
  let tmpDir: string;
  let serverScript: string;

  function makeRunner(
    wrapper: string,
    extra?: Partial<CodebuddyAcpRunnerOptions>,
  ): CodebuddyAcpRunner {
    return new CodebuddyAcpRunner({
      kind: 'codebuddy',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      acpArgs: [],
      turnIdleTimeoutMs: 30_000,
      ...extra,
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-codebuddy-acp-'));
    serverScript = writeMockAcpServer(tmpDir);
  });

  afterEach(() => {
    rmRf(tmpDir);
  });

  it('pins split usage/result semantics: ACP flow is live, result events are live', () => {
    const runner = makeRunner(serverScript);
    expect(runner.getUsageAuthority()).toBe('live');
    expect(runner.usesLiveResultEvents()).toBe(true);
  });

  it('reports the configured thinking level as reasoning', () => {
    const runner = makeRunner(serverScript, { thinkingLevel: 'high' });
    expect(runner.getStatusInfo()).toMatchObject({
      kind: 'codebuddy',
      reasoning: 'high',
      extras: { mode: 'acp', permissionMode: 'default' },
    });
  });

  it('reports the default sentinel as reasoning when no thinking level is configured', () => {
    const runner = makeRunner(serverScript);
    expect(runner.getStatusInfo().reasoning).toBe('default');
  });

  it('runs a full turn: text deltas on the assistant channel + success result with usage', async () => {
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
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
              size: 200000,
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
    expect(events.some((e) => e.type === 'turn_diff')).toBe(false);

    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(resultIdx).toBeGreaterThan(initIdx);
    const result = events[resultIdx] as AgentEvent & {
      subtype?: string;
      usage?: { total_tokens?: number; context_limit?: number };
    };
    expect(result.subtype).toBe('success');
    expect(result.usage?.total_tokens).toBe(23456);
    expect(result.usage?.context_limit).toBe(200000);

    await runner.dispose();
  });

  it('filters Agent Teams private extensions (_meta codebuddy.ai/*) from the main event stream', async () => {
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'session_info_update',
              title: '团队状态：某成员上线',
              _meta: { 'codebuddy.ai/teamUpdate': { type: 'member_status_change' } },
            },
          },
        },
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'session_info_update',
              title: '主会话标题',
            },
          },
        },
      ],
    });

    const runner = makeRunner(wrapper);
    const events = await collectEvents(runner, 'hello', { cwd });

    const titles = events
      .filter((e) => e.type === 'session_info')
      .map((e) => (e as { title?: string }).title);
    // 带 _meta 团队扩展的 session_info 不得进主事件流（§9.27 同源教训）；
    // 无 _meta 的同型事件正常透传（证明过滤是按 _meta 而非按方法名一刀切）。
    expect(titles).toEqual(['主会话标题']);

    await runner.dispose();
  });

  it('drops compact broadcast chunks (array content + isCompactInternal) without breaking the turn', async () => {
    // 真机形状：CodeBuddy emergency compact 的 broadcastCompactStarted/Completed
    // 以 agent_message_chunk 发送，但 content 是数组 `[{type:'text', text}]`
    // （正常 chunk 是对象）。未过滤时 translator 取 .text 得到 undefined，
    // 卡片截断层 Buffer.byteLength(undefined) 会击穿进程。
    const compactId = `compact-maxtoken-${SESSION_ID}-1`;
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: compactId,
              content: [{ type: 'text', text: '<conversation_history_summary><summary>' }],
              _meta: {
                'codebuddy.ai/isCompactInternal': true,
                'codebuddy.ai': { messageId: compactId },
              },
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
      ],
    });

    const runner = makeRunner(wrapper);
    const events = await collectEvents(runner, 'hello', { cwd });

    const assistantTexts = events
      .filter((e) => e.type === 'assistant')
      .flatMap(
        (e) =>
          (e as { message: { content: Array<{ type: string; text?: unknown }> } }).message.content,
      )
      .filter((c) => c.type === 'text');
    expect(assistantTexts.map((c) => c.text)).toEqual(['好']);

    await runner.dispose();
  });

  it('drops text/thinking chunks whose wire content.text is not a string (seam guard)', async () => {
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: [{ type: 'text', text: '数组形状' }],
            },
          },
        },
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text' },
            },
          },
        },
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: [],
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
      ],
    });

    const runner = makeRunner(wrapper);
    const events = await collectEvents(runner, 'hello', { cwd });

    // 畸形帧不得产出 content 非 string 的块（run-state 会原样存成 undefined，
    // 渲染层 truncateUtf8 随后崩溃）。
    const malformed = events
      .filter((e) => e.type === 'assistant')
      .flatMap(
        (e) =>
          (
            e as {
              message: { content: Array<{ type?: string; text?: unknown; thinking?: unknown }> };
            }
          ).message.content,
      )
      .filter(
        (c) =>
          (c.type === 'text' && typeof c.text !== 'string') ||
          (c.type === 'thinking' && typeof c.thinking !== 'string'),
      );
    expect(malformed).toEqual([]);

    const assistantTexts = events
      .filter((e) => e.type === 'assistant')
      .flatMap(
        (e) =>
          (e as { message: { content: Array<{ type: string; text?: unknown }> } }).message.content,
      )
      .filter((c) => c.type === 'text');
    expect(assistantTexts.map((c) => c.text)).toEqual(['好']);

    await runner.dispose();
  });

  it('applies configured model and permission mode via config/mode requests', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      capturePath,
    });
    const runner = makeRunner(wrapper, {
      model: 'hy3',
      permissionMode: 'acceptEdits',
    });

    await collectEvents(runner, 'hello', { cwd });

    const calls = readCapture(capturePath);
    const modelCall = calls.find((m) => m.method === 'session/set_config_option');
    expect(modelCall).toBeDefined();
    expect((modelCall as { params: { value?: string } }).params.value).toBe('hy3');
    const modeCall = calls.find((m) => m.method === 'session/set_mode');
    expect(modeCall).toBeDefined();
    expect((modeCall as { params: { modeId?: string } }).params.modeId).toBe('acceptEdits');

    await runner.dispose();
  });

  it('sends thought_level/sandbox only when configured (real wire values)', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      capturePath,
    });
    const runner = makeRunner(wrapper, {
      thinkingLevel: 'high',
      sandbox: true,
    });

    await collectEvents(runner, 'hello', { cwd });

    const calls = readCapture(capturePath);
    const byConfigId = (id: string) =>
      calls.find((m) => {
        const params = m.params as { configId?: string } | undefined;
        return m.method === 'session/set_config_option' && params?.configId === id;
      }) as { params: { value?: unknown } } | undefined;
    // 官方选项 value 是字符串（真机实测 'true'/'false'）
    expect(byConfigId('thought_level')?.params.value).toBe('high');
    expect(byConfigId('sandbox')?.params.value).toBe('true');

    await runner.dispose();
  });

  it('omits thought_level/sandbox wire calls when not configured', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      capturePath,
    });
    const runner = makeRunner(wrapper);

    await collectEvents(runner, 'hello', { cwd });

    const calls = readCapture(capturePath);
    const configIds = calls
      .filter((m) => m.method === 'session/set_config_option')
      .map((m) => (m.params as { configId?: string } | undefined)?.configId);
    expect(configIds).not.toContain('thought_level');
    expect(configIds).not.toContain('sandbox');
    // set_mode 无条件下发（'default' 是官方合法 modeId）：热切回默认必须到
    // 达长驻连接上的活会话，跳过会让旧模式滞留到连接回收。
    const modeCall = calls.find((m) => m.method === 'session/set_mode') as
      { params?: { modeId?: string } } | undefined;
    expect(modeCall?.params?.modeId).toBe('default');

    await runner.dispose();
  });

  it('folds _meta.usage into the result event (real wire shape, live flow semantics)', async () => {
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      notifications: [
        {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'usage_update',
              used: 0,
              size: 0,
              _meta: {
                usage: {
                  prompt_tokens: 35530,
                  completion_tokens: 115,
                  total_tokens: 35645,
                  prompt_cache_hit_tokens: 1600,
                  prompt_cache_miss_tokens: 33930,
                },
              },
            },
          },
        },
      ],
    });
    const runner = makeRunner(wrapper);

    const events = await collectEvents(runner, 'hello', { cwd });
    const result = events.find((e) => e.type === 'result') as {
      subtype?: string;
      usage?: Record<string, number | undefined>;
    };
    expect(result.subtype).toBe('success');
    // flow 来自 _meta.usage：input = cache miss（不与 cacheRead 双计）
    expect(result.usage?.input_tokens).toBe(33930);
    expect(result.usage?.output_tokens).toBe(115);
    expect(result.usage?.total_tokens).toBe(35645);
    expect(result.usage?.cache_read_tokens).toBe(1600);

    await runner.dispose();
  });

  it('skips set_config_option when session configOptions already match the target', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      capturePath,
      configOptions: [
        { id: 'model', currentValue: 'hy3' },
        { id: 'thought_level', currentValue: 'high' },
        { id: 'sandbox', currentValue: 'false' },
      ],
    });
    const runner = makeRunner(wrapper, {
      model: 'hy3',
      thinkingLevel: 'high',
      sandbox: false,
    });

    await collectEvents(runner, 'hello', { cwd });

    const calls = readCapture(capturePath);
    expect(calls.filter((m) => m.method === 'session/set_config_option')).toEqual([]);
    // set_mode 无条件下发，不受缓存影响
    expect(calls.find((m) => m.method === 'session/set_mode')).toBeDefined();

    await runner.dispose();
  });

  it('sends set_config_option when session current differs from the target', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      capturePath,
      configOptions: [
        { id: 'model', currentValue: 'hy3' },
        { id: 'thought_level', currentValue: 'disabled' },
        { id: 'sandbox', currentValue: 'true' },
      ],
    });
    // 会话当前 = 免费 hy3；目标切到付费 glm-5.3 → 必须下发
    const runner = makeRunner(wrapper, {
      model: 'glm-5.3',
      thinkingLevel: 'high',
      sandbox: false,
    });

    await collectEvents(runner, 'hello', { cwd });

    const calls = readCapture(capturePath);
    const byConfigId = (id: string) =>
      calls.find((m) => {
        const params = m.params as { configId?: string } | undefined;
        return m.method === 'session/set_config_option' && params?.configId === id;
      }) as { params: { value?: unknown } } | undefined;
    expect(byConfigId('model')?.params.value).toBe('glm-5.3');
    expect(byConfigId('thought_level')?.params.value).toBe('high');
    // 官方 value 是字符串：boolean false → 'false'
    expect(byConfigId('sandbox')?.params.value).toBe('false');

    await runner.dispose();
  });

  it('spawns the ACP server with the configured binary and env passthrough', async () => {
    const envSnapshotPath = join(tmpDir, 'env-snapshot.json');
    // binary/acpArgs 由 makeRunner 固定为 mock wrapper；快照由子进程启动时写盘，
    // 断言的是 ConnectionManager 真的把 opts.env 传到了 ACP server 进程。
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      envSnapshotPath,
    });
    const runner = makeRunner(wrapper, {
      env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' },
    });

    const events = await collectEvents(runner, 'hello', { cwd });
    expect(
      events.some((e) => e.type === 'result' && (e as { subtype?: string }).subtype === 'success'),
    ).toBe(true);

    const snapshot = JSON.parse(readFileSync(envSnapshotPath, 'utf8')) as {
      env: { CODEBUDDY_INTERNET_ENVIRONMENT: string | null };
      cwd: string;
    };
    expect(snapshot.env.CODEBUDDY_INTERNET_ENVIRONMENT).toBe('internal');
    expect(snapshot.cwd).toBeTruthy();

    await runner.dispose();
  });

  it('advertises the AskUserQuestion capability in initialize', async () => {
    const capturePath = join(tmpDir, 'init-capability.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', { capturePath });
    const runner = makeRunner(wrapper);

    await collectEvents(runner, 'hello', { cwd });

    const init = readCapture(capturePath).find((m) => m.method === 'initialize');
    const capabilities = (
      init?.params as {
        clientCapabilities?: { _meta?: { 'codebuddy.ai'?: { question?: boolean } } };
      }
    )?.clientCapabilities;
    expect(capabilities?._meta?.['codebuddy.ai']?.question).toBe(true);

    await runner.dispose();
  });

  it('surfaces _codebuddy.ai/question and responds with q-indexed answers', async () => {
    const capturePath = join(tmpDir, 'question.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      sendCodebuddyQuestion: true,
      holdPromptUntilResponse: true,
      capturePath,
    });
    const runner = makeRunner(wrapper);

    const events: AgentEvent[] = [];
    let questionSeen = false;
    for await (const event of runner.run('ask me', { cwd })) {
      events.push(event);
      if (event.type === 'approval_requested' && event.kind === 'question') {
        questionSeen = true;
        expect(event.view.questions).toHaveLength(2);
        expect(event.view.questions?.[1]?.multiSelect).toBe(true);
        await runner.respondApproval(event.requestId, {
          action: 'answer',
          answers: {
            'Which database?': 'PostgreSQL',
            'Frameworks?': ['React', 'Vue'],
          },
        });
      }
    }

    expect(questionSeen).toBe(true);
    expect(events.some((e) => e.type === 'result')).toBe(true);

    // 回包必须满足 CodeBuddy callAskUserQuestion 的扁平形状：answer key 是
    // 问题序号 q_0/q_1（服务端据此回查题面），多选保留数组由服务端 join。
    const response = readCapture(capturePath).find((m) => m.id === 45 && m.result !== undefined);
    expect(response?.result).toEqual({
      outcome: 'submitted',
      answers: { q_0: 'PostgreSQL', q_1: ['React', 'Vue'] },
    });

    await runner.dispose();
  });

  it('maps decline/skip to the cancelled outcome for CodeBuddy questions', async () => {
    const capturePath = join(tmpDir, 'question-decline.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      sendCodebuddyQuestion: true,
      holdPromptUntilResponse: true,
      capturePath,
    });
    const runner = makeRunner(wrapper);

    for await (const event of runner.run('ask me', { cwd })) {
      if (event.type === 'approval_requested' && event.kind === 'question') {
        await runner.respondApproval(event.requestId, { action: 'decline' });
      }
    }

    const response = readCapture(capturePath).find((m) => m.id === 45 && m.result !== undefined);
    expect(response?.result).toEqual({ outcome: 'cancelled' });

    await runner.dispose();
  });

  it('auto-cancels an unparseable question request instead of hanging the turn', async () => {
    const capturePath = join(tmpDir, 'question-malformed.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      sendCodebuddyQuestion: true,
      codebuddyQuestionParams: { sessionId: SESSION_ID, schema: { questions: [] } },
      holdPromptUntilResponse: true,
      capturePath,
    });
    const runner = makeRunner(wrapper);

    const events = await collectEvents(runner, 'ask me', { cwd });

    expect(events.some((e) => e.type === 'approval_requested' && e.kind === 'question')).toBe(
      false,
    );
    expect(events.some((e) => e.type === 'result')).toBe(true);
    const response = readCapture(capturePath).find((m) => m.id === 45 && m.result !== undefined);
    expect(response?.result).toEqual({ outcome: 'cancelled' });

    await runner.dispose();
  });
  it('surfaces an AskUserQuestion permission and delivers answers via resolveInterruption', async () => {
    const capturePath = join(tmpDir, 'question-permission.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      sendCodebuddyQuestionPermission: true,
      holdPromptUntilResponse: true,
      capturePath,
    });
    const runner = makeRunner(wrapper);

    let questionSeen = false;
    for await (const event of runner.run('ask me', { cwd })) {
      if (event.type === 'approval_requested' && event.kind === 'question') {
        questionSeen = true;
        expect(event.view.questions).toHaveLength(2);
        await runner.respondApproval(event.requestId, {
          action: 'answer',
          answers: {
            'Which database?': 'PostgreSQL',
            'Frameworks?': ['React', 'Vue'],
          },
        });
      }
    }
    expect(questionSeen).toBe(true);

    const calls = readCapture(capturePath);
    const resolve = calls.find((m) => m.method === CODEBUDDY_RESOLVE_INTERRUPTION_METHOD);
    expect(resolve?.params).toEqual({
      sessionId: SESSION_ID,
      toolCallId: 'call_q_perm',
      decision: 'allow',
      answers: { q_0: 'PostgreSQL', q_1: ['React', 'Vue'] },
    });
    // 工具审批仍要结算，否则 handleToolApproval 一直挂着。
    const permissionResponse = calls.find((m) => m.id === 46 && m.result !== undefined);
    expect(permissionResponse?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });

    await runner.dispose();
  });

  it('maps a skipped AskUserQuestion permission to resolveInterruption deny', async () => {
    const capturePath = join(tmpDir, 'question-permission-skip.jsonl');
    const { wrapper, cwd } = writeScenario(tmpDir, serverScript, 'codebuddy', {
      sendCodebuddyQuestionPermission: true,
      holdPromptUntilResponse: true,
      capturePath,
    });
    const runner = makeRunner(wrapper);

    let questionSeen = false;
    for await (const event of runner.run('ask me', { cwd })) {
      if (event.type === 'approval_requested' && event.kind === 'question') {
        questionSeen = true;
        await runner.respondApproval(event.requestId, { action: 'decline' });
      }
    }
    expect(questionSeen).toBe(true);

    const calls = readCapture(capturePath);
    const resolve = calls.find((m) => m.method === CODEBUDDY_RESOLVE_INTERRUPTION_METHOD);
    expect(resolve?.params).toEqual({
      sessionId: SESSION_ID,
      toolCallId: 'call_q_perm',
      decision: 'deny',
    });
    const permissionResponse = calls.find((m) => m.id === 46 && m.result !== undefined);
    expect(permissionResponse?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });

    await runner.dispose();
  });
});

describe('sessionCurrentFrom', () => {
  it('models.currentModelId 主通道优先于 configOptions 兜底', () => {
    expect(
      sessionCurrentFrom({
        models: { currentModelId: 'primary' },
        configOptions: [{ id: 'model', currentValue: 'fallback' }],
      }),
    ).toEqual({ model: 'primary' });
  });

  it('主通道缺席时按 configOptions 兜底，sandbox 字符串值转 boolean', () => {
    expect(
      sessionCurrentFrom({
        configOptions: [
          { id: 'model', currentValue: 'from-options' },
          { id: 'thought_level', currentValue: 'high' },
          { id: 'sandbox', currentValue: 'true' },
        ],
      }),
    ).toEqual({ model: 'from-options', thinkingLevel: 'high', sandbox: true });
    expect(
      sessionCurrentFrom({ configOptions: [{ id: 'sandbox', currentValue: 'false' }] }),
    ).toEqual({ sandbox: false });
  });

  it('未知字段与非字符串 currentValue 忽略（保持缺失 → fail open）', () => {
    expect(
      sessionCurrentFrom({
        configOptions: [
          { id: 'unknown', currentValue: 'x' },
          { id: 'model', currentValue: 123 },
          { id: 'sandbox', currentValue: true },
        ],
      }),
    ).toEqual({});
  });
});
