import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { CommandRouter } from './index.js';
import { Bridge } from '../bridge/index.js';
import { SessionStore } from '../session/index.js';
import { AppConfigSchema } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import type { Runner } from '../runner/index.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
  createStubSessionReaderRegistry,
} from '../../tests/lib/bridge-stubs.js';

const tmpDir = fs.realpathSync(os.tmpdir());

function createRouter(overrides?: {
  devMode?: boolean;
  updateCachePath?: string;
  restartSpawner?: () => number;
  exitHandler?: () => void;
  checkLatestVersion?: () => Promise<{ current: string; latest: string }>;
  isNewer?: (current: string, latest: string) => boolean | null;
  runInstallLatest?: () => Promise<{ success: boolean; error?: string }>;
}) {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const runner: Runner = createStubRunner({ withStatusInfo: true });
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
  });
  const router = new CommandRouter({
    sessionStore,
    bridge: new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    }),
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    workspacePath: path.join(tmpDir, 'workspace.json'),
    exitHandler: overrides?.exitHandler ?? (() => {}),
    restartSpawner: overrides?.restartSpawner,
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    devMode: overrides?.devMode,
    updateCachePath: overrides?.updateCachePath,
    updateFns: overrides
      ? {
          checkLatestVersion:
            overrides.checkLatestVersion ?? (async () => ({ current: '0.1.0', latest: '0.1.0' })),
          isNewer: overrides.isNewer ?? (() => false),
          runInstallLatest: overrides.runInstallLatest ?? (async () => ({ success: true })),
        }
      : undefined,
  });
  return { router, sessionStore, connector };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('/update command', () => {
  it('shows "already up to date" when no newer version', async () => {
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.1.0' }),
      isNewer: () => false,
    });
    const result = await router.handle('/update', ctx);
    expect(result!.text).toContain('已是最新版本');
  });

  it('shows update available on /update check', async () => {
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      isNewer: () => true,
    });
    const result = await router.handle('/update check', ctx);
    expect(result!.text).toContain('0.2.0');
  });

  it('rejects update in dev mode', async () => {
    const { router } = createRouter({
      devMode: true,
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      isNewer: () => true,
    });
    const result = await router.handle('/update', ctx);
    expect(result!.text).toContain('开发模式');
  });

  it('runs install and restarts when newer version available', async () => {
    let installed = false;
    let restarted = false;
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      isNewer: () => true,
      runInstallLatest: async () => {
        installed = true;
        return { success: true };
      },
      restartSpawner: () => {
        restarted = true;
        return 12345;
      },
    });
    const result = await router.handle('/update', ctx);
    expect(installed).toBe(true);
    expect(restarted).toBe(true);
    expect(result!.text).toContain('0.2.0');
  });

  it('shows error when install fails', async () => {
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      isNewer: () => true,
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
      isNewer: () => true,
    });
    await router.handle('/update check', ctx);
    await router.handle('/update', ctx);
    expect(calls[0].bypassCache).toBe(true);
    expect(calls[1].bypassCache).toBe(false);
    expect(calls[1].cachePath).toBe('/tmp/update-cache.json');
  });

  it('does not restart when install fails', async () => {
    let restarted = false;
    const { router } = createRouter({
      checkLatestVersion: async () => ({ current: '0.1.0', latest: '0.2.0' }),
      isNewer: () => true,
      runInstallLatest: async () => ({
        success: false,
        error: 'network error',
      }),
      restartSpawner: () => {
        restarted = true;
        return 12345;
      },
    });
    await router.handle('/update', ctx);
    expect(restarted).toBe(false);
  });
});
