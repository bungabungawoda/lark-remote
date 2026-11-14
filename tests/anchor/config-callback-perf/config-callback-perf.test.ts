import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStubConnector } from '../../lib/bridge-stubs.js';
import { createRouterFixture } from '../../lib/router-fixture.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import {
  CONFIG_CALLBACK_BUDGET_MS,
  CONFIG_RENDER_DEBOUNCE_MS,
  CONFIG_SWITCH_NOTICE_BUDGET_MS,
} from '../../../src/router/actions/shared.js';
import { countCardComponents, MAX_CARD_COMPONENTS } from '../../../src/card/card-budget.js';
import { buildConfigCardFromTabs } from '../../../src/router/config/common/render.js';
import type { ConfigTab } from '../../../src/router/config/common/render.js';
import * as probeModule from '../../../src/runner/probe.js';
import * as configActions from '../../../src/router/actions/config-actions.js';
import { getConfigBuilder } from '../../../src/router/config/index.js';

const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'config-perf-anchor-'));
afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg-1' };

function makeFixture(tmpName: string) {
  const tmpDir = path.join(tmpBase, tmpName);
  mkdirSync(tmpDir, { recursive: true });
  const connector = createStubConnector();
  const config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
  });
  const { router, sessionStore, bridge } = createRouterFixture({
    tmpDir,
    connector,
    config,
    routerOpts: {
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
    },
  });
  sessionStore.setCwd('user1', tmpDir);
  return { router, connector, bridge, tmpDir };
}

/**
 * 回调响应预算锚点：飞书卡片回调 3 秒上限，router 侧预算
 * CONFIG_CALLBACK_BUDGET_MS（1.5s）。config.set/save 的回调链只做内存操作 +
 * 写盘，本锚点断言常量区间（防误改超预算）与响应体形态。
 */
describe('config 回调响应预算锚点', () => {
  it('回调预算常量在安全区间', () => {
    // 3s 飞书上限；预算必须小于它并留网络余量，但不小于 500ms（真写盘需要）。
    expect(CONFIG_CALLBACK_BUDGET_MS).toBeGreaterThanOrEqual(500);
    expect(CONFIG_CALLBACK_BUDGET_MS).toBeLessThanOrEqual(2_500);
  });

  it('config.set 回调链零网络写：响应体直出卡片 + toast', async () => {
    const { router, connector } = makeFixture('set-inline');
    const response = await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'debug' },
      ctx,
    );
    // 回调链内：无 sendResult、无 PATCH（卡片由响应体替换）
    expect(connector._sent.length).toBe(0);
    expect(connector._cards.length).toBe(0);
    expect(connector._updates.length).toBe(0);
    // 响应体：toast + raw 卡（飞书原地替换 pre-click 卡）
    expect(response).toMatchObject({
      toast: { type: 'info' },
      card: { type: 'raw' },
    });
    const card = (response as { card: { data: object } }).card.data;
    expect(JSON.stringify(card)).toContain('config.save'); // 保存按钮仍在
  });

  it('config.save 回调链零网络写（无切换时），写盘立即返回', async () => {
    const { router, connector, tmpDir } = makeFixture('save-noswitch');
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'debug' },
      ctx,
    );
    connector._sent.length = 0;
    connector._updates.length = 0;
    const save = await router.handleCardAction({ cmd: 'config.save' }, ctx);
    // 无 agent 切换 → 无通知；回调链零网络写
    expect(connector._sent.length).toBe(0);
    expect(connector._updates.length).toBe(0);
    expect(save).toBeUndefined();
    // 写盘已发生（同步，不等后台渲染）
    expect(readFileSync(path.join(tmpDir, 'config.yaml'), 'utf-8')).toContain('level: debug');
    // 后台渲染把兄弟卡刷掉
    await router.flushConfigRender();
  });
});

/**
 * 后台渲染队列锚点：兄弟卡刷新与 /c 后台目录刷新合并窗口。
 * merged>0 表示连点被合并；patches 是实际 PATCH 数。
 */
