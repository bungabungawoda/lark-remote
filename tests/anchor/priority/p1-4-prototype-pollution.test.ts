import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, setConfigValue, getConfigValue } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-proto-anchor-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const VALID_CONFIG = `feishu:
  appId: cli_test123
  appSecret: secret_test123

claude:
  binary: claude
  model: claude-opus-4-8
  stopGraceMs: 5000

output:
  showThinking: true
  showToolUse: false
  showToolResult: false
`;

function makeConfig(): { p: string; config: AppConfig } {
  const p = path.join(tmpDir, 'config.yaml');
  fs.writeFileSync(p, VALID_CONFIG, 'utf-8');
  return { p, config: loadConfig(p) };
}

describe('P1-4 setNestedValue 原型链污染守卫 (anchor)', () => {
  /**
   * 验证什么（target）:
   *   /config 直写路径的 key 是用户自由输入（src/router/index.ts:2811-2815），
   *   setNestedValue 对 `__proto__` 段取值得到 Object.prototype，随后
   *   `current['polluted'] = value` 会污染整个进程的 Object.prototype。
   *   修复后：__proto__ 写路径必须被拒绝，Object.prototype 不得出现新键。
   *
   * 缺失导致什么（importance）:
   *   /config __proto__.polluted yes → 进程 Object.prototype 被污染且不可恢复
   *   （只能重启），用户却看到「设置成功」（review.md §P1-4，已实测确认）。
   *
   * 依据: review.md §P1-4 失败用例。
   */
  it('anchor: __proto__ key 不得污染 Object.prototype', () => {
    const { p, config } = makeConfig();
    // 契约（review.md §P1-4 修复建议）：危险段抛错拒绝；即便执行也不得污染。
    expect(() => setConfigValue(p, config, '__proto__.polluted', 'yes')).toThrow();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  /**
   * 验证什么（target）:
   *   constructor/prototype/__proto__ 段必须抛错拒绝（含删除路径 deleteNestedValue
   *   与读取路径 getConfigValue），不能静默写入垃圾键或返回原型对象。
   */
  it('anchor: constructor/prototype/__proto__ 段写/删/读一律拒绝', () => {
    const { p, config } = makeConfig();
    expect(() => setConfigValue(p, config, 'constructor.prototype.x', '1')).toThrow();
    expect(() => setConfigValue(p, config, 'prototype.x', '1')).toThrow();
    // 删除路径（value=undefined 走 deleteNestedValue）
    expect(() => setConfigValue(p, config, '__proto__.polluted', undefined)).toThrow();
    // 读取路径
    expect(() => getConfigValue(config, 'constructor.prototype.x')).toThrow();
  });
});
