import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mockLogger } from '../../lib/logger-mock.js';

/**
 * Red Agent - Round 13 - Anchor (P3-4, review finding → anchor)
 *
 * Target: catalog 模式下修改 models.json（内容 + mtime 变化）后，getCodexCatalogModels
 * 必须重新执行 `codex debug models`，不能继续返回 1h TTL 内的旧缓存——否则卡片最长 1 小时
 * 显示过期模型列表（如新加的模型看不到、删掉的模型还挂着）。
 *
 * Importance: models.json 是用户经常手改的文件；卡片列表过期会误导选择。
 *
 * Spec basis: P3-4（review 发现）。
 */

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

vi.mock('../../../src/platform/spawn.js', () => ({
  // 兼容历史 mock 形态：返回 string/Buffer 视为成功 stdout，抛错/其余原样穿透
  spawnProcessSync: (...args: any[]) => {
    const v = mockSpawnSync(...args);
    if (typeof v === 'string' || Buffer.isBuffer(v)) {
      return { status: 0, stdout: v, stderr: '' };
    }
    return v;
  },
  spawnProcess: () => {
    throw new Error('anchor test must not spawn async');
  },
}));
vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

import {
  getCodexCatalogModels,
  invalidateCodexBundledCache,
} from '../../../src/config/codex-config.js';
import { makeModel, makeCatalog } from '../../fixtures/codex-catalog-fixture.js';

function catalogJson(slug: string): string {
  return makeCatalog([makeModel(slug, [{ effort: 'low' }], { default_reasoning_level: 'high' })]);
}

describe('codex catalog cache freshness - anchor', () => {
  let tmpDir: string;
  let oldCodexHome: string | undefined;
  let modelsPath: string;

  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockLogger.warn.mockReset();
    invalidateCodexBundledCache();
    oldCodexHome = process.env.CODEX_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fresh-'));
    modelsPath = path.join(tmpDir, 'models.json');
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      [
        'model = "deepseek-v4-flash"',
        `model_catalog_json = "${modelsPath.replaceAll('\\', '/')}"`,
        '',
      ].join('\n'),
    );
    fs.writeFileSync(modelsPath, catalogJson('deepseek-v4-flash'));
    process.env.CODEX_HOME = tmpDir;
    // mock 直接返回 models.json 当前内容（等价于真实 codex debug models 的输出）
    mockSpawnSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'debug' && args[1] === 'models' && !args.includes('--bundled')) {
        return fs.readFileSync(modelsPath, 'utf-8');
      }
      return JSON.stringify({ models: [] });
    });
  });

  afterEach(() => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateCodexBundledCache();
  });

  it('test_anchor_catalog_cache_invalidated_when_models_json_changes', () => {
    // 固定首个 mtime，保证缓存键确定性
    const t1 = new Date('2026-08-01T00:00:00Z');
    const t2 = new Date('2026-08-01T00:01:00Z');
    fs.utimesSync(modelsPath, t1, t1);

    // 首次读取
    const first = getCodexCatalogModels();
    expect(first.map((m) => m.slug)).toEqual(['deepseek-v4-flash']);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);

    // 修改 models.json（换模型 + 显式推进 mtime）→ 必须重新执行命令，不得命中旧缓存
    fs.writeFileSync(modelsPath, catalogJson('deepseek-v4-pro'));
    fs.utimesSync(modelsPath, t2, t2);
    const second = getCodexCatalogModels();
    expect(second.map((m) => m.slug)).toEqual(['deepseek-v4-pro']);
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });
});
