import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import { AppConfigSchema } from '../config/index.js';
import { createStubRunner } from '../../tests/lib/bridge-stubs.js';
import { createRouterFixture } from '../../tests/lib/router-fixture.js';

const tmpDir = fs.realpathSync(os.tmpdir());

function createRouter(overrides?: {
  devMode?: boolean;
  updateCachePath?: string;
  restartSpawner?: () => number;
  exitHandler?: () => void;
  checkLatestVersion?: (opts?: {
    cachePath?: string;
    bypassCache?: boolean;
  }) => Promise<{ current: string; latest: string }>;
  compareVersions?: (current: string, latest: string) => -1 | 0 | 1 | null;
  runInstallLatest?: () => Promise<{ success: boolean; error?: string }>;
}) {
  return createRouterFixture({
    tmpDir,
    runner: createStubRunner({ withStatusInfo: true }),
    config: AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
    }),
    routerOpts: {
      devMode: overrides?.devMode,
      updateCachePath: overrides?.updateCachePath,
      exitHandler: overrides?.exitHandler ?? (() => {}),
      restartSpawner: overrides?.restartSpawner,
      updateFns: overrides
        ? {
            checkLatestVersion:
              overrides.checkLatestVersion ?? (async () => ({ current: '0.1.0', latest: '0.1.0' })),
            compareVersions: overrides.compareVersions ?? (() => 0),
            runInstallLatest: overrides.runInstallLatest ?? (async () => ({ success: true })),
          }
        : undefined,
    },
  });
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('/update command', () => {
  it('shows "already up to date" when no newer version', async () => {
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.1.0' }),
      compareVersions: () => 0,
    });
    const result = await router.handle('/update', ctx);
    expect(result!.text).toContain('已是最新版本');
  });

  it('shows update available on /update check', async () => {
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      compareVersions: () => 1,
    });
    const result = await router.handle('/update check', ctx);
    expect(result!.text).toContain('0.2.0');
  });

  it('rejects update in dev mode', async () => {
    const { router } = createRouter({
      devMode: true,
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      compareVersions: () => 1,
    });
    const result = await router.handle('/update', ctx);
    expect(result!.text).toContain('开发模式');
  });

  it('runs install and reports success (no auto-restart)', async () => {
    let installed = false;
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      compareVersions: () => 1,
      runInstallLatest: async () => {
        installed = true;
        return { success: true };
      },
    });
    const result = await router.handle('/update', ctx);
    expect(installed).toBe(true);
    expect(result!.text).toContain('0.2.0');
    expect(result!.text).toContain('/restart');
    expect(result!.text).not.toContain('正在重启');
  });

  it('shows error when install fails', async () => {
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      compareVersions: () => 1,
      runInstallLatest: async () => ({
        success: false,
        error: 'permission denied',
      }),
    });
    const result = await router.handle('/update', ctx);
    expect(result!.text).toContain('升级失败');
  });

  it('uses cache for /update and bypasses cache for /update check', async () => {
    const calls: Array<{ cachePath?: string; bypassCache?: boolean }> = [];
    const { router } = createRouter({
      updateCachePath: '/tmp/update-cache.json',
      checkLatestVersion: async (opts) => {
        calls.push(opts ?? {});
        return { current: '0.1.0', latest: '0.2.0' };
      },
      compareVersions: () => 1,
    });
    await router.handle('/update check', ctx);
    await router.handle('/update', ctx);
    expect(calls[0].bypassCache).toBe(true);
    expect(calls[1].bypassCache).toBe(false);
    expect(calls[1].cachePath).toBe('/tmp/update-cache.json');
  });

  it('does not auto-restart when install fails', async () => {
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      compareVersions: () => 1,
      runInstallLatest: async () => ({
        success: false,
        error: 'network error',
      }),
    });
    const result = await router.handle('/update', ctx);
    expect(result!.text).toContain('升级失败');
  });
});
