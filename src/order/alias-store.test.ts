import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AliasStore,
  MAX_ALIASES,
  MAX_ALIAS_NAME_LENGTH,
  MAX_ALIAS_TEXT_LENGTH,
} from './alias-store.js';

let tmpDir: string;
let aliasesFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-alias-store-'));
  aliasesFile = path.join(tmpDir, 'aliases.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AliasStore', () => {
  it('set / get / list / has / remove', () => {
    const store = new AliasStore(aliasesFile);
    store.set('fix', '请修复报错');
    store.set('h', '请读取文件并分析');

    expect(store.has('fix')).toBe(true);
    expect(store.get('fix')).toMatchObject({ name: 'fix', text: '请修复报错' });
    expect(store.list()).toHaveLength(2);

    expect(store.remove('fix')).toBe(true);
    expect(store.remove('fix')).toBe(false);
    expect(store.has('fix')).toBe(false);
  });

  it('同名注册为更新，保留 createdAt', () => {
    const store = new AliasStore(aliasesFile);
    store.set('fix', 'v1');
    const created = store.get('fix')!.createdAt;
    store.set('fix', 'v2');
    expect(store.get('fix')!.text).toBe('v2');
    expect(store.get('fix')!.createdAt).toBe(created);
    expect(store.list()).toHaveLength(1);
  });

  it('持久化到磁盘并可 reload 恢复', () => {
    const store = new AliasStore(aliasesFile);
    store.set('fix', '请修复报错');
    store.set('h', '请读取文件');

    const reloaded = new AliasStore(aliasesFile);
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.get('fix')!.text).toBe('请修复报错');
  });

  it('损坏文件恢复为空（不抛错）', () => {
    fs.writeFileSync(aliasesFile, '{corrupt json!!');
    const store = new AliasStore(aliasesFile);
    expect(store.list()).toEqual([]);
  });

  it('加载时过滤非法条目（数字开头名称、超长名称）', () => {
    fs.writeFileSync(
      aliasesFile,
      JSON.stringify([
        { name: 'fix', text: 'ok', createdAt: '2026-01-01T00:00:00.000Z' },
        { name: '500', text: 'bad', createdAt: '2026-01-01T00:00:00.000Z' },
        {
          name: 'x'.repeat(MAX_ALIAS_NAME_LENGTH + 1),
          text: 'bad',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        { name: 'ok', text: 'no createdAt' },
      ]),
    );
    const store = new AliasStore(aliasesFile);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].name).toBe('fix');
  });

  it('名称规则：不能数字开头、只能字母数字下划线', () => {
    const store = new AliasStore(aliasesFile);
    expect(() => store.set('500', 'x')).toThrow();
    expect(() => store.set('bad-name', 'x')).toThrow();
    expect(() => store.set('has space', 'x')).toThrow();
    store.set('_ok', 'x');
    store.set('Fix2', 'x');
    expect(store.has('_ok')).toBe(true);
    expect(store.has('Fix2')).toBe(true);
  });

  it('名称/文本长度上限', () => {
    const store = new AliasStore(aliasesFile);
    expect(() => store.set('x'.repeat(MAX_ALIAS_NAME_LENGTH + 1), 'ok')).toThrow();
    expect(() => store.set('ok', 'x'.repeat(MAX_ALIAS_TEXT_LENGTH + 1))).toThrow();
    store.set('ok', 'x'.repeat(MAX_ALIAS_TEXT_LENGTH));
    expect(store.get('ok')!.text).toHaveLength(MAX_ALIAS_TEXT_LENGTH);
  });

  it('数量上限 50', () => {
    const store = new AliasStore(aliasesFile);
    for (let i = 0; i < MAX_ALIASES; i += 1) {
      store.set(`a${i}`, 'text');
    }
    expect(() => store.set('overflow', 'text')).toThrow(/上限/);
    // 更新已有条目不受数量上限影响
    store.set('a0', 'updated');
    expect(store.list()).toHaveLength(MAX_ALIASES);
  });
});
