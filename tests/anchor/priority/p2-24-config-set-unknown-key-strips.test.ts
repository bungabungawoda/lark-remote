import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppConfigSchema, setConfigValues, type AppConfig } from '../../../src/config/index.js';

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  initLogger: () => ({}),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-strip-unknown-anchor-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P2-24 setConfigValues 写盘不得含未知键 (anchor)', () => {
  /**
   * 验证什么（target）:
   *   setConfigValues 接受一个不在 schema 白名单内的 key（如 `foo.bar`）时，
   *   safeParse(draft) 会把未知键从 result.data 剥掉（strip 模式），返回成功。
   *   但当前实现写盘用的是未剥离的 draft（line 360 YAML.stringify(draft)），
   *   导致 `foo.bar: baz` 永久留在 config.yaml 文件里。
   *
   *   期望：写盘文件不得含未知键（应写 result.data 而非 draft）。
   *
   * 依据: review.md §P2-24。
   */
  it('test_anchor_set_config_values_strips_unknown_key_from_yaml', () => {
    // 构造合法最小 config 并写盘
    const validConfig: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test-app', appSecret: 'test-secret' },
    });
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, '', 'utf-8');

    // 调用：注入一个不在 schema 白名单内的 key
    setConfigValues(configPath, validConfig, { 'foo.bar': 'baz' });

    // 读回写盘的 config.yaml 内容
    const yamlContent = fs.readFileSync(configPath, 'utf-8');

    // 期望：写盘文件不得含未知键 foo.bar / 顶层 foo / 字面 baz
    expect(yamlContent).not.toContain('baz');
    expect(yamlContent).not.toContain('foo.bar');
    expect(yamlContent).not.toMatch(/^\s*foo:\s*$/m);
  });
});
