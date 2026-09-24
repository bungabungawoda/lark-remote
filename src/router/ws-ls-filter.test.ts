/**
 * /ws 与 /ls 列表卡的关键词搜索。
 *
 * 覆盖三件事：过滤语义（大小写不敏感子串、/ws 匹配 name+path、/ls 只匹配当前层）、
 * `q` 随卡片 callback 透传的保留/清除矩阵（服务端零状态，漏一个按钮就是静默丢失）、
 * 以及搜索行的 CardKit 2.0 结构（200861/300123/200621 红线）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandRouter } from './index.js';
import type { CardActionPayload } from './index.js';
import { searchBar, SEARCH_INPUT_NAME } from './card-helpers.js';
import { Bridge } from '../bridge/index.js';
import { SessionStore } from '../session/index.js';
import { AppConfigSchema } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
  createStubSessionReaderRegistry,
} from '../../tests/lib/bridge-stubs.js';
import { expectNoV1ActionContainer } from '../../tests/lib/card-view.js';
import { rmRf } from '../../tests/lib/tmp-cleanup.js';
import { canLinkFiles, linkDangling, linkDir, linkFile } from '../../tests/lib/fs-links.js';

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

// ── 卡片结构视图与遍历 helper（断言全部落在生产渲染出的卡片元素上）──────────

type CardEl = {
  tag?: string;
  text?: { content?: string };
  name?: string;
  placeholder?: { content?: string };
  default_value?: string;
  max_length?: number;
  width?: string;
  weight?: number;
  elements?: CardEl[];
  columns?: CardEl[];
  /** callback value 按生产契约收窄成 CardActionPayload：漏字段/拼错名编译期就红。 */
  behaviors?: Array<{ type?: string; value?: CardActionPayload }>;
};

type Card = { schema?: string; body?: { elements?: CardEl[] } };

/** 深度展开 column_set/column 的嵌套元素（input 与按钮都藏在 column.elements 里）。 */
function flatten(els: CardEl[]): CardEl[] {
  const out: CardEl[] = [];
  for (const el of els) {
    out.push(el);
    for (const col of el.columns ?? []) out.push(...flatten(col.elements ?? []));
    out.push(...flatten(el.elements ?? []));
  }
  return out;
}

function bodyOf(card: Card | undefined): CardEl[] {
  expect(card, '卡片未渲染').toBeDefined();
  return card?.body?.elements ?? [];
}

function allText(card: Card | undefined): string {
  return flatten(bodyOf(card))
    .map((el) => el.text?.content ?? '')
    .join('\n');
}

/** 组件的 callback value（无 callback 的组件返回 null，便于过滤）。 */
function payloadOf(el: CardEl): CardActionPayload | null {
  const v = el.behaviors?.find((b) => b.type === 'callback')?.value;
  return v ?? null;
}

/**
 * 按 cmd 取组件。**必须带 tag**：paginationBar 的 input 与翻页按钮共用同一个
 * cmd（既有红线），只按 cmd 过滤会把 input 一起收进来。
 */
function componentsForCmd(card: Card | undefined, cmd: string, tag: string): CardEl[] {
  return flatten(bodyOf(card)).filter((el) => el.tag === tag && payloadOf(el)?.cmd === cmd);
}

function payloadsForCmd(card: Card | undefined, cmd: string, tag: string): CardActionPayload[] {
  return componentsForCmd(card, cmd, tag).map((el) => payloadOf(el)!);
}

function searchInputs(card: Card | undefined): CardEl[] {
  return flatten(bodyOf(card)).filter((el) => el.tag === 'input' && el.name === SEARCH_INPUT_NAME);
}

/** 卡上所有带 callback 的组件（向后兼容锚点：无筛选时一个 q 都不该出现）。 */
function allCallbackPayloads(card: Card | undefined): CardActionPayload[] {
  return flatten(bodyOf(card))
    .map((el) => payloadOf(el))
    .filter((v): v is CardActionPayload => v !== null);
}

// ── fixture ──────────────────────────────────────────────────────────────

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmRf(dir);
});

