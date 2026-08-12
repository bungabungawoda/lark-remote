/**
 * Adversarial TDD probe —— 回归锁定（A1/A5/A6，2026-08-02）
 *
 * 这三个行为当前实现已满足（写出来即绿），不是有效 RED anchor，因此作为
 * probe 锁定，防止未来改造破坏：A1 done 终态保持 'Done'、A5 bash 路径
 * 保持 'Done'、A6 未知终态兜底 'Done'。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner, AgentEvent } from '../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
} from '../lib/bridge-stubs.js';
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('reaction emoji regression locks (probe)', () => {
  let tmpDir: string;
  let config: AppConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-reaction-probe-'));
    config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * 验证什么：runner 正常完成（result success）→ done 终态 → reaction 保持 'Done'。
   * 缺失/错误会导致什么：映射改造后成功路径表情被误改，用户看不到绿勾。
   * 依据：round-log spec「done → 'Done'（保持现状）」，2026-08-02 用户确认。
   */
  it('test_probe_done_terminal_keeps_done_reaction', async () => {
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
   * 验证什么：`!` bash 命令路径（executeBashInternal）不受本次映射改造影响，仍打 'Done'。
   * 缺失/错误会导致什么：bash 路径被误改成按 exitCode 区分表情，与用户确认的「bash 不管」冲突。
   * 依据：round-log spec「bash 命令保持 'Done' 不动」，2026-08-02 用户确认。
   */
  it('test_probe_bash_path_keeps_done_reaction', async () => {
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
});
