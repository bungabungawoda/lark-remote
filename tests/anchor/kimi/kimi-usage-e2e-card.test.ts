/**
 * Anchor: 真实 reader → 真实 registry → 真实 Bridge → 真实卡片渲染的全链路契约锁。
 * kimi 终态卡片必须显示真实 KimiSessionReader 从 wire.jsonl 聚合出的 session 级 usage。
 *
 * 验证什么（target）:
 *   前两轮修复各自只锁了半链路：
 *     - R1（kimi-session-usage-aggregation）用真实 KimiSessionReader + tmp fixture，
 *       但没接 Bridge——reader 输出字段名变了它照样过；
 *     - R2（bridge-kimi-usage-threading）接了 Bridge，但 reader 是 stub——
 *       bridge 读错字段（或 registry 没注册上）它照样过。
 *   本条把完整生产链路串起来：真实 KimiSessionReader（真 tmp wire.jsonl fixture）→
 *   真实 SessionReaderRegistry → 真实 Bridge.resolveFinalUsage → 真实 formatUsageStats
 *   渲染出的终态卡片。reader 输出与 bridge 消费之间的任何字段/协议错配都会在此暴露。
 *
 * 缺失导致什么（importance）:
 *   若链路断开（reader 改字段名 / bridge 窄化透传 / registry 未命中），终态卡片退回
 *   formatUsageStats 的估算路径（src/router/index.ts:3900-3919）：inputRef=contextLength，
 *   Output = contextLength×10%——缓存重复计、输出靠猜，误导用户对成本与上下文占用的判断。
 *   本 fixture 数值下两路径产物完全不同（见下方验算），可严格区分。
 *
 * 依据 spec（spec_basis）:
 *   spec 要求 jsonl 作为数据源、对齐 ccusage 范式，usage = 「整个 session 整体的 token
 *   使用量和上下文」——终态卡片必须展示从 wire.jsonl 全量聚合的真实 usage。
 *
 * 数值验算（3 条 usage.record：{1000,100,5000,200} {2000,200,6000,300} {3000,300,7000,400}）:
 *   聚合: input=6000 output=600 cacheRead=18000 cacheCreate=900 total=25500 contextLength=10300
 *   formatTokenK = n>=1000 ? Math.round(n/1000)+'K' : String(n)（src/router/index.ts:3818-3824）
 *   真实路径（src/router/index.ts:3878-3899）应产出:
 *     Context - 10K           (10300→10K)
 *     Input token - 6K        (6000→6K)
 *     Output token - 600      (600<1000→原值)
 *     Cache create - 900      (900<1000→原值)
 *     Cached token - 18K (75%) (18000→18K; cache% = 18000/(6000+18000) = 75%)
 *     Total token - 26K       (max(25500, 6000+600+18000+900=25500)→Math.round(25.5)=26K)
 *   估算路径（若链路断开，src/router/index.ts:3900-3919）会产出:
 *     inputRef = contextLength = 10300; totalInput = 10300+18000 = 28300 → Input token - 28K
 *     outputEst = Math.round(10300×0.1) = 1030 → Output token - 1K   ← 估算路径标志行
 *     total = 28300+1030+900 = 30230 → Total token - 30K
 *   反估算断言: 不包含 'Output token - 1K'（该行只在估算路径出现；真实 output=600 → '600'）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { KimiSessionReader } from '../../../src/session/kimi/sessions.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentRunner, Runner } from '../../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
  createStubRunner,
} from '../../lib/bridge-stubs.js';
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
/** Wrap a stub Runner with AgentRunner fields。 */
function asKimiRunner(r: Runner): AgentRunner {
  return {
    ...r,
    kind: 'kimi',
    // 故意给一个永不命中的 runner 内建 reader——bridge 必须走 registry 里的真实 reader，
    // 而不是 runner 自带的；若 bridge 错用此 reader，usage 全缺、断言必 fail。
    sessionReader: {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    },
    getStatusInfo: () => ({ kind: 'kimi', model: 'kimi-test' }),
  };
}

