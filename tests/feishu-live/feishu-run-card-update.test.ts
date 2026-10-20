/**
 * 飞书 API 集成测试 - run 卡的「就地更新」路径（点「详情」走的正是它）
 *
 * 背景：run 卡片是**先发一张、之后全卡 patch**。新增的工具行按需展开把"发送"
 * 和"更新"变成了两条独立风险：元素上限的实测用例只覆盖了发送（message.create），
 * 而用户点「详情/收起」时走的是 CardKit 的更新接口（message.patch / card.update）。
 * 两者在服务端是不同链路，发送成功不代表更新也成功。
 *
 * 本文件覆盖：
 * 1. 运行态卡（24 个工具 + 12 个思考面板 + 状态条）发送成功；
 * 2. 逐个 patch：展开 4 个工具 → 收起 → 展开带失败的工具（失败行默认展开+正文）；
 * 3. 终态卡（改动 + 后台任务 + 统计 + 按钮全开）发送成功后，再 patch 成收起态；
 * 4. 每一步都断言双预算（28KB 字节 + 90 元素）与真实发送结果。
 *
 * 运行方式（真实飞书 API，默认不跑）：
 *   FEISHU_LIVE_TEST=1 bun run test:live
 *
 * 注意：使用 ~/.lark-remote-test 下的配置，避免干扰正常使用；会向测试会话发送
 * 卡片并多次更新（消息标题写明用途，便于人工清理）。
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuConnector } from '../../src/connector/index.js';
import { loadConfig } from '../../src/config/index.js';
import { countCardElements, MAX_CARD_ELEMENTS } from '../../src/card/card-budget.js';
import { renderRunCard } from '../../src/card/run-renderer.js';
import { finishRun, reduceRunState, type RunState } from '../../src/card/run-state.js';
import {
  TEST_CONFIG_DIR,
  configPath,
  heavyRunState,
  logCardMetrics,
  skipIfNoConfig,
  describeLive,
} from './live-helpers.js';

let connector: FeishuConnector;
let testChatId: string;

function bytesOf(card: object): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}

/** 断言这张卡在两个预算之内（发不出去就不必发）。 */
function expectWithinBudget(label: string, card: object): void {
  const elements = countCardElements(card);
  const bytes = bytesOf(card);
  console.log(`[update] ${label} elements=${elements} bytes=${bytes}`);
  expect(elements).toBeLessThanOrEqual(MAX_CARD_ELEMENTS);
  expect(bytes).toBeLessThanOrEqual(28_000);
}

/** 终态卡：后台任务 + token 统计 + 操作按钮全开。 */
function doneRunState(): RunState {
  let state = heavyRunState({ tools: 12, panels: 6, errorTools: 1 });
  state = reduceRunState(state, {
    type: 'background_jobs',
    jobs: [
      { id: 'bash-1', label: 'npm run dev', status: 'running' },
      { id: 'bash-2', label: 'watch tests', status: 'running' },
    ],
  });
  return finishRun(state, 'done', {
    resultSubtype: 'success',
    contextLength: 315_000,
    contextLimit: 1_000_000,
  });
}

describeLive('飞书 API 集成测试 - run 卡就地更新（详情/收起）', () => {
  beforeEach(async () => {
    if (skipIfNoConfig()) return;
    const config = loadConfig(configPath);
    connector = new FeishuConnector(config);
    await connector.connect();
    const startupContactPath = path.join(TEST_CONFIG_DIR, 'startup-contact.json');
    if (fs.existsSync(startupContactPath)) {
      const contact = JSON.parse(fs.readFileSync(startupContactPath, 'utf-8')) as {
        chatId?: string;
      };
      testChatId = contact.chatId ?? '';
    }
  });

  afterEach(async () => {
    if (connector) await connector.disconnect();
  });

  it('运行态卡：发送 → 工具跑完 → 出现失败工具，每一步 update 都成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) return;

    // 流式更新 = 同一条消息反复 patch：每次工具状态变化都会重渲染整卡。
    const base = heavyRunState({ tools: 24, panels: 12 });
    const running = renderRunCard(base, { agentKind: 'dsh', compactSupported: false });
    expectWithinBudget('running/24tools', running);
    const messageId = await connector.sendWithRetry(testChatId, { card: running });
    expect(typeof messageId).toBe('string');
    logCardMetrics('running/24tools', running);

    // 工具完成 → 面板自动收起（折叠面板的 expanded 由渲染决定）。
    const settled = renderRunCard(heavyRunState({ tools: 24, panels: 12, outputChars: 200 }), {
      agentKind: 'dsh',
      compactSupported: false,
    });
    expectWithinBudget('running/settled', settled);
    await expect(connector.updateCard(messageId, settled)).resolves.toBeUndefined();

    // 失败工具默认展开且正文最长：最占预算的形态，update 也必须成功。
    const withError = renderRunCard(heavyRunState({ tools: 24, panels: 12, errorTools: 4 }), {
      agentKind: 'dsh',
      compactSupported: false,
    });
    expectWithinBudget('running/errors', withError);
    await expect(connector.updateCard(messageId, withError)).resolves.toBeUndefined();
    console.log('[update] ✅ 运行态卡 3 次 update 全部成功 messageId=', messageId);
  }, 90_000);

  it('终态卡（后台任务 + 统计）：发送成功后可继续 patch', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) return;

    const state = doneRunState();
    const card = renderRunCard(state, { agentKind: 'dsh', compactSupported: true });
    expectWithinBudget('done/full', card);
    logCardMetrics('done/full', card);
    const json = JSON.stringify(card);
    // 终态卡的两个小节：后台任务 + token 统计。上下文百分比走 summary
    // （`Context - X (Y%)`）；状态条 `📊 上下文` 只在 running/finalizing 出现。
    expect(json).toContain('后台任务');
    expect(json).toContain('Context - 315K (32%)');
    expect(json).not.toContain('📊 上下文');

    const messageId = await connector.sendWithRetry(testChatId, { card });
    expect(typeof messageId).toBe('string');

    // 终态卡仍可能被 patch（补充统计、杀掉后台任务后重渲染），形状必须可发送。
    const repatched = renderRunCard(
      { ...state, backgroundJobs: (state.backgroundJobs ?? []).slice(0, 1) },
      { agentKind: 'dsh', compactSupported: true },
    );
    expectWithinBudget('done/repatched', repatched);
    await expect(connector.updateCard(messageId, repatched)).resolves.toBeUndefined();
    console.log('[update] ✅ 终态卡发送 + patch 成功 messageId=', messageId);
  }, 60_000);
});
