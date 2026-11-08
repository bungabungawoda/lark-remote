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

  it('pins split usage/result semantics: ACP flow is jsonl, result events are live', () => {
    const runner = makeRunner(serverScript);
    expect(runner.getUsageAuthority()).toBe('jsonl');
    expect(runner.usesLiveResultEvents()).toBe(true);
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
