/**
 * Probe: verify deleting the last item of the last page never yields an empty
 * page card (regression for the review finding "末页删空空卡").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OrderStore } from '../../../src/order/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import { createStubRunner } from '../../lib/bridge-stubs.js';
import { createRouterFixture } from '../../lib/router-fixture.js';

let tmpDir: string;
let ordersFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-probe-'));
  ordersFile = path.join(tmpDir, 'orders.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRouter() {
  return createRouterFixture({
    tmpDir,
    runner: createStubRunner({ mode: 'empty' }),
    config: AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
    }),
    routerOpts: { ordersPath: ordersFile },
  });
}

describe('order last-page empty regression', () => {
  it('deleting the sole item on the last page re-computes offset to a non-empty page', async () => {
    const store = new OrderStore(ordersFile);
    for (let i = 0; i < 9; i++) store.save(`指令 ${i + 1}`);
    const { router, connector } = createRouter();
    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' } as never;

    // 翻到第 2 页（offset=8，只含 1 条）
    await router.handleCardAction({ cmd: 'order.page', offset: 8 } as never, ctx);
    let lastCard = connector._cards[connector._cards.length - 1];
    expect(JSON.stringify(lastCard)).toContain('第 2/2 页');

    // 删除该页唯一条目 → 剩 8 条 = 1 页，offset=8 越界
    const order9 = store.get()[8];
    await router.handleCardAction(
      { cmd: 'order.delete', orderId: order9.id, offset: 8 } as never,
      ctx,
    );
    lastCard = connector._cards[connector._cards.length - 1];
    const str = JSON.stringify(lastCard);
    // 不能是空页：offset=8 已越界（剩 8 条 = 1 页），应 clamp 回第 1 页。
    // 剩 8 条 ≤ PAGE_SIZE → 无分页栏（hasPagination=false），offset 全部归 0。
    expect(str).toContain('指令 1');
    expect(str).not.toContain('order.page');
    expect(str).not.toContain('offset":8');
  });
});
