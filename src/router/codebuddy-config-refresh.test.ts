/**
 * `/config` 打开时的 CodeBuddy 目录刷新编排。
 *
 * 故障形态：切换 CodeBuddy 登录（换账号 / 换区域）后打开 `/config`，卡片
 * 仍是旧账号的模型清单（同步读 5 分钟 TTL 缓存 + 后台刷新不重绘）；下一条
 * 消息才因为旧连接/旧 session 拿到 401。约束：打开 `/config` 就要反映当前
 * 登录，身份变化时同时丢弃旧 session 与 runner。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouterFixture } from '../../tests/lib/router-fixture.js';
import { makeTempDir } from '../../tests/lib/temp-dir.js';
import { rmRf } from '../../tests/lib/tmp-cleanup.js';
import type { CommandContext } from '../bridge/index.js';

/**
 * 编排断言只需要 refreshCodebuddyCatalogForConfig 的返回值；/config 卡片的
 * buildFields 还会 fire-and-forget 点火一次真实目录探针（会 spawn 真 codebuddy
 * --acp）。把这些点火函数一并 stub，测试结果才不依赖机器是否装了 CLI。
 */
vi.mock('../config/codebuddy-catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/codebuddy-catalog.js')>();
  return {
    ...actual,
    refreshCodebuddyCatalogForConfig: vi.fn(),
    refreshCodebuddyCatalog: vi.fn(async () => null),
    warmCodebuddyCatalogCache: vi.fn(),
    warmCodebuddyCatalogWithRegionDetection: vi.fn(),
    ensureCodebuddyRegion: vi.fn(async () => null),
    scheduleCodebuddyRegionRedetect: vi.fn(),
  };
});

import { refreshCodebuddyCatalogForConfig } from '../config/codebuddy-catalog.js';

const ctx: CommandContext = { userId: 'u1', chatId: 'c1', messageId: 'm1' };

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir('cb-config-refresh-');
  vi.mocked(refreshCodebuddyCatalogForConfig).mockReset();
});

afterEach(() => {
  rmRf(tmpDir);
});

function makeRouter(): ReturnType<typeof createRouterFixture> {
  return createRouterFixture({ tmpDir, configPatch: { defaultAgent: 'codebuddy' } });
}

describe('/config 打开时的 CodeBuddy 目录刷新', () => {
  it('渲染卡片前刷新目录；身份变化时重置持久 session 与 runner', async () => {
    vi.mocked(refreshCodebuddyCatalogForConfig).mockResolvedValue({
      catalog: null,
      identityChanged: true,
      region: 'external',
    });
    const { router, bridge } = makeRouter();
    const reset = vi.spyOn(bridge, 'resetCodebuddyRuntime').mockImplementation(() => {});

    await router.handle('/config', ctx);

    expect(refreshCodebuddyCatalogForConfig).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith('u1');
  });

  it('身份未变时只刷新目录，不动会话', async () => {
    vi.mocked(refreshCodebuddyCatalogForConfig).mockResolvedValue({
      catalog: null,
      identityChanged: false,
      region: null,
    });
    const { router, bridge } = makeRouter();
    const reset = vi.spyOn(bridge, 'resetCodebuddyRuntime').mockImplementation(() => {});

    await router.handle('/config', ctx);

    expect(refreshCodebuddyCatalogForConfig).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it('非 CodeBuddy 的默认 agent 不触发 CodeBuddy 目录刷新', async () => {
    const { router } = createRouterFixture({ tmpDir, configPatch: { defaultAgent: 'claude' } });

    await router.handle('/config', ctx);

    expect(refreshCodebuddyCatalogForConfig).not.toHaveBeenCalled();
  });
});
