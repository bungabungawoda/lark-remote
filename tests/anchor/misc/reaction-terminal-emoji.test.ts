/**
 * Adversarial TDD anchor —— reaction 表情按运行终态区分（spec 2026-08-02 用户确认）
 *
 * 验证什么：coding agent 运行以 error 终态结束时，贴在用户原消息上的
 *   connector.addReaction 必须收到 'ERROR'，而不是 'Done'。
 * 缺失/错误会导致什么：失败的单子会显示成功表情，用户扫一眼误判为完成，
 *   与 spec「error → ERROR、失败不能用 done」冲突。
 * 依据：round-log spec（用户 2026-08-02 确认）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Runner, AgentEvent } from '../../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
} from '../../lib/bridge-stubs.js';
import { rmRf } from '../../lib/tmp-cleanup.js';

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

// --- Stubs（Bridge 边界测试替身，与 src/bridge/bridge.test.ts 同模式） ---

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('reaction emoji by run terminal (anchor)', () => {
  let tmpDir: string;
  let config: AppConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-reaction-anchor-'));
    config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
    });
  });

  afterEach(() => {
    // Windows：executeBash 拉起的子进程 cwd 可能就是 tmpDir，句柄未释放时裸
    // rmSync 会 EPERM。走重试 + 精准杀占用进程的 rmRf。
    rmRf(tmpDir);
  });

  /**
   * 验证什么：runner 直接抛错 → run 终态为 error → reaction 必须是 'ERROR'。
   * 缺失/错误会导致什么：失败的单子显示 Done（成功表情），误导用户。
   * 依据：round-log spec「error → 'ERROR'」。
   */
  it('test_anchor_run_error_terminal_adds_error_reaction', async () => {
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        throw new Error('claude died');
      },
    };
    const connector = createStubConnector({ addReactionSpy: true });
    const sessionStore = new SessionStore();
    sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
      idleTimeoutMs: 60_000,
    });

    await bridge.forwardToClaude('hello', ctx);

    expect(connector.addReaction).toHaveBeenCalledWith(ctx.messageId, 'ERROR');
  });

  /**
   * 验证什么：空闲看门狗超时 → run 终态为 idle_timeout → reaction 必须是 'Alarm'。
   * 缺失/错误会导致什么：超时的单子显示 Done（成功表情），与 spec「idle_timeout → 'Alarm'」冲突。
   * 依据：round-log spec（用户 2026-08-02 确认）。
   */
  it('test_anchor_idle_timeout_terminal_adds_alarm_reaction', async () => {
    vi.useFakeTimers();
    try {
      let resolveHang: () => void = () => {};
      const hangPromise = new Promise<void>((resolve) => {
        resolveHang = resolve;
      });
      const runner: Runner = {
        isRunning: false,
        stop: async () => {
          resolveHang();
        },
        killOrphan: () => {},
        registerExitHandlers: () => {},
        run: async function* () {
          await hangPromise;
        },
      };
      const connector = createStubConnector({ addReactionSpy: true });
      const sessionStore = new SessionStore();
      sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));
      const bridge = new Bridge({
        runner,
        agentRegistry: createStubAgentRegistry(runner),
        sessionReaderRegistry: createStubSessionReaderRegistry(),
        connector,
        sessionStore,
        config,
        idleTimeoutMs: 1000,
      });

      const promise = bridge.forwardToClaude('hello', ctx);
      // Cross the idle timeout so the watchdog fires → runner.stop() → idle_timeout terminal
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(connector.addReaction).toHaveBeenCalledWith(ctx.messageId, 'Alarm');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 验证什么：用户主动 /stop（interruptCurrentRun）→ run 终态为 interrupted → reaction 必须是 'SHHH'。
   * 缺失/错误会导致什么：用户叫停的单子显示 Done（成功表情），与 spec「interrupted → 'SHHH'」冲突。
   * 依据：round-log spec（用户 2026-08-02 确认）。
   */
  it('test_anchor_interrupted_terminal_adds_shhh_reaction', async () => {
    let resolveHang: () => void = () => {};
    const hangPromise = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    const runner: Runner = {
      isRunning: false,
      stop: async () => {
        resolveHang();
      },
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        await hangPromise;
      },
    };
    const connector = createStubConnector({ addReactionSpy: true });
    const sessionStore = new SessionStore();
    sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
      idleTimeoutMs: 60_000,
    });

    // Step 1 (createRunSession) is synchronous, so the active run is registered
    // before the first await; interrupting then releases the hanging generator.
    const promise = bridge.forwardToClaude('hello', ctx);
    await bridge.interruptCurrentRun({ userId: ctx.userId, chatId: ctx.chatId });
    await promise;

    expect(connector.addReaction).toHaveBeenCalledWith(ctx.messageId, 'SHHH');
  });

  /**
   * 验证什么：runner 正常完成（result success）→ done 终态 → reaction 保持 'Done'。
   * 缺失/错误会导致什么：映射改造后成功路径表情被误改，用户看不到绿勾。
   * 依据：round-log spec「done → 'Done'（保持现状）」，2026-08-02 用户确认（原 probe 转正）。
   */
  it('test_anchor_done_terminal_keeps_done_reaction', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        for (const e of events) yield e;
      },
    };
    const connector = createStubConnector({ addReactionSpy: true });
    const sessionStore = new SessionStore();
    sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
      idleTimeoutMs: 60_000,
    });

    await bridge.forwardToClaude('hello', ctx);

    expect(connector.addReaction).toHaveBeenCalledWith(ctx.messageId, 'Done');
  });

  /**
   * 验证什么：`!` bash 命令路径（executeBashInternal）不受终态映射改造影响，仍打 'Done'。
   * 缺失/错误会导致什么：bash 路径被误改成按 exitCode 区分表情，与用户确认的「bash 不管」冲突。
   * 依据：round-log spec「bash 命令保持 'Done' 不动」，2026-08-02 用户确认（原 probe 转正）。
   */
  it('test_anchor_bash_path_keeps_done_reaction', async () => {
    const connector = createStubConnector({ addReactionSpy: true });
    const sessionStore = new SessionStore();
    sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));
    const inlineRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {},
    };
    const bridge = new Bridge({
      runner: inlineRunner,
      agentRegistry: createStubAgentRegistry(inlineRunner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
      idleTimeoutMs: 60_000,
    });

    await bridge.executeBash('echo hello', ctx);

    expect(connector.addReaction).toHaveBeenCalledWith(ctx.messageId, 'Done');
  });

  /**
   * 验证什么：装配窗口把多条消息并成一个 turn 时，终态收尾（撤 Typing + 打终态
   *   表情）必须覆盖本轮每一条入站消息，而不只是 ctx.messageId（最后一条）。
   * 缺失/错误会导致什么：`src/index.ts` 对每条入站消息逐条挂 Typing，而
   *   ctx.messageId 只取最后一条、全仓唯一的 removeReactionByEmoji 调用点也只对
   *   它——先到的那几条永远停在「正在输入」，用户以为还有任务在跑。
   * 依据：clean_review §B8（提交时遍历本轮全部 messageId 收尾）。
   */
  it('test_anchor_terminal_reactions_cover_every_message_of_turn', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        for (const e of events) yield e;
      },
    };
    const connector = createStubConnector({ addReactionSpy: true, removeReactionSpy: true });
    const sessionStore = new SessionStore();
    sessionStore.setCwd(ctx.userId, fs.realpathSync(tmpDir));
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
      idleTimeoutMs: 60_000,
    });

    // 三条消息合成一个 turn：msg1、msg2 先到，msg3（= ctx.messageId）触发提交
    await bridge.forwardToClaude('hello', {
      ...ctx,
      messageId: 'msg3',
      turnMessageIds: ['msg1', 'msg2', 'msg3'],
    });

    for (const id of ['msg1', 'msg2', 'msg3']) {
      expect(connector.removeReactionByEmoji).toHaveBeenCalledWith(id, 'Typing');
      expect(connector.addReaction).toHaveBeenCalledWith(id, 'Done');
    }
  });
});
