/**
 * Anchor Test: P1-1 — registerExitHandlers 不得累积 process 监听器（A1 claude）
 *
 * ① 验证什么行为：同一进程内连续创建 5 个新的 ClaudeRunner 实例并各调用一次
 *    registerExitHandlers() 后，process 的 'exit' / 'SIGINT' / 'SIGTERM' 监听器
 *    数量相对基线增量都必须 ≤ 1。修复后的模块级单例分发只注册一次监听（内部
 *    Set<Runner> 管理实例），重复注册只加 Set 不再加监听器。
 *
 * ② 缺失/错误会导致什么问题：当前实现每实例注册 3 个永不移除的闭包（捕获整个
 *    runner 实例 + sessionReader + pidFilePath），约第 4 个 run 起触发 Node 默认
 *    MaxListenersExceededWarning 刷屏；历史 runner 被闭包永久持有，内存随 run 数
 *    无界增长；进程退出时遍历 N 份重复 cleanup。这是对设计目标数周驻留的 daemon
 *    的确定性泄漏，生产路径独有（bridge 测试全用 stub runner，覆盖不到）。
 *
 * ③ 依据：review.md §P1-1「每个 run 泄漏 3 个 process 监听器，长期驻留必发」，
 *    原文附失败用例即本测试（listenerCount 增量断言）；修复建议为模块级单例分发。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import { SpawningRunner } from '../../../src/runner/common/spawning-runner.js';
import { ClaudeRunner } from '../../../src/runner/index.js';

const PID_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-1-anchor-'));

describe('P1-1: registerExitHandlers 不累积 process 监听器', () => {
  let beforeExit: number;
  let beforeSigint: number;
  let beforeSigterm: number;

  beforeEach(() => {
    beforeExit = process.listenerCount('exit');
    beforeSigint = process.listenerCount('SIGINT');
    beforeSigterm = process.listenerCount('SIGTERM');
  });

  afterEach(() => {
    // 不真正 emit 信号；只保证本测试自身没留下多余监听器
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(beforeExit + 1);
    expect(process.listenerCount('SIGINT')).toBeLessThanOrEqual(beforeSigint + 1);
    expect(process.listenerCount('SIGTERM')).toBeLessThanOrEqual(beforeSigterm + 1);
  });

  it('test_anchor_claude_runner_register_exit_handlers_does_not_accumulate_listeners', () => {
    for (let i = 0; i < 5; i++) {
      const runner = new ClaudeRunner({
        binary: '/bin/true',
        pidDir: PID_DIR,
        workspace: `ws${i}`,
      });
      // Bridge.getRunner 对每次新 runner 实例的实际行为
      runner.registerExitHandlers();
    }

    // 单例分发修复后：首次注册 +1（或基线已装则 +0），后续只进 Set 不再加监听器
    expect(process.listenerCount('exit') - beforeExit).toBeLessThanOrEqual(1);
    expect(process.listenerCount('SIGINT') - beforeSigint).toBeLessThanOrEqual(1);
    expect(process.listenerCount('SIGTERM') - beforeSigterm).toBeLessThanOrEqual(1);
  });

  it('test_anchor_bridge_eviction_unregisters_runner_from_exit_dispatcher', () => {
    // A7（内存回收）：bridge 淘汰 (cwd, kind) 槽位时必须把 runner 从单例分发器注销，
    // 否则 Set<Runner> 永久持有每个历史 runner 实例（review §P1-1 后果②：内存随 run 数无界增长）。
    const baseline = SpawningRunner.getRegisteredExitHandlerCount();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-1-bridge-'));
    try {
      const config = AppConfigSchema.parse({
        feishu: { appId: 'test', appSecret: 'test' },
        claude: { model: 'opus', effort: 'high', stopGraceMs: 5000 },
        defaultAgent: 'claude',
        agents: {
          claude: { model: 'opus', effort: 'high' },
          codex: { model: 'glm-5.2', modelProvider: 'lt' },
          pi: { model: 'glm-5.1', provider: 'lt', thinking: 'high' },
          opencode: {
            modelID: 'claude-sonnet-4-20250505',
            providerID: 'anthropic',
            agent: 'claude',
          },
        },
        idle: { watchdogMinutes: 15 },
        output: { showThinking: true, showToolUse: true, showToolResult: true },
        logging: { level: 'info' },
      });

      const sessionStore = new SessionStore();
      const connector = {
        sendWithRetry: vi.fn().mockResolvedValue('msg-id'),
        reconnect: async () => {},
        addReaction: async () => {},
        streamCard: vi.fn().mockResolvedValue('msg-id'),
        updateCard: vi.fn().mockResolvedValue(undefined),
        connected: true,
      };
      // 生产路径：agentRegistry 工厂返回真实 runner（非 stub）
      const agentRegistry = {
        get: (_kind: string, workspace: string) =>
          new ClaudeRunner({ binary: '/bin/true', pidDir: tmpDir, workspace }),
        isRegistered: () => true,
        listRegistered: () => ['claude'],
        setConfigContainer: () => {},
        getConfigContainer: () => ({ current: config }),
      };
      const stubRunner = {
        isRunning: false,
        run: async function* () {},
        stop: async () => {},
        killOrphan: () => {},
        registerExitHandlers: () => {},
      };

      const bridge = new Bridge({
        runner: stubRunner,
        config,
        connector: connector as never,
        sessionStore,
        agentRegistry: agentRegistry as never,
        sessionReaderRegistry: null as never,
      });

      bridge.getCurrentRunner('/tmp/ws1');
      bridge.getCurrentRunner('/tmp/ws2');
      // sanity：两个 runner 已注册到单例分发器
      expect(SpawningRunner.getRegisteredExitHandlerCount()).toBe(baseline + 2);

      // clearRunners 淘汰无活跃 run 的槽位（生产路径 finalizeRun 结束时同样淘汰）——
      // 淘汰必须注销实例，否则 Set 永久持有
      bridge.clearRunners();
      expect(SpawningRunner.getRegisteredExitHandlerCount()).toBe(baseline);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_probe_exit_cleanup_still_wired_after_singleton_refactor', () => {
    // A6 反退化 probe：收编单例后，进程 exit 仍必须触发已注册 runner 的 cleanup
    // （SIGTERM 运行中进程 + 删除 pid 文件）。防绿用「空实现/不注册」骗过 A1-A5。
    // workspace 只允许字母数字（SpawningRunner 会把其他字符消毒成 _），
    // 用固定纯字母名保证 pidFilePath 可预测
    const workspace = 'exitprobe';
    const pidFile = path.join(PID_DIR, `claude-${workspace}.pid`);
    const runner = new ClaudeRunner({
      workspace: 'test',
      binary: '/bin/true',
      pidDir: PID_DIR,
      workspace,
    });
    runner.registerExitHandlers();
    fs.writeFileSync(pidFile, '12345', 'utf-8');
    expect(fs.existsSync(pidFile)).toBe(true);

    // 触发 'exit' 事件（Node 语义：只跑监听器，不真正退出进程）
    process.emit('exit');

    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('test_probe_register_exit_handlers_idempotent_for_same_instance', () => {
    // A8 probe：同一实例重复 registerExitHandlers 不得重复注册（Set 幂等）——
    // 监听器数不变、分发器计数不变。
    const beforeExit = process.listenerCount('exit');
    const beforeCount = SpawningRunner.getRegisteredExitHandlerCount();
    const runner = new ClaudeRunner({
      binary: '/bin/true',
      pidDir: PID_DIR,
      workspace: 'idempotent-probe',
    });
    runner.registerExitHandlers();
    runner.registerExitHandlers();
    runner.registerExitHandlers();
    expect(process.listenerCount('exit')).toBe(beforeExit);
    expect(SpawningRunner.getRegisteredExitHandlerCount()).toBe(beforeCount + 1);
  });
});
