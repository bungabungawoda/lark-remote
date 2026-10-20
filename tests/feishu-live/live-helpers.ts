/**
 * Shared live-test guards for the FEISHU_LIVE_TEST integration suites.
 *
 * All 7 tests/feishu-live suites previously duplicated TEST_CONFIG_DIR /
 * configPath / skipIfNoConfig / describeLive. This module is the single
 * definition; it is not a *.test.ts so vitest never collects it.
 *
 * Live suites only run with FEISHU_LIVE_TEST=1 and use ~/.lark-remote-test
 * so they never touch the real user config.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { createInitialRunState, reduceRunState, type RunState } from '../../src/card/run-state.js';

/** Independent test config directory, isolated from the real one. */
export const TEST_CONFIG_DIR = path.join(os.homedir(), '.lark-remote-test');
export const configPath = path.join(TEST_CONFIG_DIR, 'config.yaml');

/**
 * Returns true (and logs why) when the live config is unavailable or lacks
 * Feishu credentials, so the caller can skip its before-each.
 */
export function skipIfNoConfig(): boolean {
  if (!fs.existsSync(configPath)) {
    console.log(`⚠️ 跳过：配置不存在 ${configPath}`);
    return true;
  }
  try {
    const cfg = loadConfig(configPath);
    if (!cfg.feishu?.appId || !cfg.feishu?.appSecret) {
      console.log('⚠️ 跳过：配置中缺少飞书凭据');
      return true;
    }
    return false;
  } catch (err) {
    console.log(`⚠️ 跳过：配置加载失败 ${err}`);
    return true;
  }
}

/** describe that only runs live suites when FEISHU_LIVE_TEST=1. */
export const describeLive = process.env.FEISHU_LIVE_TEST ? describe : describe.skip;

/**
 * 卡片元素计数的四个候选口径（用于拟合飞书 11310 的真实判据）。
 *
 * 真实边界用单一"节点数"解释不了：`/ws` 分页卡 227 个 JSON 对象能发出去，
 * 而平铺 100 个 div（205 对象）失败。把四个口径一起打出来，才能对着实测的
 * 成功/失败点找到真正分离它们的那个量。
 */
export interface CardMetricVector {
  /** body.elements 的顶层成员数。 */
  top: number;
  /** 递归统计 `elements` 数组成员（不含 `columns`）。 */
  elementsOnly: number;
  /** 递归统计 `elements` + `columns` 成员。 */
  elemsPlusCols: number;
  /** 整卡 JSON 对象总数（数组不计数）。 */
  objects: number;
  /** 最大的单个容器子元素数（`elements` 或 `columns` 任一）。 */
  maxChildren: number;
}

export function cardMetrics(card: object): CardMetricVector {
  const counts = { elementsOnly: 0, elemsPlusCols: 0, objects: 0, maxChildren: 0 };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    counts.objects += 1;
    const rec = value as { elements?: unknown; columns?: unknown };
    if (Array.isArray(rec.elements)) {
      counts.maxChildren = Math.max(counts.maxChildren, rec.elements.length);
      for (const child of rec.elements) {
        counts.elementsOnly += 1;
        counts.elemsPlusCols += 1;
        walk(child);
      }
    }
    if (Array.isArray(rec.columns)) {
      counts.maxChildren = Math.max(counts.maxChildren, rec.columns.length);
      for (const child of rec.columns) {
        counts.elemsPlusCols += 1;
        walk(child);
      }
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'elements' || key === 'columns') continue;
      walk(v);
    }
  };
  walk(card);
  return {
    top: (card as { body?: { elements?: unknown[] } }).body?.elements?.length ?? 0,
    ...counts,
  };
}

/** 一行式打印计数向量（真实发送的成功/失败与它对照即可拟合判据）。 */
export function logCardMetrics(label: string, card: object): void {
  const m = cardMetrics(card);
  console.log(
    `[metrics] ${label} top=${m.top} elementsOnly=${m.elementsOnly} elemsPlusCols=${m.elemsPlusCols} objects=${m.objects} maxChildren=${m.maxChildren}`,
  );
}

/**
 * 构造"渲染器最坏形状"的运行态：`tools` 个工具（含长输出）+ `panels` 个思考面板。
 *
 * 放在 live-helpers 里是因为两个 live 用例都要它：元素上限用例验证"能发出去"，
 * 更新用例验证"运行中的 patch 也能发出去"。
 */
export function heavyRunState(opts: {
  tools: number;
  panels: number;
  /** 给前 `errorTools` 个工具标成失败（失败面板默认展开，正文最长）。 */
  errorTools?: number;
  /** 每个工具的输出长度（默认 2000，超过单工具预算，必然被截断）。 */
  outputChars?: number;
}): RunState {
  let state = createInitialRunState('run-heavy');
  state = { ...state, sessionId: 'sess-heavy' };
  for (let i = 0; i < opts.panels; i++) {
    state = reduceRunState(state, {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: `思考 ${i}`, itemId: `t${i}` }] },
    });
  }
  for (let i = 0; i < opts.tools; i++) {
    state = reduceRunState(state, {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: `call-${i}`, name: 'bash', input: { command: `cmd-${i}` } },
        ],
      },
    });
    state = reduceRunState(state, {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: `call-${i}`,
            content: `out-${i} ` + 'x'.repeat(opts.outputChars ?? 2000),
            is_error: i < (opts.errorTools ?? 0),
          },
        ],
      },
    });
  }
  return state;
}