function makeFixture(opts: {
  /** workspace 别名 → 路径（写入 workspace.json，lastUsedAt 按声明顺序递增） */
  workspaces?: Record<string, string>;
  /** 在根目录下建的子目录名（支持 a/b 多级） */
  dirs?: string[];
  /** 在根目录下建的文件名 */
  files?: string[];
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ls-filter-')));
  createdDirs.push(root);

  const workspacePath = path.join(root, 'workspace.json');
  if (opts.workspaces) {
    let lastUsedAt = 1_700_000_000_000;
    const data: Record<string, { path: string; lastUsedAt: number }> = {};
    for (const [name, wsPath] of Object.entries(opts.workspaces)) {
      data[name] = { path: wsPath, lastUsedAt: lastUsedAt++ };
    }
    fs.writeFileSync(workspacePath, JSON.stringify(data));
  }
  for (const d of opts.dirs ?? []) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of opts.files ?? []) fs.writeFileSync(path.join(root, f), 'x');

  const sessionStore = new SessionStore();
  sessionStore.setCwd('user1', root);
  const connector = createStubConnector();
  const runner = createStubRunner({ withStatusInfo: true });
  const config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'claude-test-model', stopGraceMs: 5000 },
  }) as AppConfig;
  const router = new CommandRouter({
    sessionStore,
    bridge: new Bridge({
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    }),
    config,
    configPath: path.join(root, 'config.yaml'),
    workspacePath,
    ordersPath: path.join(root, 'orders.json'),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
  });
  return { router, connector, root };
}

function wsCardOf(router: CommandRouter, q?: string): Card {
  return router.cmdWs([], ctx, 0, q).card as Card;
}

function lsCardOf(router: CommandRouter, q?: string, args: string[] = [], rootDir?: string): Card {
  return router.cmdLs(args, ctx, 0, rootDir, q).card as Card;
}

/** 最近一次原地刷新的卡片（updateCardInPlace → stub connector.updateCard）。 */
function lastUpdatedCard(connector: ReturnType<typeof createStubConnector>): Card {
  expect(connector._updates.length, '卡片没有原地刷新').toBeGreaterThan(0);
  return connector._updates.at(-1)!.card as Card;
}

/** 命令路径发出的新卡片（sendResult → stub connector.sendWithRetry({ card })）。 */
function lastSentCard(connector: ReturnType<typeof createStubConnector>): Card {
  const cards = connector._sent
    .map((s) => (s.input as { card?: Card }).card)
    .filter((c): c is Card => !!c);
  expect(cards.length, '没有发出任何卡片').toBeGreaterThan(0);
  return cards.at(-1)!;
}

function toastOf(res: unknown): { type: string; content: string } | undefined {
  return (res as { toast?: { type: string; content: string } })?.toast;
}

// ===========================================================================
// searchBar helper 本身
// ===========================================================================