describe('config 后台渲染队列锚点', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('连点合并：两次 config.set 只扇出一次兄弟卡刷新（最后一次状态赢）', async () => {
    const { router, connector } = makeFixture('merge');
    const cardA = { ...ctx, messageId: 'om-A' };
    const cardB = { ...ctx, messageId: 'om-B' };

    // A 先交互（登记 + inline 响应），B 后交互
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'debug' },
      cardA,
    );
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'debug' },
      cardB,
    );
    connector._updates.length = 0;

    // 连点两次 A（同卡）：两次响应体直出，后台渲染合并为一次
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'warn' },
      cardA,
    );
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'error' },
      cardA,
    );
    await router.flushConfigRender();

    // 被点击的卡被响应体替换，后台只刷兄弟卡 B，且只刷一次（合并）
    expect(connector._updates.length).toBe(1);
    expect(connector._updates[0].messageId).toBe('om-B');
    // 最后一次状态赢：B 的卡片渲染的是 error（最后一次草稿）
    expect(JSON.stringify(connector._updates[0].card)).toContain('"error"');
  });

  it('合并窗口常量与 flush 立即冲刷', async () => {
    expect(CONFIG_RENDER_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(CONFIG_RENDER_DEBOUNCE_MS).toBeLessThanOrEqual(1_000);
    const { router } = makeFixture('flush');
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'debug' },
      ctx,
    );
    // flush 不等 debounce 窗口，同步冲刷 pending
    await router.flushConfigRender();
    expect(router.configRenderState.pending).toBeUndefined();
  });
});

/**
 * /c 打开路径锚点：prefetch 不阻塞出卡（短预算即返回），后台刷新后
 * 兄弟渲染不把文本命令的 messageId 登记为 config 卡。
 */