const SESSION_ID = 'session_e2e_x';

describe('kimi done card shows session-wide real usage end-to-end (anchor)', () => {
  let kimiDir: string;
  let workDir: string;
  let config: AppConfig;

  beforeEach(() => {
    kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-e2e-card-kimi-'));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-e2e-card-cwd-'));

    // --- 真实 kimi 会话 fixture（同 kimi-session-usage-aggregation 构造风格） ---
    const sessionDir = path.join(kimiDir, SESSION_ID);
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });

    // reader 校验 state.workDir === fs.realpathSync(cwd)（src/session/kimi/sessions.ts:234）
    const realWorkDir = fs.realpathSync(workDir);

    fs.writeFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: SESSION_ID, sessionDir, workDir: realWorkDir }) + '\n',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T01:00:00.000Z',
        title: 't',
        isCustomTitle: false,
        workDir: realWorkDir,
      }),
    );
    // 3 条 usage.record，数值特意可区分"整体求和"与"只取末条"：
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

    config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
      defaultAgent: 'kimi',
      output: {
        showThinking: true,
        showToolUse: false,
        showToolResult: false,
      },
    });
  });

  afterEach(() => {
    fs.rmSync(kimiDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

  it('test_anchor_kimi_done_card_shows_session_wide_real_usage_end_to_end', async () => {
    // 真实依赖链：真实 KimiSessionReader（读上面的 tmp fixture）+ 真实 registry。
    // 不 stub reader——本测试的核心就是锁住 reader 输出与 bridge 消费之间的协议。
    const registry = new SessionReaderRegistry();
    registry.register('kimi', new KimiSessionReader(kimiDir));

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const kimiRunner = asKimiRunner(
      createStubRunner({
        mode: 'streaming',
        events: [
          {
            type: 'system',
            subtype: 'init',
            session_id: SESSION_ID,
            cwd: workDir,
            model: 'kimi-code/k3',
          },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'kimi reply' }] } },
          { type: 'result', subtype: 'success', session_id: SESSION_ID },
        ],
      }),
    );
    const bridge = new Bridge({
      // kimi 实时事件流：system.init → assistant 文本 → result(success, 无 usage)。
      // session_id 必须等于 fixture sessionId，cwd 必须等于 fixture workDir（realpath 后）。
      runner: kimiRunner,
      agentRegistry: createStubAgentRegistry(kimiRunner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
      sessionReaderRegistry: registry,
    });
    sessionStore.setCwd(ctx.userId, workDir);

    await bridge.forwardToClaude('hello', ctx);

    // 终态卡片 = stub connector 收到的最后一次 card update（streaming 成功路径）。
    const finalCard = JSON.stringify(connector._cards.at(-1));

    // 真实聚合值（Σ 3 条 record）必须出现在终态卡片 usage 文本行：
    expect(finalCard).toContain('Input token - 6K'); // ΣinputOther=6000→6K（末条覆盖式则 3K，估算则 28K）
    expect(finalCard).toContain('Output token - 600'); // Σoutput=600（末条覆盖式则 300）
    expect(finalCard).toContain('Cache create - 900'); // ΣinputCacheCreation=900
    expect(finalCard).toContain('Cached token - 18K (75%)'); // ΣcacheRead=18000; 18000/(6000+18000)=75%
    expect(finalCard).toContain('Total token - 26K'); // max(25500, 四项和25500)=25500→26K
    expect(finalCard).toContain('Context - 10K'); // 末条 (3000+300+7000)=10300→10K

    // 反估算断言：估算路径（input/output 缺失时）outputEst=Math.round(10300×0.1)=1030→1K。
    // 验算依据 src/router/index.ts:3904-3912 + formatTokenK(1030)='1K'（3818-3824）。
    // 该行出现即说明 finish meta 丢了 inputTokens/outputTokens，链路断开。
    expect(finalCard).not.toContain('Output token - 1K');
  });
});