describe('searchBar', () => {
  it('返回单个 column_set，input 独占加权列（窄屏不被按钮挤压）', () => {
    const row = searchBar({
      cmd: 'ls.filter',
      placeholder: '搜索本层目录/文件名，输完回车',
      extra: { path: '/home/user/project', root: '/home/user/project' },
    }) as { tag: string; columns: CardEl[] };

    // paginationBar 返回数组、searchBar 返回单对象——写反了要到渲染期才炸
    expect(row.tag).toBe('column_set');
    // 无关键词 = 没有可清除的东西，只有输入框一列
    expect(row.columns).toHaveLength(1);
    const col = row.columns[0];
    expect(col.width).toBe('weighted');
    expect(col.weight).toBe(1);

    const input = col.elements![0];
    expect(input.tag).toBe('input');
    // placeholder 必须写明提交式交互（CardKit 无逐键回调，只能回车提交）
    expect(input.placeholder?.content).toContain('输完回车');
    expect(input.max_length).toBe(100);
    expect(payloadOf(input)).toMatchObject({
      cmd: 'ls.filter',
      path: '/home/user/project',
      root: '/home/user/project',
    });
  });

  it('有 currentQuery 就自动加「清除筛选」按钮（不依赖清空回车）', () => {
    const row = searchBar({
      cmd: 'ls.filter',
      placeholder: '搜索本层目录/文件名，输完回车',
      currentQuery: 'foo',
      extra: { path: '/home/user/project', root: '/home/user/project' },
    }) as { tag: string; columns: CardEl[] };

    expect(row.columns).toHaveLength(2);
    const [inputCol, clearCol] = row.columns;
    expect(inputCol.width).toBe('weighted');
    expect(clearCol.width).toBe('auto');

    const btn = clearCol.elements![0];
    expect(btn.tag).toBe('button');
    expect(btn.text?.content).toBe('清除筛选');
    // 按钮 payload 带 clearQuery 标记 + /ls 必需的 path/root，但不带 q
    expect(payloadOf(btn)).toEqual({
      cmd: 'ls.filter',
      clearQuery: true,
      path: '/home/user/project',
      root: '/home/user/project',
    });
  });

  it('无关键词时不放 default_value 字段；有关键词时回显', () => {
    const withQuery = searchBar({ cmd: 'ws.filter', placeholder: 'p', currentQuery: 'foo' }) as {
      columns: CardEl[];
    };
    expect(withQuery.columns[0].elements![0].default_value).toBe('foo');
    const without = searchBar({ cmd: 'ws.filter', placeholder: 'p' }) as { columns: CardEl[] };
    expect('default_value' in (without.columns[0].elements![0] as object)).toBe(false);
  });

  it('不用 form / action 容器（300123 / 200621 / 200861 红线）', () => {
    const json = JSON.stringify(
      searchBar({ cmd: 'ws.filter', placeholder: '搜索名称或路径，输完回车' }),
    );
    expect(json).not.toContain('"tag":"form"');
    expect(json).not.toContain('"tag":"action"');
    expectNoV1ActionContainer(json);
  });
});

// ===========================================================================
// /ws 过滤
// ===========================================================================

