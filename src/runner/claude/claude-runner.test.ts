import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRunner } from './index.js';
import { prependPath, restorePath, writeMockBin } from '../../../tests/lib/path-mock.js';
import type { AgentEvent } from '../types.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;
let savedPath: string | undefined;
const runners: ClaudeRunner[] = [];

/** 共享 Node mock claude（tests/lib/mock-claude.js，MOCK_SCENARIO 驱动）。 */
function createMockClaude(env: Record<string, string> = {}): void {
  const mockPath = path.resolve(__dirname, '../../../tests/lib/mock-claude.js');
  writeMockBin(tmpDir, 'claude', `#!/bin/bash\nexec node "${mockPath}"`);
  Object.assign(process.env, env);
}

function makeRunner(opts: Record<string, unknown> = {}): ClaudeRunner {
  const runner = new ClaudeRunner({
    workspace: 'test',
    pidDir: tmpDir,
    ...opts,
  } as ConstructorParameters<typeof ClaudeRunner>[0]);
  runners.push(runner);
  return runner;
}

/** 收集一整个 turn 的事件，超时则拒绝（防挂死类断言需要确定性终止）。 */
async function collectRunWithTimeout(
  runner: ClaudeRunner,
  message: string,
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
        for await (const ev of runner.run(message, { cwd: '/tmp' })) {
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runner-test-'));
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ClaudeRunner (long-lived interactive session)', () => {
  it('test_anchor_spawns_with_interactive_stream_json_args', async () => {
    const argsFile = path.join(tmpDir, 'args.txt');
    const mockPath = path.resolve(__dirname, '../../../tests/lib/mock-claude.js');
    writeMockBin(
      tmpDir,
      'claude',
      `#!/bin/bash\necho "$@" > "${argsFile}"\nexec node "${mockPath}"`,
    );
    const runner = makeRunner();

    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }

    const args = fs.readFileSync(argsFile, 'utf-8');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--input-format');
    expect(args).toContain('--permission-prompt-tool');
    expect(args).toContain('stdio');
    expect(args).toContain('--replay-user-messages');
    expect(args).toContain('--verbose');
    // 默认 bypassPermissions 保持旧行为（claude -p 同款权限模式）
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    // 长驻交互模式不再使用 -p
    expect(args).not.toMatch(/(^| )-p( |$)/);
    // 未指定 model 时不得传 --model
    expect(args).not.toContain('--model');
  });

  it('test_anchor_model_effort_settings_flags', async () => {
    const argsFile = path.join(tmpDir, 'args.txt');
    const mockPath = path.resolve(__dirname, '../../../tests/lib/mock-claude.js');
    writeMockBin(
      tmpDir,
      'claude',
      `#!/bin/bash\necho "$@" > "${argsFile}"\nexec node "${mockPath}"`,
    );
    const runner = makeRunner({ settings: '/tmp/settings.json' });

    for await (const _ of runner.run('hello', {
      cwd: '/tmp',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    })) {
      // consume
    }

    const args = fs.readFileSync(argsFile, 'utf-8');
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-6');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
    expect(args).toContain('--settings');
    expect(args).toContain('/tmp/settings.json');
  });

  it('test_anchor_permission_mode_default_omits_flag', async () => {
    const argsFile = path.join(tmpDir, 'args.txt');
    const mockPath = path.resolve(__dirname, '../../../tests/lib/mock-claude.js');
    writeMockBin(
      tmpDir,
      'claude',
      `#!/bin/bash\necho "$@" > "${argsFile}"\nexec node "${mockPath}"`,
    );
    const runner = makeRunner({ permissionMode: 'default' });

    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }

    const args = fs.readFileSync(argsFile, 'utf-8');
    // 'default' = Claude 的未设置模式：省略 --permission-mode
    expect(args).not.toContain('--permission-mode');
  });

  it('test_anchor_includes_resume_when_session_id', async () => {
    const argsFile = path.join(tmpDir, 'args.txt');
    const mockPath = path.resolve(__dirname, '../../../tests/lib/mock-claude.js');
    writeMockBin(
      tmpDir,
      'claude',
      `#!/bin/bash\necho "$@" > "${argsFile}"\nexec node "${mockPath}"`,
    );
    const runner = makeRunner();

    for await (const _ of runner.run('hello', { cwd: '/tmp', sessionId: 'sess-123' })) {
      // consume
    }

    const args = fs.readFileSync(argsFile, 'utf-8');
    expect(args).toContain('--resume');
    expect(args).toContain('sess-123');
  });

  it('test_anchor_user_message_written_to_stdin', async () => {
    const stdinFile = path.join(tmpDir, 'stdin.txt');
    createMockClaude({ MOCK_RECORD_STDIN: stdinFile });
    const runner = makeRunner();

    for await (const _ of runner.run('hello world', { cwd: '/tmp' })) {
      // consume
    }

    await vi.waitFor(() => {
      const written = fs.readFileSync(stdinFile, 'utf-8');
      expect(written).toContain('"type":"user"');
      expect(written).toContain('hello world');
    });
  });

  it('test_anchor_run_compact_writes_slash_compact_and_finishes_success', async () => {
    // bridge 靠鸭子类型（'runCompact' in runner）决定 Compact 按钮与执行，
    // 该断言锚定 ClaudeRunner 提供此能力。
    const stdinFile = path.join(tmpDir, 'stdin.txt');
    createMockClaude({ MOCK_SCENARIO: 'compact', MOCK_RECORD_STDIN: stdinFile });
    const runner = makeRunner();
    expect('runCompact' in runner).toBe(true);
    const events: AgentEvent[] = [];

    for await (const ev of runner.runCompact('', { cwd: '/tmp', sessionId: 's1' })) {
      events.push(ev);
    }

    await vi.waitFor(() => {
      const written = fs.readFileSync(stdinFile, 'utf-8');
      expect(written).toContain('"type":"user"');
      expect(written).toContain('/compact');
    });
    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
    expect((results[0] as { subtype?: string }).subtype).toBe('success');
  });

  it('test_anchor_run_compact_requires_session_id', async () => {
    createMockClaude({ MOCK_SCENARIO: 'compact' });
    const runner = makeRunner();

    await expect(
      (async () => {
        for await (const _ of runner.runCompact('', { cwd: '/tmp' })) {
          // consume
        }
      })(),
    ).rejects.toThrow('compact requires a sessionId');
  });

  it('test_anchor_control_request_yields_approval_and_accept_writes_allow', async () => {
    createMockClaude({ MOCK_SCENARIO: 'approval' });
    const runner = makeRunner({ permissionMode: 'default' });
    const events: AgentEvent[] = [];

    for await (const ev of runner.run('run the command', { cwd: '/tmp' })) {
      events.push(ev);
      if (ev.type === 'approval_requested') {
        await runner.respondApproval(ev.requestId, { action: 'accept' });
      }
    }

    const approval = events.find((e) => e.type === 'approval_requested');
    expect(approval).toBeDefined();
    if (approval?.type !== 'approval_requested') throw new Error('expected approval_requested');
    expect(approval.kind).toBe('command');
    expect(approval.view.command).toBe('cmd-1');
    expect(approval.view.availableDecisions).toEqual(
      expect.arrayContaining(['accept', 'decline', 'acceptAll']),
    );
    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
    expect((results[0] as { subtype?: string }).subtype).toBe('success');
  });

  it('test_anchor_approval_decline_writes_deny', async () => {
    const stdinFile = path.join(tmpDir, 'stdin.txt');
    createMockClaude({ MOCK_SCENARIO: 'approval', MOCK_RECORD_STDIN: stdinFile });
    const runner = makeRunner({ permissionMode: 'default' });
    const events: AgentEvent[] = [];

    for await (const ev of runner.run('run the command', { cwd: '/tmp' })) {
      events.push(ev);
      if (ev.type === 'approval_requested') {
        await runner.respondApproval(ev.requestId, { action: 'decline' });
      }
    }

    await vi.waitFor(() => {
      const written = fs.readFileSync(stdinFile, 'utf-8');
      expect(written).toContain('"behavior":"deny"');
    });
    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
  });

  it('test_anchor_accept_all_auto_approves_subsequent_requests', async () => {
    createMockClaude({ MOCK_SCENARIO: 'approval', MOCK_APPROVALS: '2' });
    const runner = makeRunner({ permissionMode: 'default' });
    const events: AgentEvent[] = [];

    for await (const ev of runner.run('run two commands', { cwd: '/tmp' })) {
      events.push(ev);
      if (ev.type === 'approval_requested') {
        await runner.respondApproval(ev.requestId, { action: 'accept_all' });
      }
    }

    // 仅第一个请求上抛审批；第二个被会话自动放行。
    const approvals = events.filter((e) => e.type === 'approval_requested');
    expect(approvals).toHaveLength(1);
    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
  });

  it('test_anchor_accept_all_does_not_auto_approve_ask_user_question', async () => {
    // review P1：允许所有只放行工具权限，不能把 AskUserQuestion 也空 answers 自动放行。
    createMockClaude({ MOCK_SCENARIO: 'approval-then-question' });
    const runner = makeRunner({ permissionMode: 'default' });
    const events: AgentEvent[] = [];
    let questionSeen = false;

    for await (const ev of runner.run('run then ask', { cwd: '/tmp' })) {
      events.push(ev);
      if (ev.type === 'approval_requested') {
        if (ev.kind === 'command') {
          await runner.respondApproval(ev.requestId, { action: 'accept_all' });
        } else if (ev.kind === 'question') {
          questionSeen = true;
          await runner.respondApproval(ev.requestId, {
            action: 'answer',
            answers: { 'Pick a color': 'Red' },
          });
        }
      }
    }

    // 允许所有之后提问仍必须上抛卡片（不能静默放行）
    expect(questionSeen).toBe(true);
    const approvals = events.filter((e) => e.type === 'approval_requested');
    expect(approvals).toHaveLength(2);
    const assistant = events.find((e) => e.type === 'assistant');
    expect(JSON.stringify(assistant)).toContain('Red');
    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
  });

  it('test_anchor_respond_permission_unknown_request_id_dropped', async () => {
    // review P2-2：陈旧 requestId（与 control_cancel 竞态）不得回写空 updatedInput。
    const stdinFile = path.join(tmpDir, 'stdin.txt');
    createMockClaude({ MOCK_SCENARIO: 'approval', MOCK_RECORD_STDIN: stdinFile });
    const runner = makeRunner({ permissionMode: 'default' });

    for await (const ev of runner.run('run the command', { cwd: '/tmp' })) {
      if (ev.type === 'approval_requested') {
        await runner.respondApproval(ev.requestId, { action: 'accept' });
      }
    }

    // 进程仍存活：对未知 requestId 回 allow（模拟竞态），必须被丢弃而不是
    // 以空输入 allow（claude 会拿空输入执行工具）。
    await runner.respondApproval('req-bogus', { action: 'accept' });
    const written = fs.readFileSync(stdinFile, 'utf-8');
    expect(written).not.toContain('req-bogus');
  });

  it('test_anchor_unknown_control_subtype_denied_to_avoid_hang', async () => {
    // review P3-1：未知 control_request subtype 必须 deny 兜底，否则 claude
    // 等待响应而 turn 永挂（无审批卡、无超时）。
    createMockClaude({ MOCK_SCENARIO: 'unknown-subtype' });
    const runner = makeRunner({ permissionMode: 'default' });
    const events = await collectRunWithTimeout(runner, 'run', 3000);

    const approvals = events.filter((e) => e.type === 'approval_requested');
    expect(approvals).toHaveLength(0);
    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
  });

  it('test_anchor_pre_init_events_dropped', async () => {
    // review P3-3：--resume 重放不仅含旧 result，还可能有 init 前的其他事件，
    // 一律丢弃，避免把历史内容混进当前卡片。
    createMockClaude({ MOCK_SCENARIO: 'pre-init-assistant' });
    const runner = makeRunner();
    const events: AgentEvent[] = [];

    for await (const ev of runner.run('hello', { cwd: '/tmp' })) {
      events.push(ev);
    }

    const stale = events.filter(
      (e) => e.type === 'assistant' && JSON.stringify(e).includes('STALE_REPLAY'),
    );
    expect(stale).toHaveLength(0);
    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
  });

  it('test_anchor_duplicate_question_text_denied', async () => {
    // review P3-2：answers 以问题文本为 key，重复文本会互相覆盖——协议层
    // 直接拒绝该请求（解析失败同款 deny 兜底），不把坏卡片上抛给用户。
    createMockClaude({ MOCK_SCENARIO: 'question-dup' });
    const runner = makeRunner({ permissionMode: 'default' });
    const events = await collectRunWithTimeout(runner, 'ask', 3000);

    const approvals = events.filter((e) => e.type === 'approval_requested');
    expect(approvals).toHaveLength(0);
    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
  });

  it('test_anchor_question_without_options_denied', async () => {
    // review P3-2：零选项问题无法作答（多选连自定义答案都没有），解析失败
    // 直接 deny 兜底，不把坏卡片上抛给用户。
    createMockClaude({ MOCK_SCENARIO: 'question-no-options' });
    const runner = makeRunner({ permissionMode: 'default' });
    const events = await collectRunWithTimeout(runner, 'ask', 3000);

    const approvals = events.filter((e) => e.type === 'approval_requested');
    expect(approvals).toHaveLength(0);
    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
  });

  it('test_anchor_auto_approved_request_entry_released', async () => {
    // review P2-1：autoApprove 路径写完响应后必须释放 pendingToolInputs 条目，
    // 否则长会话（允许所有）下 Map 无界增长；释放后对同 requestId 的响应被丢弃。
    const stdinFile = path.join(tmpDir, 'stdin.txt');
    createMockClaude({
      MOCK_SCENARIO: 'approval',
      MOCK_APPROVALS: '2',
      MOCK_RECORD_STDIN: stdinFile,
    });
    const runner = makeRunner({ permissionMode: 'default' });

    for await (const ev of runner.run('run two commands', { cwd: '/tmp' })) {
      if (ev.type === 'approval_requested') {
        await runner.respondApproval(ev.requestId, { action: 'accept_all' });
      }
    }

    // 条目已释放：对已自动放行的 req-2 再回响应应被丢弃（不会写第二条）。
    // 注意：req-1 走 accept_all（respondPermission 会删条目），泄漏点在于
    // 后续 autoApprove 直写路径——req-2 正是那条路径。
    await runner.respondApproval('req-2', { action: 'decline' });
    // 等 mock 把 stdin 落到文件（写入回调先于 mock append，直接读会假绿）
    await vi.waitFor(
      () => {
        const written = fs.readFileSync(stdinFile, 'utf-8');
        expect((written.match(/req-2/g) ?? []).length).toBe(1);
      },
      { timeout: 2000 },
    );
  });

  it('test_anchor_parse_failed_question_entry_released', async () => {
    // review P2-1：AskUserQuestion 解析失败 deny 后同样释放条目，避免泄漏。
    const stdinFile = path.join(tmpDir, 'stdin.txt');
    createMockClaude({
      MOCK_SCENARIO: 'question-dup',
      MOCK_RECORD_STDIN: stdinFile,
    });
    const runner = makeRunner({ permissionMode: 'default' });
    await collectRunWithTimeout(runner, 'ask', 3000);

    await runner.respondApproval('req-dup-1', { action: 'accept' });
    await vi.waitFor(
      () => {
        const written = fs.readFileSync(stdinFile, 'utf-8');
        expect((written.match(/req-dup-1/g) ?? []).length).toBe(1);
      },
      { timeout: 2000 },
    );
  });

  it('test_anchor_ask_user_question_answers', async () => {
    createMockClaude({ MOCK_SCENARIO: 'question' });
    const runner = makeRunner({ permissionMode: 'default' });
    const events: AgentEvent[] = [];

    for await (const ev of runner.run('ask me', { cwd: '/tmp' })) {
      events.push(ev);
      if (ev.type === 'approval_requested') {
        expect(ev.kind).toBe('question');
        expect(ev.view.questions).toHaveLength(2);
        await runner.respondApproval(ev.requestId, {
          action: 'answer',
          answers: { 'Pick a color': 'Red', 'Pick toppings': ['Cheese', 'Bacon'] },
        });
      }
    }

    const assistant = events.find((e) => e.type === 'assistant');
    expect(assistant).toBeDefined();
    const text = JSON.stringify(assistant);
    expect(text).toContain('Pick a color');
    expect(text).toContain('Red');
    expect(text).toContain('Pick toppings');
    expect(text).toContain('Bacon');
  });

  it('test_anchor_multiturn_reuses_process', async () => {
    const marker = path.join(tmpDir, 'marker.txt');
    createMockClaude({ MOCK_MARKER: marker });
    const runner = makeRunner();

    // 生产路径：第一条消息不带 sessionId → fresh spawn → init 上报 session_id
    // （mock 默认 's1'）→ bridge 写回 SessionStore。
    for await (const _ of runner.run('first', { cwd: '/tmp' })) {
      // consume
    }
    // 第二条消息带着写回的 sessionId 来：进程当前会话与之相同 → 必须复用，
    // 不得因「spawn 请求值 '' ≠ 's1'」误判切换而杀进程重启（review P0 回归）。
    const firstEvents: AgentEvent[] = [];
    for await (const ev of runner.run('second', { cwd: '/tmp', sessionId: 's1' })) {
      firstEvents.push(ev);
    }

    // 第二次 run 复用同一长驻进程（仅 spawn 一次）；turn 之间无新 init。
    const spawns = fs.readFileSync(marker, 'utf-8').trim().split('\n');
    expect(spawns).toHaveLength(1);
    expect(firstEvents.some((e) => e.type === 'system')).toBe(false);
    expect(firstEvents.some((e) => e.type === 'result')).toBe(true);
  });

  it('test_anchor_new_session_recycles_process', async () => {
    const marker = path.join(tmpDir, 'marker.txt');
    createMockClaude({ MOCK_MARKER: marker, MOCK_SESSION_ID: 'sess-abc' });
    const runner = makeRunner();

    for await (const _ of runner.run('first', { cwd: '/tmp', sessionId: 'sess-abc' })) {
      // consume
    }
    const secondEvents: AgentEvent[] = [];
    for await (const ev of runner.run('second', { cwd: '/tmp' })) {
      secondEvents.push(ev);
    }

    // /new 清空 sessionId 后：请求会话与进程会话不一致 → 回收旧进程重新 spawn
    // （fresh，不带 --resume），不得沿用旧会话上下文。
    const spawns = fs.readFileSync(marker, 'utf-8').trim().split('\n');
    expect(spawns).toHaveLength(2);
    expect(secondEvents.some((e) => e.type === 'system')).toBe(true);
  });

  it('test_anchor_resume_other_session_recycles_process', async () => {
    const marker = path.join(tmpDir, 'marker.txt');
    createMockClaude({ MOCK_MARKER: marker, MOCK_SESSION_ID: 'sess-abc' });
    const runner = makeRunner();

    for await (const _ of runner.run('first', { cwd: '/tmp', sessionId: 'sess-abc' })) {
      // consume
    }
    for await (const _ of runner.run('second', { cwd: '/tmp', sessionId: 'sess-xyz' })) {
      // consume
    }

    const spawns = fs.readFileSync(marker, 'utf-8').trim().split('\n');
    expect(spawns).toHaveLength(2);
  });

  it('test_anchor_idle_ttl_stops_process_between_turns', async () => {
    createMockClaude();
    const runner = makeRunner({ idleTtlMs: 50 });

    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }
    expect(runner.isRunning).toBe(true);

    // turn 结束后 idleTtlMs 无新消息 → 会话级空闲回收停止进程。
    await vi.waitFor(() => expect(runner.isRunning).toBe(false));
    const pidFile = path.join(tmpDir, 'claude-test.pid');
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('test_anchor_resume_replay_stale_result_dropped', async () => {
    createMockClaude({ MOCK_SCENARIO: 'stale-result' });
    const runner = makeRunner();
    const events: AgentEvent[] = [];

    for await (const ev of runner.run('resume me', { cwd: '/tmp', sessionId: 's1' })) {
      events.push(ev);
    }

    // --resume 先重放上一轮旧 result：会话层直接丢弃，不得误判为本 turn 结束。
    expect(events[0]?.type).toBe('system');
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
  });

  it('test_anchor_stop_kills_process_and_cleans_pid', async () => {
    createMockClaude({ MOCK_SCENARIO: 'hang' });
    const runner = makeRunner({ stopGraceMs: 500 });
    const runPromise = (async () => {
      for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
        // consume
      }
    })();

    await vi.waitFor(() => expect(runner.isRunning).toBe(true));
    await runner.stop();
    expect(runner.isRunning).toBe(false);
    await runPromise;
    const pidFile = path.join(tmpDir, 'claude-test.pid');
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('test_anchor_pid_file_cleaned_after_process_exit', async () => {
    createMockClaude({ MOCK_SCENARIO: 'crash' });
    const runner = makeRunner();
    const pidFile = path.join(tmpDir, 'claude-test.pid');

    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }

    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(false));
    expect(runner.isRunning).toBe(false);
  });

  it('test_anchor_nonzero_exit_yields_error_result_with_stderr', async () => {
    createMockClaude({ MOCK_SCENARIO: 'crash' });
    const runner = makeRunner();
    const events: AgentEvent[] = [];

    for await (const ev of runner.run('hello', { cwd: '/tmp' })) {
      events.push(ev);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    const result = results[0] as { subtype?: string; errorMessage?: string };
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toMatch(/code=7/);
    expect(result.errorMessage).toContain('authentication failed');
  });

  it('test_anchor_throws_if_turn_active', async () => {
    createMockClaude({ MOCK_SCENARIO: 'hang' });
    const runner = makeRunner();
    const runPromise = (async () => {
      for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
        // consume
      }
    })();

    await vi.waitFor(() => expect(runner.isRunning).toBe(true));
    await expect(
      (async () => {
        for await (const _ of runner.run('hello2', { cwd: '/tmp' })) {
          // consume
        }
      })(),
    ).rejects.toThrow('already running');

    await runner.stop();
    await runPromise;
  });

  it('test_anchor_yields_error_event_when_binary_not_found', async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(tmpDir, 'no-bin');
    try {
      const runner = makeRunner();
      const events: AgentEvent[] = [];
      for await (const ev of runner.run('hello', { cwd: tmpDir })) {
        events.push(ev);
      }

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('system');
      const result = events[1];
      if (result.type !== 'result') throw new Error('expected result event');
      expect(result.subtype).toBe('error');
      expect(result.errorMessage).toMatch(/不可用|not found|ENOENT/i);
      expect(runner.isRunning).toBe(false);
    } finally {
      restorePath(saved);
    }
  });
});

