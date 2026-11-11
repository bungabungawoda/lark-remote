/**
 * /ls 目录卡：从第 N 页进入子目录后，「上级」/「返回」必须回到第 N 页。
 *
 * 旧行为：ls.browse 永远以 offset=0 重绘目标目录，翻到第 2 页进子目录再返回，
 * 父目录被打回第 1 页，用户得重新翻页。
 *
 * 契约：浏览痕（trail）随卡片 callback value 传递（服务端零状态）：
 * 进入子目录时把来源目录的当前页记进新卡；「上级/返回」按目标目录取回原页。
 * 本用例全程点卡片上真实渲染出的按钮 payload，不手写 callback 常量。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CommandRouter } from './index.js';
import type { CardActionPayload } from './index.js';
import { SessionStore } from '../session/index.js';
import type { AppConfig } from '../config/index.js';
import { AppConfigSchema } from '../config/index.js';
import {
  createStubConnector,
  createStubRunner,
  createStubSessionReaderRegistry,
} from '../../tests/lib/bridge-stubs.js';
import { createRouterFixture } from '../../tests/lib/router-fixture.js';
import { makeTempDir } from '../../tests/lib/temp-dir.js';

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

type CardEl = {
  tag?: string;
  text?: { content?: string };
  elements?: CardEl[];
  columns?: CardEl[];
  behaviors?: Array<{ type?: string; value?: CardActionPayload }>;
};

type Card = { body?: { elements?: CardEl[] } };

function flatten(els: CardEl[]): CardEl[] {
  const out: CardEl[] = [];
  for (const el of els) {
    out.push(el);
    for (const col of el.columns ?? []) out.push(...flatten(col.elements ?? []));
    out.push(...flatten(el.elements ?? []));
  }
  return out;
}

function bodyOf(card: Card): CardEl[] {
  return card.body?.elements ?? [];
}

function allText(card: Card): string {
  return flatten(bodyOf(card))
    .map((el) => el.text?.content ?? '')
    .join('\n');
}

function payloadOf(el: CardEl): CardActionPayload | undefined {
  return el.behaviors?.find((b) => b.type === 'callback')?.value;
}

function buttonByText(card: Card, label: string): CardActionPayload {
  const el = flatten(bodyOf(card)).find(
    (candidate) => candidate.tag === 'button' && candidate.text?.content === label,
  );
  expect(el, `卡片上没有「${label}」按钮`).toBeDefined();
  return payloadOf(el!)!;
}

function buttonByPath(card: Card, cmd: string, targetPath: string): CardActionPayload {
  const el = flatten(bodyOf(card)).find((candidate) => {
    const value = payloadOf(candidate);
    return candidate.tag === 'button' && value?.cmd === cmd && value.path === targetPath;
  });
  expect(el, `卡片上没有指向 ${targetPath} 的 ${cmd} 按钮`).toBeDefined();
  return payloadOf(el!)!;
}

function makeFixture() {
  const root = fs.realpathSync(makeTempDir('ls-return-page-'));
  // 根目录 35 个目录：2 页（第 2 页 d30..d34）。
  for (let i = 0; i < 35; i++) fs.mkdirSync(path.join(root, `d${String(i).padStart(2, '0')}`));
  // d30 也有 35 个子目录：它自己也能翻到第 2 页。
  for (let i = 0; i < 35; i++) {
    fs.mkdirSync(path.join(root, 'd30', `e${String(i).padStart(2, '0')}`));
  }
  const sessionStore = new SessionStore();
  sessionStore.setCwd('user1', root);
  const connector = createStubConnector();
  const config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'claude-test-model', stopGraceMs: 5000 },
  }) as AppConfig;
  const { router } = createRouterFixture({
    tmpDir: root,
    config,
    connector,
    runner: createStubRunner({ withStatusInfo: true }),
    sessionStore,
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    routerOpts: { workspacePath: path.join(root, 'workspace.json') },
  });
  return { router, connector, root };
}

function lastUpdatedCard(connector: ReturnType<typeof createStubConnector>): Card {
  expect(connector._updates.length, '卡片没有原地刷新').toBeGreaterThan(0);
  return connector._updates.at(-1)!.card as Card;
}

async function click(router: CommandRouter, value: CardActionPayload): Promise<void> {
  await router.handleCardAction(value, ctx);
}

/** 根目录第 1 页 → 点真实「下一页」按钮 → 第 2 页卡片。 */
async function gotoRootPage2(
  router: CommandRouter,
  connector: ReturnType<typeof createStubConnector>,
  root: string,
): Promise<Card> {
  const page1 = router.cmdLs([], ctx, 0, root).card as Card;
  expect(allText(page1)).toContain('第 1/2 页');
  const next = buttonByPath(page1, 'ls.page', root);
  expect(next.offset).toBe(30);
  await click(router, next);
  const page2 = lastUpdatedCard(connector);
  expect(allText(page2)).toContain('第 2/2 页');
  return page2;
}

