/**
 * Anchor Test: usage 聚合必须与 maxEvents 展示切片无关
 *
 * Bug: 当前实现（src/session/kimi/sessions.ts readSessionContent，约 246-249 行）
 * 先 `lines.slice(-maxEvents)` 再逐行解析并聚合 usage.record。
 * maxEvents 的本意只是限制返回给调用方的 events 展示条数（router 的
 * readSessionDisplayState，src/router/index.ts:1965 用它做 /resume 分页展示），
 * 但切片同时切掉了靠前的 usage.record —— 聚合总和随 maxEvents 变小而缩水：
 * 真实的 wire.jsonl 中 usage.record 分散在大量 content.part 等噪音事件之间，
 * 尾部 5 行内往往一条 record 都没有，usage 直接全 0。
 *
 * 重要性：/resume 等分页卡片上的 usage 是用户判断会话成本与上下文占用的依据；
 * 同一个 session，只因为分页条数不同就显示不同的 usage（甚至 0），是对用户的
 * 直接误导，且随会话变长必然触发（record 被噪音行稀释）。
 *
 * Spec 依据（usage = 「整个 session 整体的 token 使用量」）：
 *   - inputTokens = Σ 全文件所有 usage.record 的 inputOther = 6000
 *   - outputTokens = Σ 所有 output = 600
 *   - cacheReadTokens = Σ 所有 inputCacheRead = 18000
 *   - cacheCreationTokens = Σ 所有 inputCacheCreation = 900
 *   - totalTokens = Σ 四项全加 = 25500
 *   - contextLength = 最后一条 usage.record 的 (inputOther+output+inputCacheRead) = 10300
 *   聚合必须扫整个 wire.jsonl，与 events 展示切片无关。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KimiSessionReader } from '../../../src/session/kimi/sessions.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

describe('KimiSessionReader usage aggregation independent of maxEvents slice', () => {
  let kimiDir: string;
  let cwd: string;
  let sessionDir: string;
  let reader: KimiSessionReader;

  beforeEach(() => {
    kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-maxevents-kimi-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-maxevents-cwd-'));
    sessionDir = path.join(kimiDir, 'session_x');
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });

    // reader 校验 state.workDir === fs.realpathSync(cwd)
    const realCwd = fs.realpathSync(cwd);

    fs.writeFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_x', sessionDir, workDir: realCwd }) + '\n',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T01:00:00.000Z',
        title: 't',
        isCustomTitle: false,
        workDir: realCwd,
      }),
    );
    reader = new KimiSessionReader(kimiDir);
  });

  afterEach(() => {
    fs.rmSync(kimiDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test_anchor_kimi_usage_aggregation_is_independent_of_maxevents_slice', () => {
    const records = [
      { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
      { inputOther: 2000, output: 200, inputCacheRead: 6000, inputCacheCreation: 300 },
      { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
    ];
    // 每条 usage.record 之间插入 8 行 content.part 噪音（真实 wire.jsonl 形态），
    // 让 3 条 record 全部落在尾部 5 行切片之外 → 现实现聚合结果全 0。
    const wireLines: string[] = [];
    records.forEach((usage, i) => {
      wireLines.push(
        JSON.stringify({
          type: 'usage.record',
          model: 'kimi-code/k3',
          usage,
          usageScope: 'turn',
          time: 1784380436258 + i,
        }),
      );
      for (let j = 0; j < 8; j++) {
        wireLines.push(
          JSON.stringify({
            type: 'context.append_loop_event',
            event: { type: 'content.part', part: { type: 'text', text: `noise-${i}-${j}` } },
            time: 1784380436258 + i * 100 + j,
          }),
        );
      }
    });
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      wireLines.join('\n') + '\n',
    );

    const content = reader.readSessionContent('session_x', cwd, { maxEvents: 5 });

    // maxEvents 的原有职责：限制返回的 events 展示条数 —— 锁定，不许回归。
    expect(content.events.length).toBeLessThanOrEqual(5);

    const usage = content.usage;
    expect(usage, 'readSessionContent 应返回 usage').toBeDefined();

    // Spec: usage = 整个 session 整体的 token 使用量，
    // 必须与展示切片无关 —— 3 条 record 全在尾部 5 行之外，现实现会聚合出 0。
    expect(usage!.inputTokens).toBe(6000);
    expect(usage!.outputTokens).toBe(600);
    expect(usage!.cacheReadTokens).toBe(18000);
    expect(usage!.cacheCreationTokens).toBe(900);
    expect(usage!.totalTokens).toBe(25500);
    expect(usage!.contextLength).toBe(10400); // 末条 3000+7000+400（excludes output，review P2-8）
  });
});
