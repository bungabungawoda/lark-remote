/**
 * End-to-end integration tests for CodexAppServerRunner against the fake
 * app server (tests/fake-app-server/server.mjs).
 *
 * These assert the full contract that config settings (sandbox, approval
 * policy, model) land in the real protocol request params, and that a turn
 * flows thread/start → turn/start → notifications → turn/completed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, TurnDiffEvent } from '../../types.js';
import { createInitialRunState, reduceRunState } from '../../../card/run-state.js';
import { CodexAppServerRunner } from './runner.js';
import { createStubSessionReader } from '../../../../tests/lib/bridge-stubs.js';

const FAKE_SERVER = join(process.cwd(), 'tests', 'fake-app-server', 'server.mjs');
const FIXTURES = join(process.cwd(), 'tests', 'fake-app-server', 'fixtures');

describe('CodexAppServerRunner integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-codex-appserver-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs a full turn with sandbox/approval/model config forwarded in protocol params', async () => {
    const requestLog = join(tmpDir, 'requests.jsonl');
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    // Wrapper script injects FAKE_SERVER_LOG itself (transport env is passed
    // through as-is, same as the exec-mode spawn path).
    const wrapper = join(tmpDir, 'fake-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexport FAKE_SERVER_LOG="${requestLog}"\nexec "${process.execPath}" "${FAKE_SERVER}" "${join(FIXTURES, 'normal-turn.json')}"\n`,
    );
    chmodSync(wrapper, 0o755);
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      reasoningEffort: 'high',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd })) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === 'turn_diff' && 'text' in e) as Array<{
      text: string;
    }>;
    expect(textEvents.at(-1)?.text).toBe('Hello, world!');

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string; usage?: unknown }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');
    // 真实 wire 的 tokenUsage.modelContextWindow 必须透传到 result usage.context_limit，
    // Run 卡片才能渲染 "Context - X (Y%)"（与 exec 模式 jsonl 链路等价）。
    expect((result?.usage as { context_limit?: number } | undefined)?.context_limit).toBe(200000);

    // §9.22 守卫前提：runner 必须补发 synthetic system.init（桥的 pre-init result
    // guard 与 run-state reducer 都以 init 为「本轮开始」标记；缺失会把成功 result
    // 误判为「未收到 result」，卡片终态停在 running，兜底成通用错误文案）。
    // init 的 session_id 用协议 threadId，且必须先于 result。
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init') as
      (AgentEvent & { session_id?: string }) | undefined;
    expect(init).toBeDefined();
    expect(init?.session_id).toBe('th-aaa-111');
    const initIdx = events.findIndex((e) => e.type === 'system' && e.subtype === 'init');
    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(initIdx);

    const requests = readFileSync(requestLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const threadStart = requests.find((r) => r.method === 'thread/start');
    expect(threadStart).toBeDefined();
    // 配置字段必须落到协议参数（端到端契约）
    expect(threadStart.params.cwd).toBe(cwd);
    expect(threadStart.params.model).toBe('deepseek-v4-flash');
    expect(threadStart.params.modelProvider).toBe('deepseek');
    // 配置值即协议标准值，直接透传
    expect(threadStart.params.sandbox).toBe('workspace-write');
    expect(threadStart.params.approvalPolicy).toBe('untrusted');

    const turnStart = requests.find((r) => r.method === 'turn/start');
    expect(turnStart).toBeDefined();
    expect(turnStart.params.input).toEqual([{ type: 'text', text: 'hello' }]);
    expect(turnStart.params.effort).toBe('high');

    await runner.dispose();
  });

  it('updateApprovalMode updates the local status snapshot immediately', async () => {
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    });

    // No live thread/connection yet: the method must still update the local
    // snapshot so /status reflects the saved config right away, and the next
    // thread/start/resume will use these values.
    await runner.updateApprovalMode({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });

    const info = runner.getStatusInfo();
    expect(info.extras?.sandbox).toBe('danger-full-access');
    expect(info.extras?.approvalPolicy).toBe('never');

    await runner.dispose();
  });

  it('streams interleaved items in real chronology (translator → reducer contract)', async () => {
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: process.execPath,
      appServerArgs: [FAKE_SERVER, join(FIXTURES, 'interleaved-turn.json')],
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd })) {
      events.push(event);
    }

    const diffs = events.filter((e) => e.type === 'turn_diff') as TurnDiffEvent[];
    // 问题一契约：每个 turn_diff 快照必须带 itemId + 接收时间戳
    for (const d of diffs) {
      expect(d.itemId).toBeTruthy();
      expect(d.timestamp).toBeTruthy();
    }

    // 真实时序：reasoning1 → text1 → reasoning2 → command → text2
    const firstSeen: string[] = [];
    for (const d of diffs) {
      if (!firstSeen.includes(d.itemId)) firstSeen.push(d.itemId);
    }
    expect(firstSeen).toEqual(['item-r1', 'item-1', 'item-r2', 'item-c1', 'item-2']);

    // 归约到 RunState：块顺序与真实时序一致，第二个 thinking 在底部而非顶部
    let state = createInitialRunState('run-interleave-e2e');
    for (const d of diffs) state = reduceRunState(state, d);
    expect(state.blocks.map((b) => b.kind)).toEqual([
      'thinking',
      'text',
      'thinking',
      'tool',
      'text',
    ]);
    const thinking = state.blocks.filter((b) => b.kind === 'thinking');
    expect(thinking[0].itemId).toBe('item-r1');
    expect(thinking[0].active).toBe(false);
    expect(thinking[1].itemId).toBe('item-r2');
    expect(thinking[1].active).toBe(false); // item/completed 权威完成
    expect(thinking[1].completedAt).toBeTruthy();
    const tool = state.blocks.find((b) => b.kind === 'tool');
    expect(tool?.kind === 'tool' ? tool.tool.id : undefined).toBe('item-c1');
    expect(tool?.kind === 'tool' ? tool.tool.status : undefined).toBe('ok');
    expect(tool?.kind === 'tool' ? tool.tool.completedAt : undefined).toBeTruthy();

    await runner.dispose();
  });

  it('respawns the app-server process after the child is killed externally', async () => {
    // 验证行为：app-server 子进程被外部误杀（如 SIGKILL）后，下一次 run 必须
    // 自动拉起新进程并正常完成，而不是复用死连接或永久失败。
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const pidFile = join(tmpDir, 'server.pid');
    const wrapper = join(tmpDir, 'fake-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho $$ > "${pidFile}"\nexec "${process.execPath}" "${FAKE_SERVER}" "${join(FIXTURES, 'normal-turn.json')}"\n`,
    );
    chmodSync(wrapper, 0o755);
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
    });

    const runOnce = async (): Promise<void> => {
      const events: AgentEvent[] = [];
      for await (const event of runner.run('hello', { cwd })) {
        events.push(event);
      }
      const result = events.find((e) => e.type === 'result') as
        (AgentEvent & { subtype: string }) | undefined;
      expect(result).toBeDefined();
      expect(result?.subtype).toBe('success');
    };

    await runOnce();
    const firstPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(firstPid).toBeGreaterThan(0);

    // 模拟外部误杀：SIGKILL app-server 子进程
    process.kill(firstPid, 'SIGKILL');

    // 等旧进程真正退出（transport exit 事件触发、连接槽清理完成）
    const deadline = Date.now() + 5000;
    let oldProcessGone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(firstPid, 0);
      } catch {
        oldProcessGone = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(oldProcessGone).toBe(true);

    // 下一次 run 必须自动拉起新进程并成功
    await runOnce();
    const secondPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(secondPid).toBeGreaterThan(0);
    expect(secondPid).not.toBe(firstPid);

    await runner.dispose();
  });

  it('respawns and resumes by sessionId when the app-server crashes during turn setup', async () => {
    // 验证行为：app-server 进程在 setup（thread/resume→turn/start）期间自身
    // 异常退出时，runner 必须自动重拉进程并重试一次，且按 sessionId resume
    // 继续处理——而不是把该用户消息直接判失败。
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const pidFile = join(tmpDir, 'server.pid');
    const spawnCountFile = join(tmpDir, 'spawn-count');
    // 第一个进程在收到 initialize 之后的任何请求时直接崩溃（模拟自身异常退出）
    const crashServer = join(tmpDir, 'crash-server.mjs');
    writeFileSync(
      crashServer,
      `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const msg = JSON.parse(line);\n  if (msg.method === 'initialize') {\n    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex-cli/0.147.0', codexHome: '/home/user/.codex', platformFamily: 'unix', platformOs: 'macos' } }) + '\\n');\n  } else {\n    process.exit(1);\n  }\n});\n`,
    );
    const wrapper = join(tmpDir, 'crash-once.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho $$ > "${pidFile}"\nif [ ! -f "${spawnCountFile}" ]; then printf '0\\n' > "${spawnCountFile}"; fi\nn=$(cat "${spawnCountFile}")\nn=$((n+1))\nprintf '%s\\n' "$n" > "${spawnCountFile}"\nif [ "$n" -eq 1 ]; then exec "${process.execPath}" "${crashServer}"; else exec "${process.execPath}" "${FAKE_SERVER}" "${join(FIXTURES, 'resume-turn.json')}"; fi\n`,
    );
    chmodSync(wrapper, 0o755);

    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd, sessionId: 'th-aaa-111' })) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === 'turn_diff' && 'text' in e) as Array<{
      text: string;
    }>;
    expect(textEvents.at(-1)?.text).toBe('Hello, world!');
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    // 第一次 spawn 在 setup 期间崩溃，第二次自动重拉成功 → 共 spawn 两次
    expect(Number(readFileSync(spawnCountFile, 'utf8').trim())).toBe(2);

    await runner.dispose();
  });

  it('anchors the session-key assumption: thread.id is the session key (main thread: session_meta.session_id === thread.id)', async () => {
    // 验证行为（review P2-4）：写回 store / result 事件的 session 键取自
    // thread/start 响应的 thread.id（turn/started 通知同值）。该链路依赖主线程
    // 假设 thread.id === session_meta.session_id（session reader 按
    // session_meta.session_id 定位文件）；forked/subagent 场景二者会分叉
    // （openai/codex#29327、openclaw#80136），但桥只把主线程会话作为顶层会话。
    // 本 fixture 特意让 id === sessionId，模拟真实主线程形状并锚定该假设。
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: process.execPath,
      appServerArgs: [FAKE_SERVER, join(FIXTURES, 'session-key-anchor.json')],
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { session_id?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.session_id).toBe('th-main-001');

    await runner.dispose();
  });

  it('reports the newly created thread id when turn/start fails after thread/start (review P3-10)', async () => {
    // 验证行为：thread/start 成功、turn/start 失败时，error result 的 session_id
    // 必须带上新线程 id（而非 opts.sessionId ?? ''），否则下一条消息会再开一个
    // 孤儿线程。回归锚点：catch 曾用 opts.sessionId ?? ''，新线程 id 丢失。
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: process.execPath,
      appServerArgs: [FAKE_SERVER, join(FIXTURES, 'turn-start-error.json')],
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('hello', { cwd })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string; session_id?: string; errorMessage?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('error');
    expect(result?.session_id).toBe('th-new-1');
    expect(result?.errorMessage).toContain('thread not found');
    // setup 失败路径同样必须补 init（与 spawn 失败路径 spawning-runner 一致），
    // 否则 error result 被守卫丢弃，卡片只显示通用「输出流已结束」而非真实错误。
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init') as
      (AgentEvent & { session_id?: string }) | undefined;
    expect(init).toBeDefined();
    expect(init?.session_id).toBe('th-new-1');

    await runner.dispose();
  });

  it('surfaces approval requests and responds via respondApproval', async () => {
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: process.execPath,
      appServerArgs: [FAKE_SERVER, join(FIXTURES, 'command-approval.json')],
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    });

    const events: AgentEvent[] = [];
    let approvalResponded = false;
    for await (const event of runner.run('do something', { cwd })) {
      events.push(event);
      if (event.type === 'approval_requested') {
        expect(event.kind).toBe('command');
        expect(event.view.command).toBe('rm -rf /tmp/test');
        await runner.respondApproval(event.requestId, { action: 'accept' });
        approvalResponded = true;
      }
    }

    expect(approvalResponded).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    await runner.dispose();
  });

  it('test_anchor_approval_respond_sends_amendment_decision_with_payload', async () => {
    // 验证行为：对 acceptWithExecpolicyAmendment 决策，runner 必须把协议对象
    // 决策（含 execpolicy_amendment payload）原样发回服务端——这是真实命令审批
    // 的「允许并记住命令」能力，硬编码决策空间时无法表达。
    // 缺失后果：服务端列出的 acceptWithExecpolicyAmendment 无法被响应，
    // 只能退化为普通 accept，会话内重复审批无法被记忆规则消除。
    // 依据：codex app-server 抓包（availableDecisions 含
    // {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[...]}}）。
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const requestLog = join(tmpDir, 'requests.jsonl');
    const wrapper = join(tmpDir, 'fake-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexport FAKE_SERVER_LOG="${requestLog}"\nexec "${process.execPath}" "${FAKE_SERVER}" "${join(FIXTURES, 'command-approval.json')}"\n`,
    );
    chmodSync(wrapper, 0o755);
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    });

    const events: AgentEvent[] = [];
    let amendmentResponded = false;
    for await (const event of runner.run('do something', { cwd })) {
      events.push(event);
      if (event.type === 'approval_requested') {
        await runner.respondApproval(event.requestId, {
          action: 'accept_with_execpolicy_amendment',
        });
        amendmentResponded = true;
      }
    }

    expect(amendmentResponded).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    const responses = readFileSync(requestLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.response);
    const approvalResponse = responses.find((l) => l.response.id === 1);
    expect(approvalResponse).toBeDefined();
    expect(approvalResponse.response.result).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm', '/tmp/test'] },
      },
    });

    await runner.dispose();
  });

  it('test_anchor_file_approval_fixture_surfaces_real_changes_end_to_end', async () => {
    // 验证行为：真实协议形状的 fixture（item/started 的 fileChange item 携带
    // changes[]，审批请求 grantRoot/reason 均为 null）经 fake server 全链路后，
    // approval_requested 事件的 view.fileChanges 必须包含真实 path/kind/diff。
    // 缺失后果：集成层退回旧 fixture（grantRoot 非空）会掩盖真实协议下卡片无
    // 文件信息的缺陷（线上已复现：用户只看到「📄 文件变更审批」标题）。
    // 依据：真实 codex app-server 抓包（item/started 先于审批，itemId 关联）。
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: process.execPath,
      appServerArgs: [FAKE_SERVER, join(FIXTURES, 'file-approval.json')],
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    });

    const events: AgentEvent[] = [];
    let approvalSeen = false;
    for await (const event of runner.run('do something', { cwd })) {
      events.push(event);
      if (event.type === 'approval_requested') {
        approvalSeen = true;
        expect(event.kind).toBe('file');
        expect(event.view.fileChanges).toEqual([
          {
            path: '/home/user/project/src/main.ts',
            kind: 'update',
            diff: '@@ -1 +1,2 @@\n hello\n+hello\n',
          },
        ]);
        await runner.respondApproval(event.requestId, { action: 'accept' });
      }
    }

    expect(approvalSeen).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    await runner.dispose();
  });

  it('turns an error notification into an error result', async () => {
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: process.execPath,
      appServerArgs: [FAKE_SERVER, join(FIXTURES, 'error-sequence.json')],
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('trigger error', { cwd })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string; errorMessage?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('error');
    expect(result?.errorMessage).toBe('Something went wrong');
    // 协议 error 通知路径：init 仍必须先于 result，且携带同一 threadId。
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init') as
      (AgentEvent & { session_id?: string }) | undefined;
    expect(init).toBeDefined();
    expect(init?.session_id).toBe(result?.session_id);
    const initIdx = events.findIndex((e) => e.type === 'system' && e.subtype === 'init');
    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(resultIdx).toBeGreaterThan(initIdx);

    await runner.dispose();
  });

  it('reports status extras reflecting the configured sandbox and approval policy', () => {
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: process.execPath,
      appServerArgs: [FAKE_SERVER, join(FIXTURES, 'normal-turn.json')],
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    });

    const info = runner.getStatusInfo();
    expect(info.extras).toEqual({
      mode: 'app-server',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    });
  });

  it('runs a compact operation to completion via thread/compact/start', async () => {
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const requestLog = join(tmpDir, 'compact-requests.jsonl');
    const wrapper = join(tmpDir, 'compact-fake-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexport FAKE_SERVER_LOG="${requestLog}"\nexec "${process.execPath}" "${FAKE_SERVER}" "${join(FIXTURES, 'compact-turn.json')}"\n`,
    );
    chmodSync(wrapper, 0o755);
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.runCompact('', {
      cwd,
      sessionId: 'th-aaa-999',
    })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    // 冷连接回归（2026-08-12 review）：真实 codex app-server 对未加载的线程
    // 直接 thread/compact/start 返回 -32600 "thread not found"。runner 必须先
    // thread/resume 把线程载入内存再压缩——断言请求顺序。
    const requests = readFileSync(requestLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.method);
    const resumeIndex = requests.findIndex((r) => r.method === 'thread/resume');
    const compactIndex = requests.findIndex((r) => r.method === 'thread/compact/start');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(compactIndex).toBeGreaterThan(resumeIndex);
    expect((requests[resumeIndex] as { params: { threadId: string } }).params.threadId).toBe(
      'th-aaa-999',
    );

    await runner.dispose();
  });

  it('test_anchor_permissions_approval_decline_returns_empty_grants', async () => {
    // 验证行为：权限审批点「拒绝」时，runner 必须返回空授权
    // （fileSystem.entries=[] + network.enabled=false），而不是把用户已勾选的
    // 条目作为授予发回服务端。
    // 缺失后果：用户勾选若干权限后点「❌ 拒绝」，服务端实际收到的是「授予所选
    // 权限」，拒绝形同虚设（2026-08-12 review 发现）。
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const requestLog = join(tmpDir, 'perm-requests.jsonl');
    const wrapper = join(tmpDir, 'perm-fake-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexport FAKE_SERVER_LOG="${requestLog}"\nexec "${process.execPath}" "${FAKE_SERVER}" "${join(FIXTURES, 'permissions-approval.json')}"\n`,
    );
    chmodSync(wrapper, 0o755);
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      sandbox: 'sandboxed',
      approvalPolicy: 'always',
    });

    const events: AgentEvent[] = [];
    let declined = false;
    for await (const event of runner.run('do something', { cwd })) {
      events.push(event);
      if (event.type === 'approval_requested') {
        // 先模拟用户勾选了权限（view 内 selected=true），再点「拒绝」——
        // 修复前 decline 会把勾选项原样授权返回。
        const view = event.view;
        for (const item of view.permissions?.items ?? []) {
          item.selected = true;
        }
        await runner.respondApproval(event.requestId, { action: 'decline' });
        declined = true;
      }
    }

    expect(declined).toBe(true);
    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    const responses = readFileSync(requestLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.response);
    const approvalResponse = responses.find(
      (l) => l.response && l.response.id === 1 && l.response.result,
    );
    expect(approvalResponse).toBeDefined();
    const granted = approvalResponse.response.result as {
      permissions: {
        fileSystem: { entries: unknown[] };
        network: { enabled: boolean };
      };
      scope?: 'turn' | 'session';
    };
    expect(granted.permissions.fileSystem.entries).toEqual([]);
    expect(granted.permissions.network.enabled).toBe(false);
    expect(granted.scope ?? 'turn').toBe('turn');

    await runner.dispose();
  });

  it('test_anchor_permissions_approval_accept_grants_selected_items', async () => {
    // 对照组：accept 仍然授予用户勾选的条目（decline 才清空）。
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const requestLog = join(tmpDir, 'perm-accept-requests.jsonl');
    const wrapper = join(tmpDir, 'perm-accept-fake-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexport FAKE_SERVER_LOG="${requestLog}"\nexec "${process.execPath}" "${FAKE_SERVER}" "${join(FIXTURES, 'permissions-approval.json')}"\n`,
    );
    chmodSync(wrapper, 0o755);
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: wrapper,
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      sandbox: 'sandboxed',
      approvalPolicy: 'always',
    });

    for await (const event of runner.run('do something', { cwd })) {
      if (event.type === 'approval_requested') {
        const view = event.view;
        // 勾选写路径权限后 accept：修复必须保留"勾选即授予"语义，只有
        // decline/cancel 才清空。
        const writeItem = view.permissions?.items?.find((i) => i.id.startsWith('fs-write:'));
        if (writeItem) writeItem.selected = true;
        await runner.respondApproval(event.requestId, { action: 'accept' });
      }
    }

    const responses = readFileSync(requestLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.response);
    const approvalResponse = responses.find(
      (l) => l.response && l.response.id === 1 && l.response.result,
    );
    expect(approvalResponse).toBeDefined();
    const granted = approvalResponse.response.result as {
      permissions: {
        fileSystem: { entries: unknown[] };
        network: { enabled: boolean };
      };
    };
    expect(granted.permissions.fileSystem.entries).toEqual([
      { path: '/home/user/project/src', access: 'write' },
    ]);
    expect(granted.permissions.network.enabled).toBe(false);

    await runner.dispose();
  });

  it('stop during an in-flight turn emits interrupted subtype, not error', async () => {
    // /stop（或审批超时的 interruptTurn 兜底）走 runner.stop() → forceFinish。
    // 兜底 result 必须是 interrupted 语义，不得归因于 Agent 报错。
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: createStubSessionReader(),
      binary: process.execPath,
      appServerArgs: [FAKE_SERVER, join(FIXTURES, 'hang-turn.json')],
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
    });

    const events: AgentEvent[] = [];
    const runPromise = (async () => {
      for await (const event of runner.run('hello', { cwd })) {
        events.push(event);
      }
    })();

    // 等 turn setup 完成（synthetic init 已产出）再 stop，避免与 setup 竞态。
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'system'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events.some((e) => e.type === 'system')).toBe(true);

    await runner.stop();
    await runPromise;

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string; errorMessage?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('interrupted');
    expect(result?.errorMessage).toBe('Codex app-server turn interrupted');

    await runner.dispose();
  });
});