describe('/ls 进入子目录后返回原页', () => {
  it('从第 2 页进入子目录，点「上级」回到父目录第 2 页', async () => {
    const { router, connector, root } = makeFixture();
    const page2 = await gotoRootPage2(router, connector, root);

    const child = path.join(root, 'd30');
    await click(router, buttonByPath(page2, 'ls.browse', child));
    expect(allText(lastUpdatedCard(connector))).toContain('d30');

    await click(router, buttonByText(lastUpdatedCard(connector), '上级'));
    const restored = allText(lastUpdatedCard(connector));
    expect(restored).toContain('第 2/2 页');
    expect(restored).toContain('d30');
    expect(restored).not.toContain('d00');
  });

  it('点「返回」同样回到本次 /ls 起点的原页', async () => {
    const { router, connector, root } = makeFixture();
    const page2 = await gotoRootPage2(router, connector, root);

    await click(router, buttonByPath(page2, 'ls.browse', path.join(root, 'd30')));
    await click(router, buttonByText(lastUpdatedCard(connector), '返回'));

    const restored = allText(lastUpdatedCard(connector));
    expect(restored).toContain('第 2/2 页');
    expect(restored).toContain('d30');
  });

  it('两级下钻：逐级「上级」回到各层离开时所在的页', async () => {
    const { router, connector, root } = makeFixture();
    const page2 = await gotoRootPage2(router, connector, root);

    // 根第 2 页 → d30（当前页 0）→ d30 第 2 页 → e30
    await click(router, buttonByPath(page2, 'ls.browse', path.join(root, 'd30')));
    const d30Page1 = lastUpdatedCard(connector);
    await click(router, buttonByPath(d30Page1, 'ls.page', path.join(root, 'd30')));
    const d30Page2 = lastUpdatedCard(connector);
    expect(allText(d30Page2)).toContain('第 2/2 页');
    await click(router, buttonByPath(d30Page2, 'ls.browse', path.join(root, 'd30', 'e30')));

    // e30 → 上级：d30 第 2 页
    await click(router, buttonByText(lastUpdatedCard(connector), '上级'));
    const backToD30 = allText(lastUpdatedCard(connector));
    expect(backToD30).toContain('第 2/2 页');
    expect(backToD30).toContain('e30');

    // d30 → 上级：根目录第 2 页
    await click(router, buttonByText(lastUpdatedCard(connector), '上级'));
    const backToRoot = allText(lastUpdatedCard(connector));
    expect(backToRoot).toContain('第 2/2 页');
    expect(backToRoot).toContain('d30');
  });

  it('深层「返回」直接回到根目录时也取回根的原页', async () => {
    const { router, connector, root } = makeFixture();
    const page2 = await gotoRootPage2(router, connector, root);

    await click(router, buttonByPath(page2, 'ls.browse', path.join(root, 'd30')));
    await click(
      router,
      buttonByPath(lastUpdatedCard(connector), 'ls.page', path.join(root, 'd30')),
    );
    await click(
      router,
      buttonByPath(lastUpdatedCard(connector), 'ls.browse', path.join(root, 'd30', 'e30')),
    );
    await click(router, buttonByText(lastUpdatedCard(connector), '返回'));

    const restored = allText(lastUpdatedCard(connector));
    expect(restored).toContain('第 2/2 页');
    expect(restored).toContain('d30');
  });
});
