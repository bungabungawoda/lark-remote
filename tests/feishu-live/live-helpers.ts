/**
 * Shared live-test guards for the FEISHU_LIVE_TEST integration suites.
 *
 * All 7 tests/feishu-live suites previously duplicated TEST_CONFIG_DIR /
 * configPath / skipIfNoConfig / describeLive. This module is the single
 * definition; it is not a *.test.ts so vitest never collects it.
 *
 * Live suites only run with FEISHU_LIVE_TEST=1 and use ~/.lark-remote-test
 * so they never touch the real user config.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

/** Independent test config directory, isolated from the real one. */
export const TEST_CONFIG_DIR = path.join(os.homedir(), '.lark-remote-test');
export const configPath = path.join(TEST_CONFIG_DIR, 'config.yaml');

/**
 * Returns true (and logs why) when the live config is unavailable or lacks
 * Feishu credentials, so the caller can skip its before-each.
 */
export function skipIfNoConfig(): boolean {
  if (!fs.existsSync(configPath)) {
    console.log(`⚠️ 跳过：配置不存在 ${configPath}`);
    return true;
  }
  try {
    const cfg = loadConfig(configPath);
    if (!cfg.feishu?.appId || !cfg.feishu?.appSecret) {
      console.log('⚠️ 跳过：配置中缺少飞书凭据');
      return true;
    }
    return false;
  } catch (err) {
    console.log(`⚠️ 跳过：配置加载失败 ${err}`);
    return true;
  }
}

/** describe that only runs live suites when FEISHU_LIVE_TEST=1. */
export const describeLive = process.env.FEISHU_LIVE_TEST ? describe : describe.skip;
