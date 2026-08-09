/**
 * Probe: KimiSessionReader 聚合遇残缺 usage.record 不应被 NaN 污染
 *
 * 攻击点（T2 嫌疑）：src/session/kimi/sessions.ts readSessionContent 的 usage.record
 * 分支逐项做 `totalUsage.inputTokens += u.inputOther`。若某条 record 缺字段
 * （如 inputCacheCreation 缺失），`number + undefined = NaN`，且 NaN 会沿累加器
 * 传播到之后所有 record——最终整张卡片的 usage 全部显示 NaN。
 * 旧覆盖式实现遇残缺只是该字段 undefined，不会污染全局；这是 R1 聚合引入的
 * 真实鲁棒性回退。
 *
 * 假设来源 = 健壮性需求（spec 未明说残缺字段如何处理）：
 *   残缺行的缺失字段按 0 计，已有字段仍正常计入。
 *   依据：kimi 协议在演进（usageScope 等字段就是后加的），旧版本/手改/截断的
 *   wire.jsonl 缺字段是现实风险；readJsonlLines 对末行残缺本就有容错，
 *   聚合层不应比解析层更脆弱。
 *
 * fixture 数值设计（3 条 usage.record，中间一条缺 inputCacheCreation）：
 *   r1: {inputOther:1000, output:100, inputCacheRead:5000, inputCacheCreation:200} → 四项和 6300
 *   r2: {inputOther:2000, output:200, inputCacheRead:6000}                        → 三项和 8200
 *   r3: {inputOther:3000, output:300, inputCacheRead:7000, inputCacheCreation:400} → 四项和 10700
 * 期望（缺失按 0 计）：
 *   inputTokens 6000 / outputTokens 600 / cacheReadTokens 18000
 *   cacheCreationTokens 600 (200+0+400) / totalTokens 25200 (6300+8200+10700)
 *   contextLength 10400（末条 3000+7000+400，excludes output，不求和）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KimiSessionReader } from '../../src/session/kimi/sessions.js';
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

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

describe('KimiSessionReader usage aggregation with malformed record (missing field)', () => {
  let kimiDir: string;
  let cwd: string;
  let sessionDir: string;
  let reader: KimiSessionReader;

  beforeEach(() => {
    kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-malformed-kimi-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-malformed-cwd-'));
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

  it('test_probe_kimi_usage_malformed_record_does_not_poison_aggregates', () => {
    const records = [
      { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
      // 残缺行：缺 inputCacheCreation（旧协议版本/截断行的现实形态）
      { inputOther: 2000, output: 200, inputCacheRead: 6000 },
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

    // 核心反 NaN 断言放最前：任何字段为 NaN/Infinity 即说明残缺行污染了累加器
    const fields = {
      inputTokens: usage!.inputTokens,
      outputTokens: usage!.outputTokens,
      cacheReadTokens: usage!.cacheReadTokens,
      cacheCreationTokens: usage!.cacheCreationTokens,
      totalTokens: usage!.totalTokens,
      contextLength: usage!.contextLength,
    };
    for (const [name, value] of Object.entries(fields)) {
      expect(
        Number.isFinite(value),
        `usage.${name} 应为有限数，实际为 ${String(value)}（残缺 usage.record 的缺失字段污染了聚合，产生 NaN）`,
      ).toBe(true);
    }

    // 健壮性假设：缺失字段按 0 计，已有字段仍计入
    expect(usage!.inputTokens).toBe(6000); // 1000+2000+3000
    expect(usage!.outputTokens).toBe(600); // 100+200+300
    expect(usage!.cacheReadTokens).toBe(18000); // 5000+6000+7000
    expect(usage!.cacheCreationTokens).toBe(600); // 200+0(缺失)+400
    expect(usage!.totalTokens).toBe(25200); // 6300+8200+10700
    expect(usage!.contextLength).toBe(10400); // 末条 3000+7000+400（excludes output，review P2-8）
  });
});
