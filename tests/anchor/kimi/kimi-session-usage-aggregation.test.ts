/**
 * Anchor Test: KimiSessionReader.readSessionContent usage 应 session 级整体聚合
 *
 * Bug: 当前实现（src/session/kimi/sessions.ts readSessionContent 内 usage.record 分支）
 * 对每条 usage.record 事件做覆盖式赋值（totalUsage = {...}），只保留最后一条 record 的数值。
 * kimi 的 wire.jsonl 是按每次 LLM 调用逐条写 usage.record 的，多步 run 的 token
 * 使用量会被严重低估（只统计了最后一步）。
 *
 * 重要性：卡片上展示的 usage 是用户判断会话成本/上下文占用的依据；
 * 低估 input/output/cache token 会误导用户对用量与计费的判断。
 *
 * Spec 依据（对齐 ccusage 范式——整个 session 整体聚合）：
 *   - inputTokens = Σ 所有 usage.record 的 inputOther
 *   - outputTokens = Σ 所有 output
 *   - cacheReadTokens = Σ 所有 inputCacheRead
 *   - cacheCreationTokens = Σ 所有 inputCacheCreation
 *   - totalTokens = Σ (inputOther+output+inputCacheRead+inputCacheCreation)（四项全加）
 *   - contextLength = 最后一条 usage.record 的 (inputOther + output + inputCacheRead)
 *     （session 当前整体上下文占用，不可求和——现行为已正确，此处一并断言锁定语义）
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

describe('KimiSessionReader usage session-wide aggregation', () => {
  let kimiDir: string;
  let cwd: string;
  let sessionDir: string;
  let reader: KimiSessionReader;

  beforeEach(() => {
    kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-agg-kimi-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-agg-cwd-'));
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

  it('test_anchor_kimi_usage_aggregates_all_usage_records_session_wide', () => {
    // 3 条 usage.record，数值特意设计为可区分"整体求和"与"只取末条"：
    //   末条 inputOther=3000 ≠ Σ=6000；末条 output=300 ≠ Σ=600；以此类推。
    const records = [
      { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
      { inputOther: 2000, output: 200, inputCacheRead: 6000, inputCacheCreation: 300 },
      { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
    ];
    const wireLines = records.map((usage, i) =>
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/k3',
        usage,
        usageScope: 'turn',
        time: 1784380436258 + i,
      }),
    );
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      wireLines.join('\n') + '\n',
    );

    const content = reader.readSessionContent('session_x', cwd);
    const usage = content.usage;

    expect(usage, 'readSessionContent 应返回 usage').toBeDefined();

    // Spec: inputTokens = Σ 所有 usage.record 的 inputOther = 1000+2000+3000
    expect(usage!.inputTokens).toBe(6000);
    // Spec: outputTokens = Σ 所有 output = 100+200+300
    expect(usage!.outputTokens).toBe(600);
    // Spec: cacheReadTokens = Σ 所有 inputCacheRead = 5000+6000+7000
    expect(usage!.cacheReadTokens).toBe(18000);
    // Spec: cacheCreationTokens = Σ 所有 inputCacheCreation = 200+300+400
    expect(usage!.cacheCreationTokens).toBe(900);
    // Spec: totalTokens = Σ 四项全加 = 6000+600+18000+900
    expect(usage!.totalTokens).toBe(25500);
    // Spec: contextLength = 最后一条 usage.record 的 (inputOther+inputCacheRead+inputCacheCreation)
    //       = 3000+7000+400（当前上下文占用，excludes output；不可求和；锁定语义。review P2-8）
    expect(usage!.contextLength).toBe(10400);
    // Cumulative field mirrors session-wide totals (kimi sums all records).
    expect(usage!.cumulativeInputTokens).toBe(6000);
    expect(usage!.cumulativeOutputTokens).toBe(600);
  });
});