describe('/config 打开路径锚点', () => {
  // 本组只测「目录预取不阻塞出卡」，与 probe 延迟无关：probeAllAgents 会按平台
  // 走 resolveExecutable 探测各 agent 二进制，宿主差异（尤其 Windows/受限环境）
  // 下耗时波动大，会让 `elapsed < 300` 这类预算断言在 CI 上假红。把它 stub 成
  // 立即返回空表，隔离出 prefetch-deferred 行为本身。
  beforeEach(() => {
    vi.spyOn(probeModule, 'probeAllAgents').mockResolvedValue(new Map());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('/c 目录预取超预算也立即出卡，deferred 后台渲染不把用户消息登记为 config 卡', async () => {
    const { router, connector } = makeFixture('open');

    // 先登记一张真实 config 卡，用来证明 deferred 后台渲染确实执行了（不是空转）。
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'debug' },
      { ...ctx, messageId: 'om-config-old' },
    );
    await router.flushConfigRender();
    connector._updates.length = 0;

    // 强制走 deferred 分支：目录预取 300ms > CONFIG_OPEN_PREFETCH_BUDGET_MS(200ms)。
    let prefetchResolved = false;
    vi.spyOn(router, 'prefetchConfigCardCatalogs').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            prefetchResolved = true;
            resolve();
          }, 300);
        }),
    );

    const openCtx = { userId: 'user1', chatId: 'chat1', messageId: 'om-user-msg' };
    const startedAt = Date.now();
    await router.handle('/config', openCtx);
    const elapsed = Date.now() - startedAt;

    // 出卡不等预取完成
    expect(elapsed).toBeLessThan(300);
    expect(prefetchResolved).toBe(false);
    expect(connector._sent.length).toBe(1);

    // 等 deferred 预取落地 + 后台渲染跑完
    await new Promise((resolve) => setTimeout(resolve, 350));
    await router.flushConfigRender();

    // 关键回归 1：deferred 渲染不得把用户文本消息 id 登记成 config 卡，
    // 也不得 PATCH 它（否则那条聊天消息会被替换成配置卡）。
    expect(router.configCardIds.has('om-user-msg')).toBe(false);
    expect(connector._updates.map((u) => u.messageId)).not.toContain('om-user-msg');
    // 关键回归 2：deferred 后台渲染覆盖既有 config 卡（不是空转）。
    expect(connector._updates.map((u) => u.messageId)).toContain('om-config-old');
    // 关键回归 3：刚打开的 /c 卡也要被刷到新目录（stub connector 发卡返回 msg-id），
    // 这是「DSH 新增 provider 后打开 /c 立即可见」的实际兑现点。
    expect(connector._updates.map((u) => u.messageId)).toContain('msg-id');
  });

  it('连开两次 /c：两次 deferred 预取各自落地后补刷，合并成一次 PATCH', async () => {
    const { router, connector } = makeFixture('open-chain');
    // 目录签名只在 router 消费槽位时读（cmdConfig 取基线走模块内直接调用）。
    // 让消费端看到清单变化，才能验证「两次变化合并成一次 PATCH」；目录没变时
    // 不补刷的行为由 config-catalog-refresh.test.ts 单独守。
    let seq = 0;
    vi.spyOn(configActions, 'captureCatalogSignature').mockImplementation(() => `changed-${seq++}`);
    const releases: Array<() => void> = [];
    vi.spyOn(router, 'prefetchConfigCardCatalogs').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );

    const openCtx = { userId: 'user1', chatId: 'chat1', messageId: 'om-user-msg' };
    await router.handle('/config', openCtx);
    await router.handle('/config', { ...openCtx, messageId: 'om-user-msg-2' });
    expect(releases.length).toBe(2);
    connector._updates.length = 0;

    // 第一次预取落地：它的补刷必须已在队列里（不能因为第二次 /c 开了新槽位就丢）。
    releases[0]!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.configRenderState.pending).toBeDefined();

    // 第二次落地落进同一个合并窗口：连开两次只扇出一次 PATCH。
    releases[1]!();
    await router.flushConfigRender();
    expect(connector._updates.map((u) => u.messageId)).toEqual(['msg-id']);
  });

  it('目录预取槽位只在 /config 卡片发出后消费（无关命令的回复不算就位）', async () => {
    const { router } = makeFixture('open-slot');
    // 直接摆一个待消费的槽位：模拟「/config 的预取已登记、卡片还没发出」。
    router.pendingConfigOpenRefresh = { before: 'baseline', prefetch: Promise.resolve() };
    await router.handle('/status', { ...ctx, messageId: 'om-status-msg' });
    expect(router.pendingConfigOpenRefresh).toBeDefined();
  });

  it('目录探测只在 force 时调 builder.refreshCatalogs，保存路径不 spawn CLI', async () => {
    const { router } = makeFixture('catalog-contract');
    const builder = getConfigBuilder(router.config.defaultAgent ?? 'claude');
    const spy = vi.spyOn(builder, 'refreshCatalogs').mockResolvedValue();

    await configActions.prefetchConfigCardCatalogs(router, true);
    expect(spy).toHaveBeenCalledTimes(1);

    // config.save 后台队列带 refreshCatalogs=true 但 force=false，不该为每次
    // 保存都重探目录。
    spy.mockClear();
    await configActions.prefetchConfigCardCatalogs(router, false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('目录没变化：deferred 预取落地后一次 PATCH 都不发', async () => {
    const { router, connector } = makeFixture('catalog-no-change');
    // consume 端读到的签名与基线一致；cmdConfig 取基线走模块内直接调用，
    // 不受这个 spy 影响。stub 的预取立即完成，不会另建槽位。
    vi.spyOn(configActions, 'captureCatalogSignature').mockReturnValue('fixed');
    vi.spyOn(router, 'prefetchConfigCardCatalogs').mockResolvedValue();
    router.pendingConfigOpenRefresh = { before: 'fixed', prefetch: Promise.resolve() };

    await router.handle('/config', { ...ctx, messageId: 'om-user-msg' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await router.flushConfigRender();

    expect(connector._updates.length).toBe(0);
    expect(router.configCardIds.has('om-user-msg')).toBe(false);
  });

  it('目录变化：deferred 预取落地后补刷全部已登记卡片', async () => {
    const { router, connector } = makeFixture('catalog-changed');
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'debug' },
      { ...ctx, messageId: 'om-config-old' },
    );
    await router.flushConfigRender();
    connector._updates.length = 0;

    vi.spyOn(configActions, 'captureCatalogSignature').mockReturnValue('new-signature');
    vi.spyOn(router, 'prefetchConfigCardCatalogs').mockResolvedValue();
    router.pendingConfigOpenRefresh = { before: 'old-signature', prefetch: Promise.resolve() };

    await router.handle('/config', { ...ctx, messageId: 'om-user-msg' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await router.flushConfigRender();

    const patched = connector._updates.map((u) => u.messageId);
    expect(patched).toContain('om-config-old');
    expect(patched).toContain('msg-id');
    // 用户文本消息永远不能被 PATCH 成配置卡。
    expect(patched).not.toContain('om-user-msg');
  });

  it('config.refresh 只回 toast，被点击的那张卡也走 PATCH 拿到新目录', async () => {
    const { router, connector } = makeFixture('catalog-refresh-action');
    // 禁止真 spawn / 真网络：显式刷新只验证卡片调度。
    vi.spyOn(router, 'prefetchConfigCardCatalogs').mockResolvedValue();

    const response = await router.handleCardAction(
      { cmd: 'config.refresh' },
      { ...ctx, messageId: 'om-refresh-card' },
    );
    expect(response).toMatchObject({ toast: { type: 'info' } });
    // 回 inline 卡会被 refreshConfigCards 的 excludeMessageId 跳过。
    expect((response as { card?: unknown } | undefined)?.card).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await router.flushConfigRender();
    expect(connector._updates.map((u) => u.messageId)).toContain('om-refresh-card');
  });

  it('直写路径 /config key value 仍立即写盘（行为不变锚点）', async () => {
    const { router, tmpDir } = makeFixture('direct-set');
    await router.handle('/config claude.model haiku', ctx);
    expect(existsSync(path.join(tmpDir, 'config.yaml'))).toBe(true);
    expect(readFileSync(path.join(tmpDir, 'config.yaml'), 'utf-8')).toContain('model: haiku');
  });
});

/**
 * 组件预算锚点（大目录配置卡）。
 *
 * 真实形态：本机 `opencode models` 给一个 provider 88 个模型，配置卡整卡 219 个
 * 带 `tag` 节点（飞书上限 200）。裁剪必须**先裁下拉选项、再丢整行**——顺序反了
 * 会把 `**🤖 opencode**` 分区标题、「默认 Agent」与 provider 下拉一起丢掉，用户
 * 只能看到一句与本场景无关的「还有 3 个事件未显示」，并且点任意下拉都会把卡片
 * 原地替换成同一张残卡（入口永久消失）。
 *
 * 同一份草稿有两条渲染路径：inline 响应体与兄弟卡 PATCH。两条必须同一预算口径，
 * 否则没裁的那条会被飞书 `11310` 整卡拒绝，`patchCard` 失败又把这个 messageId
 * 从 `configCardIds` 永久剔除——多卡同步静默退化成「只有刚点的那张有新值」。
 *
 * 用合成字段（130+ 选项）复现，不 spawn 真 CLI。
 */
describe('config 卡组件预算锚点（大目录）', () => {
  const bigConfig = AppConfigSchema.parse({ feishu: { appId: 'test', appSecret: 'test' } });

  function bigTabs(modelCount: number): ConfigTab[] {
    return [
      {
        id: 'agent',
        label: '🤖 opencode',
        fields: [
          {
            key: 'defaultAgent',
            label: '默认 Agent',
            type: 'select',
            options: [{ text: 'opencode', value: 'opencode' }],
            currentValue: 'opencode',
          },
          { key: 'agents.opencode.providerID', label: 'Provider', type: 'select', options: ['oc'] },
          {
            key: 'agents.opencode.modelID',
            label: '使用模型',
            type: 'select',
            options: Array.from({ length: modelCount }, (_, i) => `m-${i}`),
          },
          {
            key: 'agents.opencode.mode',
            label: '会话模式',
            type: 'select',
            options: ['build', 'plan'],
          },
        ],
      },
      {
        id: 'idle',
        label: '⏱️ 空闲',
        fields: [{ key: 'idle.watchdogMinutes', label: '空闲超时', type: 'input' }],
      },
      {
        id: 'logging',
        label: '📝 日志',
        fields: [
          { key: 'logging.level', label: '日志级别', type: 'select', options: ['debug', 'info'] },
        ],
      },
    ];
  }

  function withBigCard(tmpName: string) {
    const fixture = makeFixture(tmpName);
    const card = buildConfigCardFromTabs(bigTabs(140), bigConfig);
    expect(countCardComponents(card)).toBeGreaterThan(MAX_CARD_COMPONENTS);
    // 卡片由本用例提供：模拟「目录里有上百个模型」的真实形态。
    fixture.router.buildConfigCard = () => ({ card });
    return fixture;
  }

  it('inline 响应裁选项而不是丢整行：默认 Agent / Provider / 分区标题全部保留', async () => {
    const { router } = withBigCard('budget-inline');
    const response = await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'debug' },
      ctx,
    );
    const data = (response as { card: { data: object } }).card.data;
    const json = JSON.stringify(data);

    expect(json).toContain('"defaultAgent"');
    expect(json).toContain('agents.opencode.providerID');
    expect(json).toContain('agents.opencode.modelID');
    expect(json).toContain('🤖 opencode');
    // 提示按来源分口径：配置卡上没有「事件」，裁的是下拉选项。
    expect(json).toContain('个选项未显示');
    expect(json).not.toContain('个事件未显示');
    // 裁剪后落在预算内，否则飞书 11310 整卡拒绝。
    expect(countCardComponents(data)).toBeLessThanOrEqual(MAX_CARD_COMPONENTS);
  });

  it('兄弟卡 PATCH 同样过预算：超限卡不会被 11310 打回后从集合剔除', async () => {
    const { router, connector } = withBigCard('budget-sibling');
    const cardA = { ...ctx, messageId: 'om-A' };
    const cardB = { ...ctx, messageId: 'om-B' };

    // A、B 都登记为 config 卡
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'debug' },
      cardA,
    );
    await router.flushConfigRender();
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'warn' },
      cardB,
    );
    await router.flushConfigRender();
    connector._updates.length = 0;

    // 在 B 上再点一次：A 是兄弟卡，走后台 PATCH
    await router.handleCardAction(
      { cmd: 'config.set', key: 'logging.level', option: 'error' },
      cardB,
    );
    await router.flushConfigRender();

    const sibling = connector._updates.find((u) => u.messageId === 'om-A');
    expect(sibling).toBeDefined();
    expect(countCardComponents(sibling!.card)).toBeLessThanOrEqual(MAX_CARD_COMPONENTS);
    expect(JSON.stringify(sibling!.card)).toContain('"defaultAgent"');
    // PATCH 成功 → 集合保留（失败才会被剔除）。
    expect(router.configCardIds.has('om-A')).toBe(true);
  });

  it('切换通知发送挂住时 config.save 仍在预算内回包（通知转后台补发）', async () => {
    const { router, bridge, connector } = makeFixture('switch-notice-budget');
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'codex' }, ctx);
    connector._sent.length = 0;

    // 切换卡发送永不 resolve：模拟网络长尾。
    vi.spyOn(bridge, 'sendResult').mockImplementation((result) =>
      'card' in result && JSON.stringify(result).includes('🔀')
        ? new Promise<boolean>(() => {})
        : Promise.resolve(true),
    );

    vi.useFakeTimers();
    try {
      const save = router.handleCardAction({ cmd: 'config.save' }, ctx);
      await vi.advanceTimersByTimeAsync(CONFIG_SWITCH_NOTICE_BUDGET_MS);
      // 预算到点即回包（写盘早已完成，不能报成「超时未响应」）。
      await expect(save).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
