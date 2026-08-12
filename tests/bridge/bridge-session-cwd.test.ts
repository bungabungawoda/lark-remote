import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore, SessionReaderRegistry } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import { CommandRouter } from '../../src/router/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { AgentEvent, Runner } from '../../src/runner/index.js';
import type { SpawnOptions } from '../../src/runner/types.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
} from '../lib/bridge-stubs.js';

interface CapturingRunner extends Runner {
  readonly runCalls: SpawnOptions[];
}

function createCapturingRunner(events: AgentEvent[]): CapturingRunner {
  const runCalls: SpawnOptions[] = [];
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    runCalls,
    run: async function* (_message: string, opts: SpawnOptions) {
      runCalls.push(opts);
      for (const event of events) yield event;
    },
  };
}

let tmpRoot: string;
let config: AppConfig;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-bridge-cwd-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Bridge.forwardToClaude session cwd sync', () => {
  it('test_anchor_system_init_uses_session_cwd_over_runner_cwd', async () => {
    // L5 fix: When session init event reports a different cwd than the runner's cwd,
    // we should update sessionStore to use the session's real cwd (not the runner's cwd).
    const runCwd = path.join(tmpRoot, 'workspace-a');
    const eventCwd = path.join(tmpRoot, 'workspace-b');
    fs.mkdirSync(runCwd);
    fs.mkdirSync(eventCwd);

    const sessionStore = new SessionStore();
    sessionStore.setCwd('user1', runCwd);
    const runner = createCapturingRunner([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'session-from-init',
        cwd: eventCwd,
        model: 'opus',
      },
      { type: 'result', subtype: 'success', session_id: 'session-from-init' },
    ]);
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector: createStubConnector(),
      sessionStore,
      config,
    });

    await bridge.forwardToClaude('hello', { userId: 'user1', chatId: 'chat1', messageId: 'msg1' });

    expect(runner.runCalls).toHaveLength(1);
    // Runner is called with the user's requested cwd (runCwd)
    expect(runner.runCalls[0].cwd).toBe(runCwd);
    // sessionStore's cwd must remain unchanged (the workspace cwd)
    // sessionCwds records the session's actual directory
    expect(sessionStore.get('user1')).toEqual({
      cwd: runCwd,
      sessionCwds: new Map([['claude', eventCwd]]),
      previousSessions: new Map(),
      arrivalSessions: new Map(),
      sessions: new Map([['claude', 'session-from-init']]),
    });
  });

  it('test_anchor_system_init_empty_cwd_falls_back_to_runner_cwd', async () => {
    // L3 guard: `event.cwd ?? cwd` only catches null/undefined, NOT empty string.
    // A translator (or older build) emitting cwd="" must NOT overwrite the good
    // runner cwd with "", or last-session.json persists an empty cwd and breaks
    // auto-resume / /resume <id> / /active.
    const runCwd = path.join(tmpRoot, 'workspace-c');
    fs.mkdirSync(runCwd);

    const sessionStore = new SessionStore();
    sessionStore.setCwd('user1', runCwd);
    const runner = createCapturingRunner([
      { type: 'system', subtype: 'init', session_id: 'ses-empty', cwd: '', model: '' },
      { type: 'result', subtype: 'success', session_id: 'ses-empty' },
    ]);
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector: createStubConnector(),
      sessionStore,
      config,
    });

    await bridge.forwardToClaude('hi', { userId: 'user1', chatId: 'chat1', messageId: 'msg1' });

    // Empty cwd must fall back to runner cwd, NOT persist as "".
    expect(sessionStore.get('user1')!.cwd).toBe(runCwd);
    expect(sessionStore.get('user1')!.sessions.get('claude')).toBe('ses-empty');
    // Empty event.cwd must NOT set sessionCwds (no rewrite)
    expect(sessionStore.getSessionCwd('user1', 'claude')).toBeUndefined();
  });

  it('test_anchor_bridge_system_init_does_not_update_arrival_baseline', async () => {
    // P2#1 覆盖缺口守卫：所有「用户活动」用例都
    // 绕过 bridge 直写 sessionStore.setSessionId，唯一走真实 bridge system.init 的
    // anchor 只断言 session+cwd 的 exact-shape，没有断言「已有 arrival 基线保持
    // 不变」。
    //
    // 验证行为：system.init 只能更新 sessions[agent]/cwd（setSessionIdAndCwd），
    // 不得触碰 arrivalSessions 基线；system.init 产生的 session 变化必须在后续
    // config.save 切换时被判定为 userChangedOld=true（恢复被阻断）。
    //
    // 缺失/错误会导致：若未来在 system.init 误加 setArrivalSessionId，本测试立即
    // 变红——arrival 基线被 system.init 覆盖后 userChangedOld=false，prev[pi]=P
    // 会被错误恢复，破坏「到达基线只由 config.save 更新」的 Round 5 设计。
    //
    // 依据：P2#1；Round 5 设计（arrival 基线只在
    // config.save 切换时更新；用户消息 /resume /new /cd /system.init 均不更新）。
    const runCwd = path.join(tmpRoot, 'workspace-a');
    const eventCwd = path.join(tmpRoot, 'workspace-b');
    fs.mkdirSync(runCwd);
    fs.mkdirSync(eventCwd);

    const sessionStore = new SessionStore();
    const codexConfig = AppConfigSchema.parse({ ...config, defaultAgent: 'codex' });
    const connector = createStubConnector();
    const runner = createCapturingRunner([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'codex-session-B',
        cwd: eventCwd,
        model: 'opus',
      },
      { type: 'result', subtype: 'success', session_id: 'codex-session-B' },
    ]);
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config: codexConfig,
    });

    // 预置：arrival 基线 codex=A + 停车 prev[pi]=P + sessions[codex]=A
    sessionStore.setSessionId('user1', 'codex', 'codex-session-A', runCwd);
    sessionStore.setArrivalSessionId('user1', 'codex', 'codex-session-A');
    sessionStore.setPreviousSessionId('user1', 'pi', 'pi-session-P');
    expect(sessionStore.getSessionId('user1', 'codex')).toBe('codex-session-A');
    expect(sessionStore.getArrivalSessionId('user1', 'codex')).toBe('codex-session-A');
    expect(sessionStore.getPreviousSessionId('user1', 'pi')).toBe('pi-session-P');

    // 走真实 bridge/runner 触发 system.init（sessions[codex] 更新为新 session id）
    await bridge.forwardToClaude('hello', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    expect(sessionStore.getSessionId('user1', 'codex')).toBe('codex-session-B');
    // 核心守卫：system.init 不得更新 arrival 基线
    expect(sessionStore.getArrivalSessionId('user1', 'codex')).toBe('codex-session-A');
    expect(sessionStore.getPreviousSessionId('user1', 'pi')).toBe('pi-session-P');

    // config.save codex→pi：system.init 改过 sessions[codex] → userChangedOld=true
    // → prev[pi]=P 的恢复被阻断，消息「session 已清空」，停车保留。
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config: codexConfig,
      configPath: path.join(tmpRoot, 'config.yaml'),
      workspacePath: path.join(tmpRoot, 'workspace.json'),
      ordersPath: path.join(tmpRoot, 'orders.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });
    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    const lastText = connector._sent
      .map((s) => (s.input as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string')
      .at(-1);
    expect(lastText).toContain('session 已清空');
    expect(sessionStore.getSessionId('user1', 'pi')).toBeUndefined();
    // 被阻断的恢复不清除停车位
    expect(sessionStore.getPreviousSessionId('user1', 'pi')).toBe('pi-session-P');
    // arrival 基线全程未被 system.init / config.save 覆盖
    expect(sessionStore.getArrivalSessionId('user1', 'codex')).toBe('codex-session-A');
  });
});
