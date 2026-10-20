/**
 * 飞书 API 集成测试 - 卡片元素总数上限（ErrCode 11310）
 *
 * 背景：仓库里原先只有「`/ws` 61 个顶层元素触发 11310」与「`/active` 84 个顶层
 * 元素不超限」两条互相矛盾的结论，且把 230025 记作「elements 过多」但从无实测。
 * 2026-10-19 在测试会话探测后确定：
 *
 * - 判据是**递归统计 `elements` 数组成员（不含 `columns`）≤ 99**：
 *   平铺 99 个 div 通过、100 个失败；单列内嵌 98 个 div（99）通过、99 个（100）失败；
 * - 整卡 JSON 对象数**不是**判据：`/ws` 分页卡 227 个对象能发出去，而平铺
 *   100 个 div 只有 205 个对象却失败；
 * - 另一个独立维度：单个 column_set 66 列（元素计数 67）通过、67 列（68）失败；
 * - 失败返回 `230099 / ErrCode: 11310 element exceeds the limit`，与 markdown
 *   table 超限同码不同因；**本次探测没有出现 230025**。
 *
 * 本文件把这些边界写成断言（防止文档/实现再次漂移），并锁定"渲染器产出的
 * 最坏 run 卡片一定能发出去"——工具行改成一行一个后，24 行带按钮的工具原本
 * 是 179 节点，真机直接 11310。
 *
 * 运行方式（真实飞书 API，默认不跑）：
 *   FEISHU_LIVE_TEST=1 bun run test:live
 *
 * 注意：使用 ~/.lark-remote-test 下的配置，避免干扰正常使用；本文件会向测试
 * 会话发多条卡片（消息标题写明探针编号，便于人工清理）。
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuConnector } from '../../src/connector/index.js';
import { loadConfig } from '../../src/config/index.js';
import { countCardElements, MAX_CARD_ELEMENTS } from '../../src/card/card-budget.js';
import { renderRunCard } from '../../src/card/run-renderer.js';
import type { RunState } from '../../src/card/run-state.js';
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

/** 一次发送观察结果。 */
interface ProbeResult {
  shape: string;
  topLevel: number;
  elements: number;
  ok: boolean;
  code?: string | number;
  msg?: string;
}

function div(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

/** 平铺 N 个 div（只测顶层维度）。 */
function flatCard(n: number): object[] {
  return Array.from({ length: n }, (_, i) => div(`flat-${i}`));
}

/** 一个 column_set、单列内嵌 n 个 div。 */
function oneColumnCard(n: number): object[] {
  return [
    {
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'grow',
          elements: Array.from({ length: n }, (_, i) => div(`nested-${i}`)),
        },
      ],
    },
  ];
}

/** 一个 column_set、n 列、每列 1 个 div。 */
function manyColumnsCard(n: number): object[] {
  return [
    {
      tag: 'column_set',
      columns: Array.from({ length: n }, (_, i) => ({
        tag: 'column',
        width: 'auto',
        elements: [div(`col-${i}`)],
      })),
    },
  ];
}

function wrap(elements: object[], title: string): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
    body: { elements },
  };
}

/**
 * 渲染器最坏形状：`tools` 个工具（含输出）+ `panels` 个思考面板，
 * 工具是与 thinking 一样的折叠面板（运行中/失败默认展开）。
 */
async function probeCard(shape: string, card: object, topLevel: number): Promise<ProbeResult> {
  const result: ProbeResult = {
    shape,
    topLevel,
    elements: countCardElements(card),
    ok: false,
  };
  try {
    await connector.sendWithRetry(testChatId, { card });
    result.ok = true;
  } catch (err) {
    const feishuError = (
      err as { cause?: { response?: { data?: { code?: number; msg?: string } } } }
    ).cause?.response?.data;
    result.code = feishuError?.code;
    result.msg = feishuError?.msg ?? (err as Error).message;
  }
  console.log(
    `[probe] ${result.ok ? '✅' : '❌'} ${shape} 顶层=${result.topLevel} 元素=${result.elements}` +
      (result.ok ? '' : ` code=${result.code} msg=${result.msg}`),
  );
  logCardMetrics(`${result.ok ? 'PASS' : 'FAIL'} ${shape}`, card);
  await new Promise((r) => setTimeout(r, 250));
  return result;
}

async function probe(shape: string, elements: object[]): Promise<ProbeResult> {
  return await probeCard(shape, wrap(elements, `探针 ${shape}`), elements.length);
}

describeLive('飞书 API 集成测试 - 卡片元素总数上限', () => {
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

  it('顶层平铺：99 个通过、100 个触发 11310（元素分界 99/100）', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) return;
    const ok = await probe('flat-99', flatCard(99));
    const fail = await probe('flat-100', flatCard(100));

    expect(ok.ok).toBe(true);
    expect(ok.elements).toBe(99);
    expect(fail.ok).toBe(false);
    expect(fail.elements).toBe(100);
    expect(String(fail.msg)).toContain('11310');
    // 失败是"元素数超限"，不是结构错误：200621 才是结构问题。
    expect(String(fail.msg)).not.toContain('200621');
  }, 60_000);

  it('内嵌与列：元素计数判据（99 通过 / 100 失败）', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) return;
    const nestedOk = await probe('one-column-98', oneColumnCard(98));
    const nestedFail = await probe('one-column-99', oneColumnCard(99));
    const colsOk = await probe('cols-66', manyColumnsCard(66));
    const colsFail = await probe('cols-67', manyColumnsCard(67));

    // 元素计数：内嵌 98 个 div + 1 个 column_set = 99 通过；99 个 = 100 失败。
    expect(nestedOk.ok).toBe(true);
    expect(nestedOk.elements).toBe(99);
    expect(nestedFail.ok).toBe(false);
    expect(nestedFail.elements).toBe(100);
    // 列是独立维度：66 列通过、67 列失败（元素计数只差 1，单靠它分不开，
    // 所以这里只锁结果，不锁计数）。
    expect(colsOk.ok).toBe(true);
    expect(colsFail.ok).toBe(false);
  }, 60_000);

  it('渲染器最坏 run 卡片：元素数在预算内且发送成功', async () => {
    if (skipIfNoConfig() || !connector || !testChatId) return;
    // 24 个工具（8 行带按钮 + 16 行纯标题）+ 12 个思考面板 + 4 个展开正文，
    // 以及 24 个工具全部展开的极端情形。
    // 工具面板带截断后的长输出；24 个工具 + 12 个思考面板是渲染上限附近的形状。
    const cases: Array<{ name: string; state: RunState }> = [
      { name: 'runcard-24tools-12panels', state: heavyRunState({ tools: 24, panels: 12 }) },
      {
        name: 'runcard-24tools-errors',
        state: heavyRunState({ tools: 24, panels: 0, errorTools: 4 }),
      },
    ];

    for (const item of cases) {
      const card = renderRunCard(item.state, { agentKind: 'dsh', compactSupported: false });
      const topLevel = (card as { body?: { elements?: object[] } }).body?.elements?.length ?? 0;
      const result = await probeCard(item.name, card, topLevel);
      expect(result.elements).toBeLessThanOrEqual(MAX_CARD_ELEMENTS);
      expect(result.ok).toBe(true);
    }
  }, 60_000);
});
