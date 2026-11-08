import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { QoderRunner } from './index.js';
import { prependPath, restorePath, writeMockBin } from '../../../tests/lib/path-mock.js';
import type { AgentEvent } from '../types.js';
import { rmRf } from '../../../tests/lib/tmp-cleanup.js';
import { QoderSessionReader } from '../../session/qoder/index.js';

vi.mock('../../logger/index.js', async () =>
  (await import('../../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

let tmpDir: string;
let savedPath: string | undefined;
const runners: QoderRunner[] = [];

/** 共享 Node mock CLI（tests/lib/mock-claude.js，stream-json 协议与 qoder 同构）。 */
const MOCK_CLI = path.resolve(__dirname, '../../../tests/lib/mock-claude.js');

function createMockQodercn(env: Record<string, string> = {}): void {
  writeMockBin(tmpDir, 'qodercn', MOCK_CLI);
  Object.assign(process.env, env);
}

function makeRunner(opts: Record<string, unknown> = {}): QoderRunner {
  const runner = new QoderRunner({
    sessionReader: new QoderSessionReader({ configDir: tmpDir }),
    cwd: 'test',
    pidDir: tmpDir,
    ...opts,
  } as ConstructorParameters<typeof QoderRunner>[0]);
  runners.push(runner);
  return runner;
}

/** 收集一整个 turn 的事件，超时则拒绝（防挂死类断言需要确定性终止）。 */
async function collectRunWithTimeout(
  runner: QoderRunner,
  message: string,
  opts: {
    cwd?: string;
    sessionId?: string;
    model?: string;
    effort?: string;
    reasoningEffort?: string;
  } = {},
  timeoutMs = 3000,
): Promise<AgentEvent[]> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`turn did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      (async () => {
        const events: AgentEvent[] = [];
        for await (const ev of runner.run(message, { cwd: opts.cwd ?? tmpDir, ...opts })) {
          events.push(ev);
        }
        return events;
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-qoder-runner-test-'));
  savedPath = prependPath(tmpDir);
});

afterEach(async () => {
  for (const r of [...runners]) {
    try {
      await r.dispose();
    } catch {
      /* ignore */
    }
  }
  runners.length = 0;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MOCK_')) delete process.env[key];
  }
  restorePath(savedPath);
  rmRf(tmpDir);
});

describe('QoderRunner (long-lived stream-json session)', () => {
  it('test_anchor_spawns_with_stream_json_args_and_no_replay_flag', async () => {
    const argsFile = path.join(tmpDir, 'args.txt');
    createMockQodercn({ MOCK_ARGS_FILE: argsFile });
    const runner = makeRunner();

    await collectRunWithTimeout(runner, 'hello');

    const args = fs.readFileSync(argsFile, 'utf-8');
    // flag 必须在 argv 最前（qodercn 的 dispatcher 会把「首参为已存在文件路径」
    // 劫持给 IDE；headless 调用永远 flag 开头）。
    expect(args.startsWith('--output-format')).toBe(true);
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--input-format');
    // qoder 没有 --replay-user-messages（claude 专属）
    expect(args).not.toContain('--replay-user-messages');
    // 真机 1.1.72 实测：--permission-prompt-tool stdio 与 --input-format
    // stream-json 互斥（CLI 报错拒绝）；审批由静态 --permission-mode 治理。
    expect(args).not.toContain('--permission-prompt-tool');
    // --verbose 在非 -p 形状下 unknown option；--include-partial-messages 的
    // stream_event 行需要独立翻译面，v1 不开（事件面与 claude 管线一致）。
    expect(args).not.toContain('--verbose');
    expect(args).not.toContain('--include-partial-messages');
    // 默认权限模式 'default' = 省略 --permission-mode
    expect(args).not.toContain('--permission-mode');
    // 未指定 model / effort 时不得传对应 flag
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--reasoning-effort');
  });

  it('test_anchor_flags_for_model_effort_permission_and_resume', async () => {
    const argsFile = path.join(tmpDir, 'args.txt');
    createMockQodercn({ MOCK_ARGS_FILE: argsFile });
    const runner = makeRunner({
      permissionMode: 'accept_edits',
      reasoningEffort: 'high',
    });

    await collectRunWithTimeout(runner, 'hello', {
      sessionId: 'sess-42',
      model: 'qfmodel',
      // per-run 覆盖走 reasoningEffort（与 codex 的 run 选项字段对称，bridge
      // getAgentRunOptions 同口径）；应压过构造器的默认档位
      reasoningEffort: 'xhigh',
    });

    const args = fs.readFileSync(argsFile, 'utf-8');
    // qoder 权限模式是 snake_case（与 claude 的 camelCase 不同）
    expect(args).toContain('--permission-mode accept_edits');
    expect(args).toContain('--resume sess-42');
    expect(args).toContain('--model qfmodel');
    // 推理强度走 --reasoning-effort（--effort 是 claude 专属）
    expect(args).toContain('--reasoning-effort xhigh');
    expect(args).not.toMatch(/--effort(?!-)/);
  });

  it('test_anchor_plain_turn_yields_init_assistant_result', async () => {
    createMockQodercn();
    const runner = makeRunner();

    const events = await collectRunWithTimeout(runner, '你好');

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('system'); // synthetic/wire init
    expect(events.some((e) => e.type === 'assistant')).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result?.subtype).toBe('success');
  });

  it('test_anchor_runcompact_writes_slash_command', async () => {
    const stdinFile = path.join(tmpDir, 'stdin.txt');
    createMockQodercn({ MOCK_RECORD_STDIN: stdinFile });
    const runner = makeRunner();

    // 先跑一条普通消息拿到 sessionId
    await collectRunWithTimeout(runner, 'hello', { sessionId: 's1' });
    const events: AgentEvent[] = [];
    for await (const ev of runner.runCompact('compact now', {
      cwd: tmpDir,
      sessionId: 's1',
    })) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === 'result')).toBe(true);

    const stdin = fs.readFileSync(stdinFile, 'utf-8');
    expect(stdin).toContain('/compact');
  });

  it('test_anchor_passes_explicit_context_window', async () => {
    const argsFile = path.join(tmpDir, 'args.txt');
    createMockQodercn({ MOCK_ARGS_FILE: argsFile });
    const runner = makeRunner({ contextWindow: 262144 });

    await collectRunWithTimeout(runner, 'hello');

    const args = fs.readFileSync(argsFile, 'utf-8');
    // 配置的上下文窗口原样透传 --context-window（CLI 做正整数校验）
    expect(args).toContain('--context-window 262144');
  });

  it('test_anchor_strips_all_zero_usage_from_result', async () => {
    // qoder 的 usage token 字段实测恒 0（真实数字只有 credits）：全零 usage
    // 保留会让 done 卡渲染「Input token - 0」伪行，runner 出口必须剥掉。
    createMockQodercn({ MOCK_SESSION_USAGE: 'qoder-zero' });
    const runner = makeRunner();

    const events = await collectRunWithTimeout(runner, 'hello');

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { usage?: unknown }) | undefined;
    expect(result).toBeDefined();
    expect(result?.usage).toBeUndefined();
  });

  it('test_anchor_strips_usage_but_keeps_total_credits', async () => {
    // 全零剥离只剥 usage 对象：顶层的 total_credits（qoder 的真实计费数字）
    // 必须原样透传给卡片，否则积分显示无从谈起。
    createMockQodercn({ MOCK_SESSION_USAGE: 'qoder-zero', MOCK_RESULT_CREDITS: '12' });
    const runner = makeRunner();

    const events = await collectRunWithTimeout(runner, 'hello');

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { usage?: unknown; total_credits?: number }) | undefined;
    expect(result?.usage).toBeUndefined();
    expect(result?.total_credits).toBe(12);
  });

  it('test_anchor_keeps_real_usage_from_result', async () => {
    // 非全零 usage（如 /compact 回包带真实 token 数）原样保留
    createMockQodercn({ MOCK_SESSION_USAGE: 'qoder-real' });
    const runner = makeRunner();

    const events = await collectRunWithTimeout(runner, 'hello');

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { usage?: { input_tokens?: number } }) | undefined;
    expect(result?.usage?.input_tokens).toBe(159633);
  });

  it('test_anchor_respondApproval_delegates_to_session_and_maps_allow_deny', async () => {
    // 批次 A 后 qoder runner 只是薄委托（映射在 ClaudeSession.respondApproval）；
    // 只钉住通道终点：allow / deny 各自抵达 session.respondPermission。
    // 不启动 CLI、不触碰真实会话/进程。
    const runner = makeRunner();
    const session = (
      runner as unknown as {
        session: {
          respondPermission: (requestId: number | string, result: unknown) => Promise<void>;
        };
      }
    ).session;
    const respondPermission = vi.fn().mockResolvedValue(undefined);
    session.respondPermission = respondPermission;

    await runner.respondApproval('req-allow', { action: 'accept' });
    await runner.respondApproval('req-deny', { action: 'decline' });

    expect(respondPermission).toHaveBeenNthCalledWith(1, 'req-allow', { behavior: 'allow' });
    expect(respondPermission).toHaveBeenNthCalledWith(2, 'req-deny', { behavior: 'deny' });
  });

  it('test_anchor_explicit_empty_binary_is_not_rewritten_to_default', () => {
    // 默认值用 ?? 而非 ||：显式配置（哪怕是空串）属于边界数据，不应被静默改写
    // 成 'qodercn'——否则配置错误会被默认值掩盖，排障时看不到真实入参。
    // 不启动 CLI、不触碰真实进程。
    const runner = makeRunner({ binary: '' });
    const session = (runner as unknown as { session: { binary: string } }).session;
    expect(session.binary).toBe('');
  });

  it('test_anchor_explicit_empty_permission_mode_is_not_rewritten_to_default', () => {
    // 同样用 ?? 而非 ||：显式空串必须保持原值，不能被 'default' 掩盖。
    // 空串与 'default' 在 buildArgv 上都不产生 --permission-mode，所以只能
    // 直接钉住构造器内部取值，否则该边界会被 mutator 的 ?? -> || 变异吃掉。
    // 不启动 CLI、不触碰真实进程。
    const runner = makeRunner({ permissionMode: '' });
    expect((runner as unknown as { permissionMode: string }).permissionMode).toBe('');
  });

  it('test_anchor_runcompact_strips_all_zero_usage_from_result', async () => {
    // runCompact 必须与 run 走同一条全零剥离出口（两者的 result 判定是同一个分支）。
    createMockQodercn({ MOCK_SESSION_USAGE: 'qoder-zero' });
    const runner = makeRunner();
    await collectRunWithTimeout(runner, 'hello', { sessionId: 's1' });

    const events: AgentEvent[] = [];
    for await (const ev of runner.runCompact('compact now', { cwd: tmpDir, sessionId: 's1' })) {
      events.push(ev);
    }
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { usage?: unknown }) | undefined;
    expect(result).toBeDefined();
    expect(result?.usage).toBeUndefined();
  });

  it('test_anchor_runcompact_requires_session_id', async () => {
    // 缺 sessionId 必须在首个 next() 就 reject（不触碰进程/真实会话）。
    const runner = makeRunner();
    await expect(
      (async () => {
        for await (const _ of runner.runCompact('x', { cwd: tmpDir })) {
          // consume
        }
      })(),
    ).rejects.toThrow('compact requires a sessionId');
  });
});