// --- Logging probes (regression: 2026-06-20 spawn logs missing) ---

function callsAt(
  level: 'debug' | 'info' | 'warn' | 'error',
  predicate: (first: unknown) => boolean,
): unknown[][] {
  return mockLogger[level].mock.calls.filter((call) => predicate(call[0]));
}

describe('ClaudeRunner logging probes', () => {
  beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it('test_anchor_logs_spawn_and_pid_file_write', async () => {
    createMockClaude();
    const runner = makeRunner();
    for await (const _ of runner.run('hello', { cwd: '/tmp', sessionId: 's1' })) {
      // consume
    }

    const spawnLogs = callsAt(
      'info',
      (m) => typeof m === 'string' && m.includes('[claude-runner] spawn pid='),
    );
    expect(spawnLogs.length).toBe(1);
    const spawnMsg = String(spawnLogs[0]?.[0]);
    expect(spawnMsg).toContain('binary=claude');
    expect(spawnMsg).toContain('cwd=/tmp');
    expect(spawnMsg).toContain('sessionId=s1');

    const pidLogs = callsAt(
      'info',
      (m) => typeof m === 'string' && m.includes('[claude-runner] wrote pid file'),
    );
    expect(pidLogs.length).toBe(1);
  });

  it('test_anchor_logs_non_zero_exit_with_stderr', async () => {
    createMockClaude({ MOCK_SCENARIO: 'crash' });
    const runner = makeRunner();
    for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
      // consume
    }

    const exitLogs = callsAt(
      'error',
      (m) => typeof m === 'string' && m.includes('[claude-runner] non-zero exit'),
    );
    expect(exitLogs.length).toBe(1);
    expect(String(exitLogs[0]?.[0])).toContain('code=7');
    expect(String(exitLogs[0]?.[0])).toContain('authentication failed');
  });

  it('test_anchor_fires_spawn_stage_stalled_warn_without_stdout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      createMockClaude({ MOCK_SCENARIO: 'no-stdout' });
      const runner = makeRunner({ spawnHeartbeatMs: 50 });
      const runPromise = (async () => {
        for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
          // consume
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      expect(runner.pid).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(50);

      const stalled = callsAt(
        'warn',
        (m) => typeof m === 'string' && m.includes('[claude-runner] spawn stage stalled'),
      );
      expect(stalled.length).toBeGreaterThanOrEqual(1);
      expect(String(stalled[0]?.[0])).toContain('pid=');

      await runner.stop({ immediate: true });
      await runPromise.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_anchor_no_stall_warn_when_stdout_arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      createMockClaude();
      const runner = makeRunner({ spawnHeartbeatMs: 50 });
      let resolveFirstEvent!: () => void;
      const firstEvent = new Promise<void>((resolve) => {
        resolveFirstEvent = resolve;
      });
      const runPromise = (async () => {
        for await (const e of runner.run('hello', { cwd: '/tmp' })) {
          if (e.type === 'system') resolveFirstEvent();
        }
      })();

      await firstEvent;
      await vi.advanceTimersByTimeAsync(10_000);

      const stalled = callsAt(
        'warn',
        (m) => typeof m === 'string' && m.includes('[claude-runner] spawn stage stalled'),
      );
      expect(stalled.length).toBe(0);

      await runner.stop({ immediate: true });
      await runPromise.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_anchor_stop_immediate_sends_sigterm_and_sigkill', async () => {
    createMockClaude({ MOCK_SCENARIO: 'hang' });
    const runner = makeRunner({ stopGraceMs: 30_000 });
    const runPromise = (async () => {
      for await (const _ of runner.run('hello', { cwd: '/tmp' })) {
        // consume
      }
    })();
    await vi.waitFor(() => expect(runner.isRunning).toBe(true));

    const t0 = Date.now();
    await runner.stop({ immediate: true });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_000);
    expect(runner.isRunning).toBe(false);
    await runPromise.catch(() => {});

    const sigtermLogs = callsAt(
      'debug',
      (m) => typeof m === 'string' && m.includes('sending SIGTERM'),
    );
    expect(sigtermLogs.length).toBeGreaterThanOrEqual(1);
    expect(String(sigtermLogs[sigtermLogs.length - 1]?.[0])).toContain('immediate=true');
  });
});

// ClaudeRunner implements AgentRunner (kind/sessionReader).
describe('ClaudeRunner AgentRunner adaptation', () => {
  it('exposes kind="claude" and workspace lifetime', () => {
    const runner = makeRunner();
    expect(runner.kind).toBe('claude');
    expect(runner.lifetime).toBe('workspace');
  });

  it('provides a default ClaudeSessionReader when none is injected', () => {
    const runner = makeRunner();
    expect(runner.sessionReader).toBeDefined();
    expect(typeof runner.sessionReader.listSessions).toBe('function');
    expect(typeof runner.sessionReader.getNewestSession).toBe('function');
    expect(typeof runner.sessionReader.readSessionContent).toBe('function');
    expect(typeof runner.sessionReader.isSessionActive).toBe('function');
  });

  it('getStatusInfo includes permissionMode extra', () => {
    const runner = makeRunner({ permissionMode: 'acceptEdits' });
    const info = runner.getStatusInfo();
    expect(info.kind).toBe('claude');
    expect(info.extras?.permissionMode).toBe('acceptEdits');
  });
});
