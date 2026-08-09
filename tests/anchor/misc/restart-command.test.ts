/**
 * `/restart` 自重启命令契约（anchor 集）。
 * spec: restart 自重启方案
 *
 * 三条不变量：
 * 1. 持锁期间 spawn，spawn 失败 → 旧进程保持存活、pendingExit 不得置位；
 * 2. 锁是唯一权威（子进程等旧 pid 消亡后走正常 acquire）；
 * 3. 先回复再退出（pendingExit 由 handle() 在 sendResult 送达后消费）。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
} from '../../lib/bridge-stubs.js';
import {
  RESTART_WAIT_PID_ENV,
  spawnReplacementBridge,
  waitForPreviousInstance,
} from '../../../src/restart.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  return {
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => '',
    _sent: sent,
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    updateCard: async () => {},
    start: async () => {},
    stop: async () => {},
  };
}

function createStubRunner() {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    getStatusInfo: () => ({ kind: 'claude', model: 'test-model' }),
    run: async function* () {},
  };
}

function createStubRegistry(): SessionReaderRegistry {
  const registry = new SessionReaderRegistry();
  const stubReader = {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [], reason: 'not_found' }),
    isSessionActive: () => false,
  };
  for (const agent of ['claude', 'codex', 'opencode', 'pi', 'kimi'] as const) {
    registry.register(agent, stubReader);
  }
  return registry;
}

function buildRouter(
  overrides: {
    exitHandler?: () => void;
    restartSpawner?: () => number;
    sendWithRetry?: (chatId: string, input: unknown, opts?: unknown) => Promise<string>;
  } = {},
) {
  const sessionStore = new SessionStore();
  const connector = overrides.sendWithRetry
    ? {
        ...createStubConnector(),
        sendWithRetry: overrides.sendWithRetry,
      }
    : createStubConnector();
  const runner = createStubRunner();
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { binary: 'claude', model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'claude',
  });
  const bridge = new Bridge({
    runner,
    agentRegistry: createStubAgentRegistry(runner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    connector,
    sessionStore,
    config,
  });
  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath: '/tmp/restart-test-config.yaml',
    exitHandler: overrides.exitHandler,
    restartSpawner: overrides.restartSpawner,
    sessionReaderRegistry: createStubRegistry(),
  });
  return { router, connector, sessionStore };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('/restart 命令', () => {
  it('test_anchor_restart_without_spawner_returns_unsupported', async () => {
    // 验证行为：未注入 restartSpawner 时 /restart 返回明确的不支持文案，
    //   且 exitHandler 不得被调用（pendingExit 不置位）。
    // 缺失/错误会导致：用户得到误导性回复，或 exitHandler 被误触发导致 bridge 退出。
    // spec 依据：方案 §4.1 第一条「未注入 restartSpawner → 返回当前环境不支持 /restart」；
    //   §6.2「spawn 失败时 pendingExit 不得置位」（未注入等价于 spawn 不可能成功）。
    let exited = false;
    const { router, connector } = buildRouter({
      exitHandler: () => {
        exited = true;
      },
    });

    const result = await router.handle('/restart', ctx);

    expect(result?.text).toContain('当前环境不支持 /restart');
    const sent = connector._sent[0].input as { text?: string };
    expect(sent.text).toContain('当前环境不支持 /restart');
    expect(exited).toBe(false);
  });

  it('test_anchor_restart_success_replies_pid_then_exits', async () => {
    // 验证行为：spawn 成功 → 回复文案含新 pid，spawner 恰好调用一次，
    //   且 exitHandler 被调用（pendingExit 生效 = 回复送达后退出链路）。
    // 缺失/错误会导致：用户不知道新进程 pid，或 spawn 成功但 bridge 不退
    //   （旧进程不退 → 新进程撞锁退出 → 两头落空）。
    // spec 依据：方案 §2 交接协议「spawn 成功才继续 → pendingExit = true →
    //   回复重启中（新 pid N）→ process.exit(0)」；§6.3「先 spawn 后退出，
    //   顺序不可颠倒」。
    let exited = false;
    const spawner = vi.fn(() => 4242);
    const { router, connector } = buildRouter({
      exitHandler: () => {
        exited = true;
      },
      restartSpawner: spawner,
    });

    const result = await router.handle('/restart', ctx);

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(result?.text).toContain('4242');
    expect(result?.text).toContain('重启');
    const sent = connector._sent[0].input as { text?: string };
    expect(sent.text).toContain('4242');
    // handle() 在 sendResult 送达后才消费 pendingExit → exitHandler 必被调用
    expect(exited).toBe(true);
  });

  it('test_anchor_restart_reply_sent_before_exit', async () => {
    // 验证行为：pendingExit 的消费必须发生在回复送达（sendResult resolve）
    //   **之后**——先回复再退出。用延迟 resolve 的 sendWithRetry 锁顺序：
    //   回复未送达时 exitHandler 不得被调用；送达后必须被调用。
    // 缺失/错误会导致：旧进程在用户收到「重启中」之前就退出，用户感知
    //   "什么都没发生"（先退出后回复被丢），或反之旧进程永不退出。
    // spec 依据：方案 §2「先回复再退出」+ §6.3「pendingExit 的语义是
    //   本条回复送达后退出（router.handle() 里 sendResult 之后才调
    //   exitHandler）」——验收红线。
    let exited = false;
    let sendResolved = false;
    const sendWithRetry = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      sendResolved = true;
      return 'msg-id';
    };
    const { router } = buildRouter({
      exitHandler: () => {
        exited = true;
      },
      restartSpawner: () => 4242,
      sendWithRetry,
    });

    const resultPromise = router.handle('/restart', ctx);
    // 让 handle() 开始执行但 sendResult 尚未 resolve（send 延迟 20ms）
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sendResolved).toBe(false);
    expect(exited).toBe(false); // 回复未送达，旧进程不得退出

    await resultPromise;
    expect(sendResolved).toBe(true);
    expect(exited).toBe(true); // 回复送达后才退出
  });

  it('test_anchor_restart_spawn_failure_keeps_old_process_alive', async () => {
    // 验证行为：spawn 抛错 → 回复「重启失败：…，旧进程仍在运行」，
    //   且 pendingExit 不得置位（exitHandler 不被调用）——旧进程保持存活。
    // 缺失/错误会导致：spawn 失败但进程仍退出 → 新旧两头落空，bridge 无人接管。
    // spec 依据：方案 §6.2「先 spawn 后退出，顺序不可颠倒；spawn 失败时
    //   pendingExit 不得置位」+ §5.5 异常路径验收文案。
    let exited = false;
    const spawner = vi.fn(() => {
      throw new Error('spawn ENOENT');
    });
    const { router, connector } = buildRouter({
      exitHandler: () => {
        exited = true;
      },
      restartSpawner: spawner,
    });

    const result = await router.handle('/restart', ctx);

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(result?.text).toContain('重启失败');
    expect(result?.text).toContain('旧进程仍在运行');
    expect(result?.text).toContain('spawn ENOENT');
    const sent = connector._sent[0].input as { text?: string };
    expect(sent.text).toContain('重启失败');
    expect(exited).toBe(false);
  });

  it('test_anchor_wait_for_previous_instance_env_semantics', async () => {
    // 验证行为：waitForPreviousInstance 的 env 语义——无 env 立即返回；
    //   env 指向已死 pid 立即返回；非法值（非数字/0/负数/小数）立即返回；
    //   调用后 env 被 delete（一次性消费，孙进程不继承等待）。
    // 缺失/错误会导致：重启链断裂（孙进程误等祖父 pid）或 env 泄漏
    //   （后续 restart 的继任者错误等待一个无关 pid）。
    // spec 依据：方案 §6.4「env 一次性消费：waitForPreviousInstance 开头
    //   delete process.env[...]，否则若新进程未来也被 /restart，孙进程会
    //   错误等待祖父 pid」+ §4.1 各环境分支。
    const saved = process.env[RESTART_WAIT_PID_ENV];
    try {
      // 1) 无 env → 立即返回（不抛错、不等待）
      delete process.env[RESTART_WAIT_PID_ENV];
      await waitForPreviousInstance();

      // 2) env 指向已死 pid → 立即返回（ESRCH → 视为旧进程已退出）
      process.env[RESTART_WAIT_PID_ENV] = '999999999';
      const t0 = Date.now();
      await waitForPreviousInstance();
      expect(Date.now() - t0).toBeLessThan(2000);

      // 3) 非法值 → 立即返回
      for (const bad of ['abc', '0', '-5', '12.5']) {
        process.env[RESTART_WAIT_PID_ENV] = bad;
        const t = Date.now();
        await waitForPreviousInstance();
        expect(Date.now() - t).toBeLessThan(2000);
      }

      // 4) 一次性消费：调用后 env 必须被删除
      process.env[RESTART_WAIT_PID_ENV] = '999999999';
      await waitForPreviousInstance();
      expect(process.env[RESTART_WAIT_PID_ENV]).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env[RESTART_WAIT_PID_ENV];
      else process.env[RESTART_WAIT_PID_ENV] = saved;
    }
  });

  it('test_anchor_help_lists_restart_command', async () => {
    // 验证行为：/help 卡片包含 /restart 条目——按钮 label 为 /restart、
    //   callback cmd 为 help.restart、描述含「重启 bridge」。
    // 缺失/错误会导致：用户不知道存在 /restart 命令，功能不可发现。
    // spec 依据：方案 §3「/help 列表加 /restart 条目」+ §4.1「帮助列表含
    //   /restart 条目」。
    const { router, connector } = buildRouter();

    await router.handle('/help', ctx);

    const card = (connector._sent[0].input as { card?: object }).card;
    expect(card).toBeDefined();

    // 递归收集所有元素（column_set/column 嵌套）
    const texts: string[] = [];
    const behaviors: { cmd?: string }[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const n of node) walk(n);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (typeof obj.text === 'object' && obj.text !== null) {
        const content = (obj.text as Record<string, unknown>).content;
        if (typeof content === 'string') texts.push(content);
      }
      if (Array.isArray(obj.behaviors)) {
        for (const b of obj.behaviors) {
          const value = (b as Record<string, unknown>).value as { cmd?: string } | undefined;
          if (value) behaviors.push(value);
        }
      }
      for (const key of ['elements', 'columns', 'body', 'header']) {
        if (Array.isArray(obj[key])) walk(obj[key]);
        else if (obj[key] !== null && typeof obj[key] === 'object') walk(obj[key]);
      }
    };
    walk(card);

    expect(texts).toContain('/restart');
    expect(texts.some((t) => t.includes('重启 bridge'))).toBe(true);
    expect(behaviors.some((b) => b.cmd === 'help.restart')).toBe(true);
  });

  it('test_anchor_help_restart_button_click_completes_handoff', async () => {
    // 验证行为：/help 卡片上的 /restart 按钮（help.restart 回调）被点击后，
    //   必须完整走完交接协议——spawn 继任者 + 回复 + exitHandler 被调用
    //   （pendingExit 在回复送达后被消费，与 handle() 路径一致）。
    // 缺失/错误会导致：按钮点击 spawn 成功但旧进程不退出 → 新进程等 20s 后
    //   撞单例锁退出，用户看到「重启中」但重启实际失败——help 按钮是 /restart
    //   的用户可见入口，行为必须与手打 /restart 一致。
    // spec 依据：方案 §3「/help 列表加 /restart 条目」+ §2 交接协议「spawn
    //   成功 → pendingExit = true → 回复重启中 → 旧进程退出」。
    let exited = false;
    const spawner = vi.fn(() => 4242);
    const { router, connector } = buildRouter({
      exitHandler: () => {
        exited = true;
      },
      restartSpawner: spawner,
    });

    await router.handleCardAction({ cmd: 'help.restart' }, ctx);

    expect(spawner).toHaveBeenCalledTimes(1);
    const sent = connector._sent[0].input as { text?: string };
    expect(sent.text).toContain('4242');
    // handleCardAction 也必须在回复送达后消费 pendingExit，否则旧进程不退出，
    // 新进程撞锁退出，重启两头落空。
    expect(exited).toBe(true);
  });

  it('test_anchor_r_alias_stays_resume_not_restart', async () => {
    // 验证行为：/r 仍解析为 /resume（返回 resume 语义文案），不得落到
    //   /restart（不触发 spawner / exitHandler / 重启文案）。
    // 缺失/错误会导致：/r 被 /restart 抢占后用户无法用短别名恢复会话，
    //   且误触发 bridge 重启（破坏性副作用）。
    // spec 依据：方案 §7.2「/r 别名已被 /resume 占用，/restart 不要加
    //   单字母别名」。
    let exited = false;
    const spawner = vi.fn(() => 4242);
    const { router } = buildRouter({
      exitHandler: () => {
        exited = true;
      },
      restartSpawner: spawner,
    });

    const result = await router.handle('/r', ctx);

    expect(spawner).not.toHaveBeenCalled();
    expect(exited).toBe(false);
    expect(result?.text).toBe('请先 /cd 设置工作目录');
    expect(result?.text).not.toContain('重启');
  });

  it('test_anchor_spawn_replacement_bridge_handoff_contract', () => {
    // 验证行为：spawnReplacementBridge 以 (execPath, argv.slice(1)) 起 detached
    //   子进程，env 注入 RESTART_WAIT_PID_ENV=当前 pid，stdio 落 restart-child.log；
    //   pid 缺失抛错；注册 error 兜底 + unref。
    // 缺失/错误会导致：重启交接协议失效——configDir 不继承（argv 错）、子进程
    //   不等旧进程退（env 错）、早期启动失败无处可查（stdio 落 null）、late
    //   spawn error 吃掉濒死父进程的 unhandled rejection（缺 error 兜底）。
    // spec 依据：方案 §3 spawnReplacementBridge 描述 + §6.5「stdio 不落 null」+
    //   §6.6「child.on('error') 兜底」+ §7.6「argv 原样继承」。
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-logs-'));
    try {
      const child = { pid: 7777, on: vi.fn(), unref: vi.fn() };
      spawnMock.mockReturnValue(child);

      const pid = spawnReplacementBridge(logsDir);

      expect(pid).toBe(7777);
      expect(fs.existsSync(path.join(logsDir, 'restart-child.log'))).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [exe, args, opts] = spawnMock.mock.calls[0] as [
        string,
        string[],
        {
          cwd: string;
          env: Record<string, string | undefined>;
          detached: boolean;
          stdio: unknown[];
        },
      ];
      expect(exe).toBe(process.execPath);
      expect(args).toEqual(process.argv.slice(1));
      expect(opts.cwd).toBe(process.cwd());
      expect(opts.detached).toBe(true);
      expect(opts.env[RESTART_WAIT_PID_ENV]).toBe(String(process.pid));
      expect(opts.stdio[0]).toBe('ignore');
      expect(typeof opts.stdio[1]).toBe('number'); // restart-child.log fd
      expect(opts.stdio[2]).toBe(opts.stdio[1]);
      expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(child.unref).toHaveBeenCalled();

      // pid undefined → 必须抛错（spawn 同步失败路径，AGENTS.md ENOENT 红线）
      spawnMock.mockReturnValueOnce({ pid: undefined, on: vi.fn(), unref: vi.fn() });
      expect(() => spawnReplacementBridge(logsDir)).toThrow(/no pid/);
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('test_anchor_spawn_error_handler_attached_before_pid_check', () => {
    // 验证行为：spawn 同步失败（pid === undefined，抛错）时，'error' 兜底
    //   handler 也必须在抛错之前已注册——异步 spawn 失败（如运行中二进制被删/
    //   ENOENT）会在下一 tick 发 'error' 事件，若无人监听 → uncaughtException
    //   → 旧 bridge 的 uncaughtException handler release 锁 + exit(1)，旧进程
    //   在刚回复「重启失败，旧进程仍在运行」后反而退出 = 两头落空。
    // 缺失/错误会导致：违反方案 §6.6「late spawn error（如运行中二进制被删）
    //   不能让濒死的父进程再吃一个 unhandled error」+ §6.2「spawn 失败 →
    //   旧进程保持存活」。
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-logs-'));
    try {
      const child = { pid: undefined, on: vi.fn(), unref: vi.fn() };
      spawnMock.mockReturnValueOnce(child);

      expect(() => spawnReplacementBridge(logsDir)).toThrow(/no pid/);
      // 抛错后 error handler 也必须已注册（必须在 pid check / throw 之前挂上）
      expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
