/**
 * 真实飞书 API 集成测试 - config.save 切换 coding agent 发持久化消息
 *
 * 验收标准（2026-08-03 功能；2026-08-13 通知形式由纯文本改为卡片）：
 * 1. /config 卡片切换 defaultAgent 后点击保存：不再返回 toast，改为经
 *    bridge.sendResult 发送一条持久化的「切换通知卡片」（CardKit 2.0；新 agent
 *    有待恢复 session 时是 Resume 卡片，否则是含通知文案的提示卡）
 * 2. 真实飞书 API 必须成功投递该消息（sendWithRetry 返回 messageId），
 *    卡片文本含「已切换到」与目标 agent 显示名
 * 3. config.yaml 真实落盘 defaultAgent=目标
 * 4. 测试后恢复测试配置目录的 config.yaml 原内容
 *
 * 运行方式（真实飞书 API，默认不跑）：
 *   FEISHU_LIVE_TEST=1 bun run test tests/feishu-config-save-switch-live.test.ts
 *
 * 注意：使用 ~/.lark-remote-test 下的配置，避免干扰正常使用
 */

import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FeishuConnector } from '../../src/connector/index.js';
import { loadConfig } from '../../src/config/index.js';
import { SessionStore } from '../../src/session/index.js';
import { CommandRouter } from '../../src/router/index.js';
import type { Bridge } from '../../src/bridge/index.js';
import { createMockBridge, createMockSessionReaderRegistry } from '../../tests/lib/bridge-stubs.js';
import { lastNotice, DISPLAY } from '../../tests/lib/agent-switch-helpers.js';
import { TEST_CONFIG_DIR, configPath, skipIfNoConfig, describeLive } from './live-helpers.js';

// 使用独立的测试配置目录

let connector: FeishuConnector;
let testChatId: string;

/**
 * 真实投递桥：sendResult 走真实 connector，**分派语义与 Bridge.sendResult 对齐**
 * （card → {card}，markdown → {markdown}，text → {text}；成功 true / 失败 false），
 * 其余方法 stub。
 *
 * 必须支持 card：切换通知自 2026-08-13 起是卡片（不再是纯文本）。旧实现只认
 * `{text}`，拿到卡片会发出**空文本** → 真实 API 报错 → sendResult 返回 false →
 * config.save 按设计兜底 toast → 「成功路径不得返回 toast」断言假红（2026-09-11
 * 首次跑 live 套件时暴露；离线复现见 agent-switch anchor 的载荷断言）。
 */
function createLiveBridge(conn: FeishuConnector): Bridge {
  return createMockBridge({
    sendResult: vi.fn(
      async (
        result: { text?: string; markdown?: string; card?: object },
        ctx: { chatId: string; messageId: string },
      ) => {
        const payload = result.card
          ? { card: result.card }
          : result.markdown
            ? { markdown: result.markdown }
            : result.text
              ? { text: result.text }
              : null;
        if (!payload) return false;
        try {
          const messageId = await conn.sendWithRetry(ctx.chatId, payload, {
            replyTo: ctx.messageId,
          });
          return !!messageId;
        } catch (err) {
          console.error('[live] sendResult real delivery failed:', err);
          return false;
        }
      },
    ),
    updateCardInPlace: vi.fn().mockResolvedValue(undefined),
    forwardToClaude: vi.fn().mockResolvedValue(undefined),
    isBusy: false,
    isBusyFor: vi.fn().mockReturnValue(false),
    enqueue: vi.fn(),
    enqueueImmediate: vi.fn(),
    interruptCurrentRun: vi.fn().mockResolvedValue(false),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setConfig: vi.fn(),
    setIdleTimeout: vi.fn(),
    clearRunners: vi.fn(),
    removeFromQueue: vi.fn().mockReturnValue(false),
    getQueuedTasks: vi.fn().mockReturnValue([]),
    getQueuedTask: vi.fn().mockReturnValue(undefined),
    getQueueInfo: vi.fn().mockReturnValue({ position: 0, isRunning: false, tasksAhead: 0 }),
    getAllActiveRuns: vi.fn().mockReturnValue(new Map()),
    sendFile: vi.fn().mockResolvedValue(''),
    getActiveRunFor: vi.fn().mockReturnValue(undefined),
  });
}

describeLive('飞书 API 集成测试 - config.save 切换 coding agent 持久化消息', () => {
  let tmpDir: string;
  let originalConfig: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-live-config-save-'));
    if (skipIfNoConfig()) {
      return;
    }

    // 备份真实测试配置，测试后恢复（finally 保证）
    originalConfig = fs.readFileSync(configPath, 'utf-8');

    const config = loadConfig(configPath);
    connector = new FeishuConnector(config);
    await connector.connect();

    const startupContactPath = path.join(TEST_CONFIG_DIR, 'startup-contact.json');
    if (fs.existsSync(startupContactPath)) {
      const contact = JSON.parse(fs.readFileSync(startupContactPath, 'utf-8'));
      testChatId = contact.chatId;
    } else {
      console.log('⚠️ 跳过：没有有效的 chatId');
    }
  });

  afterEach(async () => {
    try {
      if (connector) {
        await connector.disconnect();
      }
    } finally {
      if (originalConfig !== undefined) {
        fs.writeFileSync(configPath, originalConfig, 'utf-8');
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('config.save 切换 defaultAgent 发送真实持久化消息（无 toast + 落盘）', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) {
      return; // Skip test
    }

    const config = loadConfig(configPath);
    const targetAgent = config.defaultAgent === 'pi' ? 'claude' : 'pi';
    const sessionStore = new SessionStore();
    const liveBridge = createLiveBridge(connector);
    const router = new CommandRouter({
      sessionStore,
      bridge: liveBridge,
      config,
      configPath,
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode', 'kimi'],
      }),
    });

    sessionStore.setCwd('live-user', tmpDir);

    // 真实载体消息：用它的 messageId 作 ctx.messageId（真实链路是配置卡片的 id）
    const carrierId = await connector.sendWithRetry(testChatId, {
      text: 'config.save 切换通知 live 验证（测试消息，可忽略）',
    });
    expect(carrierId).toBeTruthy();

    const ctx = { userId: 'live-user', chatId: testChatId, messageId: carrierId };

    // 模拟配置卡片：切换 defaultAgent → 保存
    await router.handleCardAction(
      { cmd: 'config.set', key: 'defaultAgent', option: targetAgent },
      ctx,
    );
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 成功路径不得返回 toast
    expect(response?.toast).toBeFalsy();

    // 真实投递：sendResult 必须被调用一次，载荷是切换通知**卡片**（2026-08-13 起
    // 由纯文本改为卡片），卡片文本含切换文案 + 目标 agent 显示名
    const sendResultMock = liveBridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(1);
    const sent = sendResultMock.mock.calls[0][0] as { text?: string; card?: unknown };
    expect(sent.card).toBeDefined();
    expect(sent.text).toBeUndefined();
    const notice = lastNotice(sendResultMock);
    expect(notice).toContain('已切换到');
    expect(notice).toContain(DISPLAY[targetAgent]);
    expect(notice).not.toContain('保存失败');

    // config.yaml 真实落盘
    const written = fs.readFileSync(configPath, 'utf-8');
    expect(written).toContain(`defaultAgent: ${targetAgent}`);
  }, 30000);
});