describe('/ws 关键词筛选', () => {
  const eight = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`w${i + 1}`, `/home/user/work/w${i + 1}`]),
  );

  it('只保留 name 或 path 命中的条目，大小写不敏感', () => {
    const { router } = makeFixture({
      workspaces: {
        'proj-alpha': '/home/user/work/alpha',
        'proj-beta': '/home/user/work/beta',
        GAMMA: '/home/user/tools/gamma',
      },
    });
    const text = allText(wsCardOf(router, 'ALPHA'));
    expect(text).toContain('proj-alpha');
    expect(text).not.toContain('proj-beta');
    expect(text).not.toContain('GAMMA');
  });

  it('path 命中但 name 不命中的条目同样保留', () => {
    const { router } = makeFixture({
      workspaces: {
        one: '/home/user/work/alpha-project',
        two: '/home/user/work/beta',
      },
    });
    const text = allText(wsCardOf(router, 'alpha'));
    expect(text).toContain('**one**');
    // 用列表行的 `**name**` 形态做负断言：整卡文本含 cwd 表头，随机后缀能拼出 "two"。
    expect(text).not.toContain('**two**');
  });

  it('筛选后零命中：无匹配提示 + 搜索行仍在 + 无分页栏', () => {
    const { router } = makeFixture({ workspaces: eight });
    const unfiltered = wsCardOf(router);
    // 前置条件：未筛选时应有分页按钮，否则下面「零命中不渲染分页栏」是空断言
    expect(componentsForCmd(unfiltered, 'ws.page', 'button').length).toBeGreaterThan(0);

    const card = wsCardOf(router, 'zzz-no-such-name');
    expect(allText(card)).toContain('无匹配条目');
    expect(searchInputs(card)).toHaveLength(1);
    // 分页栏整体不渲染：按钮与 input 共用 ws.page，两者都必须为 0
    expect(componentsForCmd(card, 'ws.page', 'button')).toHaveLength(0);
    expect(componentsForCmd(card, 'ws.page', 'input')).toHaveLength(0);
  });

  it('筛选态：ws.page / ws.sort / ws.use / ws.remove 的 value 全部带 q', () => {
    const { router } = makeFixture({ workspaces: eight });
    const card = wsCardOf(router, 'WORK');

    const pagePayloads = payloadsForCmd(card, 'ws.page', 'button');
    expect(pagePayloads.length).toBeGreaterThan(0);
    for (const p of pagePayloads) expect(p.q).toBe('WORK');
    // 分页栏的跳转页码 input 也要带 q（否则跳页丢筛选）
    for (const p of payloadsForCmd(card, 'ws.page', 'input')) expect(p.q).toBe('WORK');

    const sortPayloads = payloadsForCmd(card, 'ws.sort', 'button');
    expect(sortPayloads).toHaveLength(1);
    expect(sortPayloads[0].q).toBe('WORK');

    const usePayloads = payloadsForCmd(card, 'ws.use', 'button');
    expect(usePayloads.length).toBeGreaterThan(0);
    for (const p of usePayloads) expect(p.q).toBe('WORK');

    const removePayloads = payloadsForCmd(card, 'ws.remove', 'button');
    expect(removePayloads.length).toBeGreaterThan(0);
    for (const p of removePayloads) expect(p.q).toBe('WORK');

    // 搜索行提交回到 ws.filter
    expect(payloadOf(searchInputs(card)[0])?.cmd).toBe('ws.filter');
  });

  it('筛选态搜索行右侧有「清除筛选」按钮，未筛选态没有', () => {
    const { router } = makeFixture({ workspaces: eight });
    const card = wsCardOf(router, 'WORK');
    const clearBtns = componentsForCmd(card, 'ws.filter', 'button');
    expect(clearBtns).toHaveLength(1);
    expect(clearBtns[0].text?.content).toBe('清除筛选');
    expect(payloadOf(clearBtns[0])).toEqual({ cmd: 'ws.filter', clearQuery: true });

    // 未筛选态不出按钮（输入框恢复独占整行），且搜索行仍然在
    const plain = wsCardOf(router);
    expect(componentsForCmd(plain, 'ws.filter', 'button')).toHaveLength(0);
    expect(searchInputs(plain)).toHaveLength(1);
  });

  it('无筛选时（/ws 命令路径）卡片上没有任何 q 字段（旧 payload 形态不变）', async () => {
    const { router, connector } = makeFixture({ workspaces: eight });
    await router.handle('/ws', ctx);
    const card = lastSentCard(connector);
    // 前置条件：确实渲染出了可点击组件，否则"没有 q"是空断言
    expect(allCallbackPayloads(card).length).toBeGreaterThan(0);
    for (const p of allCallbackPayloads(card)) expect(p).not.toHaveProperty('q');
  });

  it('筛选态卡片仍是合法 CardKit 2.0（200861 断言 + schema/behaviors）', () => {
    const { router } = makeFixture({ workspaces: eight });
    const card = wsCardOf(router, 'work');
    expect(card.schema).toBe('2.0');
    expectNoV1ActionContainer(card);
    expect(allCallbackPayloads(card).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// /ls 过滤
// ===========================================================================

describe('/ls 关键词筛选', () => {
  /** root 下：foo_dir + 35 个 foo-NN.txt（越过 LS_PAGE_SIZE=30）+ 3 个 bar 文件 */
  function lsFixture() {
    return makeFixture({
      dirs: ['foo_dir', 'foo_dir/nested'],
      files: [
        ...Array.from({ length: 35 }, (_, i) => `foo-${String(i + 1).padStart(2, '0')}.txt`),
        'bar-1.txt',
        'bar-2.txt',
        'FOO-upper.txt',
      ],
    });
  }

  it('只显示当前层命中的目录和文件，不递归子目录', () => {
    const { router, root } = makeFixture({
      dirs: ['foo_dir', 'unrelated'],
      files: ['foo-file.txt', 'readme.md'],
    });
    fs.writeFileSync(path.join(root, 'unrelated', 'deep-foo.txt'), 'x');

    // 前置条件：未筛选时 readme.md 在列表里，"筛选后被排除"才是有效断言
    const unfiltered = allText(lsCardOf(router));
    expect(unfiltered).toContain('readme.md');
    expect(unfiltered).toContain('共 2 目录, 2 文件');

    const text = allText(lsCardOf(router, 'foo'));
    expect(text).toContain('foo_dir');
    expect(text).toContain('foo-file.txt');
    expect(text).not.toContain('readme.md');
    // 子目录里的同名文件不属于本层：图省事改成递归 walk 会让计数变成 2 文件
    expect(text).not.toContain('deep-foo');
    expect(text).toContain('共 1 目录, 1 文件');
  });

  it('大小写不敏感命中', () => {
    const { router } = lsFixture();
    const text = allText(lsCardOf(router, 'foo-upper'));
    expect(text).toContain('FOO-upper.txt');
  });

  it('筛选态「清除筛选」按钮带 path/root（点它才知道刷哪个目录）', () => {
    const { router, root } = lsFixture();
    const card = lsCardOf(router, 'foo', [], root);
    const clearBtns = componentsForCmd(card, 'ls.filter', 'button');
    expect(clearBtns).toHaveLength(1);
    expect(clearBtns[0].text?.content).toBe('清除筛选');
    expect(payloadOf(clearBtns[0])).toMatchObject({
      cmd: 'ls.filter',
      clearQuery: true,
      path: root,
      root,
    });
    // 未筛选态不出按钮
    expect(componentsForCmd(lsCardOf(router), 'ls.filter', 'button')).toHaveLength(0);
  });

  it('筛选态：ls.page 与 ls.refresh 带 q；ls.browse 与 ls.switch 不带 q（清除语义）', () => {
    const { router, root } = lsFixture();
    const sub = path.join(root, 'foo_dir');
    for (let i = 1; i <= 35; i++) {
      fs.writeFileSync(path.join(sub, `foo-${String(i).padStart(2, '0')}.txt`), 'x');
    }
    fs.writeFileSync(path.join(sub, 'bar.txt'), 'x');

    // 在子目录上筛选（cwd = root）：切换 / 返回 按钮都会出现
    const card = lsCardOf(router, 'foo', [sub], root);

    const pageBtns = payloadsForCmd(card, 'ls.page', 'button');
    expect(pageBtns.length).toBeGreaterThan(0);
    for (const p of pageBtns) expect(p.q).toBe('foo');
    for (const p of payloadsForCmd(card, 'ls.page', 'input')) expect(p.q).toBe('foo');

    const refresh = payloadsForCmd(card, 'ls.refresh', 'button');
    expect(refresh).toHaveLength(1);
    expect(refresh[0].q).toBe('foo');

    const browse = payloadsForCmd(card, 'ls.browse', 'button');
    expect(browse.length).toBeGreaterThan(0);
    for (const p of browse) expect(p).not.toHaveProperty('q');

    const switchTo = payloadsForCmd(card, 'ls.switch', 'button');
    expect(switchTo).toHaveLength(1);
    expect(switchTo[0]).not.toHaveProperty('q');

    // 文件下载按钮与筛选无关，也不带 q
    for (const p of payloadsForCmd(card, 'ls.file', 'button')) expect(p).not.toHaveProperty('q');
  });

  it('筛选后零命中：不渲染目录/文件区标题，只给无匹配提示 + 搜索行', () => {
    const { router } = lsFixture();
    // 前置条件：未筛选时两个区标题都在，"标题消失"才不是空断言
    const unfiltered = allText(lsCardOf(router));
    expect(unfiltered).toContain('📂 目录');
    expect(unfiltered).toContain('📄 文件');

    const card = lsCardOf(router, 'zzz-nothing-here');
    const text = allText(card);
    expect(text).toContain('无匹配条目');
    expect(text).not.toContain('📂 目录');
    expect(text).not.toContain('📄 文件');
    expect(searchInputs(card)).toHaveLength(1);
    expect(componentsForCmd(card, 'ls.page', 'button')).toHaveLength(0);
  });

  it('筛选态计数用过滤后的数量（状态行与区标题一致）', () => {
    const { router } = lsFixture();
    const text = allText(lsCardOf(router, 'bar'));
    // 35 个 foo 文件 + FOO-upper 都不该被算进 bar 的计数
    expect(text).toContain('共 0 目录, 2 文件');
    expect(text).toContain('**📄 文件 (2)**');
    expect(text).not.toContain('共 1 目录, 38 文件');
  });

  it('搜索框回显当前关键词，max_length 100', () => {
    const { router } = lsFixture();
    const input = searchInputs(lsCardOf(router, 'foo'))[0];
    expect(input.default_value).toBe('foo');
    expect(input.max_length).toBe(100);
  });

  it('筛选态卡片仍是合法 CardKit 2.0（200861 断言 + schema/behaviors）', () => {
    const { router } = lsFixture();
    const card = lsCardOf(router, 'foo');
    expect(card.schema).toBe('2.0');
    expectNoV1ActionContainer(card);
    expect(allCallbackPayloads(card).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// handler 级：提交 / 清除 / 翻页与排序的透传
// ===========================================================================

describe('ws.filter / ls.filter handler', () => {
  const eight = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`w${i + 1}`, `/home/user/work/w${i + 1}`]),
  );

  it('提交关键词后卡片只含命中项，且 toast 回显关键词', async () => {
    const { router, connector } = makeFixture({
      workspaces: {
        'proj-alpha': '/home/user/work/alpha',
        'proj-beta': '/home/user/work/beta',
      },
    });
    const res = await router.handleCardAction({ cmd: 'ws.filter', inputValue: 'alpha' }, ctx);
    expect(toastOf(res)).toMatchObject({ type: 'success', content: '筛选："alpha"' });
    const text = allText(lastUpdatedCard(connector));
    expect(text).toContain('proj-alpha');
    expect(text).not.toContain('proj-beta');
  });

  it('提交空串/纯空白 = 清除筛选，恢复完整列表且卡片不再带 q', async () => {
    const { router, connector } = makeFixture({ workspaces: eight });
    await router.handleCardAction({ cmd: 'ws.filter', inputValue: 'w1' }, ctx);
    expect(allText(lastUpdatedCard(connector))).toContain('筛选：');

    await router.handleCardAction({ cmd: 'ws.filter', inputValue: '   ' }, ctx);
    const card = lastUpdatedCard(connector);
    const text = allText(card);
    expect(text).not.toContain('筛选：');
    expect(text).not.toContain('无匹配');
    // 8 条全部回到列表（分页栏 total = 8；每页 5 条只渲染第 1 页）
    expect(text).toContain('**1/2**（8）');
    // 卡片上不该再有 q（payload 形态回到未筛选态）
    for (const p of allCallbackPayloads(card)) expect(p).not.toHaveProperty('q');
    expect(searchInputs(card)[0].default_value).toBeUndefined();
  });

  it('点「清除筛选」按钮：clearQuery 强制清除，即使客户端回传输入框残值', async () => {
    const { router, connector } = makeFixture({ workspaces: eight });
    await router.handleCardAction({ cmd: 'ws.filter', inputValue: 'w1' }, ctx);
    const filtered = lastUpdatedCard(connector);
    // 用卡片上真实渲染出的按钮 payload，避免手写常量与生产漂移
    const payload = payloadOf(componentsForCmd(filtered, 'ws.filter', 'button')[0])!;

    const res = await router.handleCardAction({ ...payload, inputValue: 'w1' }, ctx);
    expect(toastOf(res)?.content).toBe('已清除筛选');
    const text = allText(lastUpdatedCard(connector));
    expect(text).toContain('**1/2**（8）');
    expect(text).not.toContain('筛选：');
  });

  it('ls.filter：点「清除筛选」按钮恢复完整列表（不依赖清空输入再回车）', async () => {
    const { router, connector, root } = makeFixture({
      dirs: ['foo_dir'],
      files: ['foo.txt', 'readme.md'],
    });
    await router.handleCardAction({ cmd: 'ls.filter', path: root, inputValue: 'foo' }, ctx);
    const filtered = lastUpdatedCard(connector);
    expect(allText(filtered)).toContain('共 1 目录, 1 文件');
    const payload = payloadOf(componentsForCmd(filtered, 'ls.filter', 'button')[0])!;

    // 带上输入框残值：清除只能靠 clearQuery 标记，靠「读不到输入值」会退化成筛选
    await router.handleCardAction({ ...payload, inputValue: 'foo' }, ctx);
    const text = allText(lastUpdatedCard(connector));
    expect(text).not.toContain('筛选：');
    expect(text).toContain('readme.md');
    expect(text).toContain('共 1 目录, 2 文件');
  });

  it('formValue 回退通道也能取到提交值（inputValue 缺失时）', async () => {
    const { router, connector } = makeFixture({
      workspaces: { 'proj-alpha': '/home/user/work/alpha', 'proj-beta': '/home/user/work/beta' },
    });
    await router.handleCardAction(
      { cmd: 'ws.filter', formValue: { [SEARCH_INPUT_NAME]: 'beta' } },
      ctx,
    );
    const text = allText(lastUpdatedCard(connector));
    expect(text).toContain('proj-beta');
    expect(text).not.toContain('proj-alpha');
  });

  it('提交新关键词时 offset 重置为 0（翻页中改词回第 1 页）', async () => {
    const { router, connector } = makeFixture({ workspaces: eight });
    await router.handleCardAction({ cmd: 'ws.page', offset: 5 }, ctx);
    expect(allText(lastUpdatedCard(connector))).toContain('**2/2**');

    await router.handleCardAction({ cmd: 'ws.filter', inputValue: 'work', offset: 5 }, ctx);
    const card = lastUpdatedCard(connector);
    expect(allText(card)).toContain('**1/2**');
    // recent 排序（lastUsedAt 递增）下第 1 页是 w8..w4，第 2 页才是 w3..w1。
    // 断言落在列表条目上而不是整卡文本：表头带 cwd，mkdtemp 随机后缀能拼出 "w1"。
    expect(payloadsForCmd(card, 'ws.use', 'button').map((p) => p.name)).toEqual([
      'w8',
      'w7',
      'w6',
      'w5',
      'w4',
    ]);
  });

  it('筛选态翻页保留 q', async () => {
    const { router, connector } = makeFixture({ workspaces: eight });
    await router.handleCardAction({ cmd: 'ws.page', offset: 5, q: 'work' }, ctx);
    const card = lastUpdatedCard(connector);
    expect(allText(card)).toContain('筛选："work"');
    for (const p of payloadsForCmd(card, 'ws.use', 'button')) expect(p.q).toBe('work');
  });

  it('筛选态排序切换保留 q', async () => {
    const { router, connector } = makeFixture({ workspaces: eight });
    await router.handleCardAction({ cmd: 'ws.sort', q: 'w1' }, ctx);
    const text = allText(lastUpdatedCard(connector));
    expect(text).toContain('筛选："w1"');
  });

  it('ls.filter：路径已删除/非法时回错误 toast 且不动卡片（TOCTOU 锚）', async () => {
    const { router, connector, root } = lsFixtureForToctou();
    const before = connector._updates.length;

    const gone = path.join(root, 'vanished');
    const res = await router.handleCardAction(
      { cmd: 'ls.filter', path: gone, inputValue: 'foo' },
      ctx,
    );
    expect(toastOf(res)).toMatchObject({ type: 'error' });
    expect(toastOf(res)?.content).toContain('路径无效');
    expect(connector._updates.length).toBe(before);

    const missingPath = await router.handleCardAction({ cmd: 'ls.filter', inputValue: 'foo' }, ctx);
    expect(toastOf(missingPath)).toMatchObject({
      type: 'error',
      content: '卡片 payload 缺少 path',
    });
    expect(connector._updates.length).toBe(before);
  });

  it('ls.filter：提交关键词后原地刷新为过滤结果，清空输入恢复完整列表', async () => {
    const { router, connector, root } = makeFixture({
      dirs: ['foo_dir'],
      files: ['foo-1.txt', 'bar-1.txt'],
    });
    await router.handleCardAction({ cmd: 'ls.filter', path: root, inputValue: 'foo' }, ctx);
    let card = lastUpdatedCard(connector);
    let text = allText(card);
    expect(text).toContain('foo-1.txt');
    expect(text).not.toContain('bar-1.txt');
    expect(text).toContain('共 1 目录, 1 文件');

    await router.handleCardAction({ cmd: 'ls.filter', path: root, inputValue: '' }, ctx);
    card = lastUpdatedCard(connector);
    text = allText(card);
    expect(text).toContain('bar-1.txt');
    expect(text).toContain('共 1 目录, 2 文件');
    for (const p of allCallbackPayloads(card)) expect(p).not.toHaveProperty('q');
  });

  it('ls.filter 的搜索 special 字符不抛异常（禁 RegExp）', async () => {
    const { router, connector, root } = makeFixture({ files: ['foo(1).txt', 'plain.txt'] });
    const res = await router.handleCardAction(
      { cmd: 'ls.filter', path: root, inputValue: 'foo(' },
      ctx,
    );
    expect(toastOf(res)?.type).toBe('success');
    const text = allText(lastUpdatedCard(connector));
    expect(text).toContain('foo(1).txt');
    expect(text).not.toContain('plain.txt');
  });
});

/** lsFixture 的 TOCTOU 变体：单独建根目录，删掉一个子目录制造"路径消失"。 */
function lsFixtureForToctou() {
  const fixture = makeFixture({ dirs: ['foo_dir'] });
  fs.rmSync(path.join(fixture.root, 'foo_dir'), { recursive: true });
  return fixture;
}

describe('/ls 符号链接与坏条目（B5）', () => {
  // 目录链接走 linkDir：win32 无符号链接特权时自动降级 junction，Dirent 语义与真符号
  // 链接等价 → 本用例在任意宿主都真跑，不需要门控（tests/lib/fs-links.ts 有论证）。
  it('链接目录按目标归类：可进入（旧实现 Dirent 报不出类型 → 整条丢失）', () => {
    const { router, root } = makeFixture({ dirs: ['real_dir'], files: ['target.txt'] });
    fs.writeFileSync(path.join(root, 'target.txt'), 'hello world!');
    linkDir(path.join(root, 'real_dir'), path.join(root, 'link_dir'));

    const card = lsCardOf(router);
    const text = allText(card);
    // 旧实现：Dirent.isSymbolicLink 既不是 dir 也不是 file → 链接根本不出现
    expect(text).toContain('link_dir');
    expect(text).toContain('共 2 目录, 1 文件');
    // 链接目录归类为目录才会带 ls.browse（点进去）；文件按钮才是 ls.file
    const browsePaths = payloadsForCmd(card, 'ls.browse', 'button').map((v) =>
      String(v.path ?? ''),
    );
    expect(browsePaths).toContain(path.join(root, 'link_dir'));
    expectNoV1ActionContainer(card);
  });

  // 文件链接没有免特权的等价物（junction 只支持目录，硬链接不是 reparse point）→
  // 无 SeCreateSymbolicLinkPrivilege 的 win32 上进能力探测门控（有特权的 win32 与 posix 照跑）。
  it.skipIf(!canLinkFiles())('链接文件按目标归类：带大小', () => {
    const { router, root } = makeFixture({ files: ['target.txt'] });
    fs.writeFileSync(path.join(root, 'target.txt'), 'hello world!');
    linkFile(path.join(root, 'target.txt'), path.join(root, 'link_file.txt'));

    const text = allText(lsCardOf(router));
    expect(text).toContain('link_file.txt');
    expect(text).toContain('共 0 目录, 2 文件');
    // 大小取自 stat 解析的目标（12B），不是 lstat 的链接本身
    expect(text).toContain('link_file.txt (12B)');
  });

  // 悬空链接走 linkDangling：junction 建链不校验目标存在，win32 上同语义可见 → 不门控。
  it('悬空符号链接照常列出，不让整次 /ls 变成「读取目录失败」', () => {
    const { router, root } = makeFixture({ files: ['keep.txt'] });
    linkDangling(path.join(root, 'nowhere.bin'), path.join(root, 'dangling.bin'));

    const text = allText(lsCardOf(router));
    // stat 失败只让该条目降级（无大小），其余条目必须还在
    expect(text).toContain('dangling.bin');
    expect(text).toContain('keep.txt');
    expect(text).toContain('共 0 目录, 2 文件');
    expect(text).not.toContain('读取目录失败');
  });
});
