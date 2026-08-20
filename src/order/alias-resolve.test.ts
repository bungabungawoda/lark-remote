import { describe, it, expect } from 'vitest';
import { resolveAlias } from './alias-resolve.js';
import type { AliasResolveEntry } from './alias-resolve.js';

const aliases: AliasResolveEntry[] = [
  { name: 'fix', text: '请修复刚才提到的报错并解释原因' },
  { name: 'h', text: '请读取文件并分析' },
  { name: 'cd2', text: '/cd /home/user/project' },
  { name: 'sh', text: '!ls -la' },
];

describe('resolveAlias', () => {
  it('$name 开头匹配已注册别名', () => {
    expect(resolveAlias('$fix', aliases)).toBe('请修复刚才提到的报错并解释原因');
  });

  it('$name 后接参数原样拼接（至少一个空格）', () => {
    expect(resolveAlias('$h /path/to/file.txt', aliases)).toBe(
      '请读取文件并分析 /path/to/file.txt',
    );
    expect(resolveAlias('$h', aliases)).toBe('请读取文件并分析');
  });

  it('大小写敏感：$Fix 不匹配小写 fix 别名', () => {
    expect(resolveAlias('$Fix', aliases)).toBeUndefined();
  });

  it('`!` 开头的 bash 消息不展开（$PATH 保留）', () => {
    expect(resolveAlias('!echo $PATH', aliases)).toBeUndefined();
    expect(resolveAlias('!run $fix', aliases)).toBeUndefined();
  });

  it('`/` 开头的命令不展开（别名不劫持系统命令）', () => {
    expect(resolveAlias('/config', aliases)).toBeUndefined();
    expect(resolveAlias('/order save $fix', aliases)).toBeUndefined();
  });

  it('未知 $xxx 原样透传（返回 undefined）', () => {
    expect(resolveAlias('$unknown_alias hello', aliases)).toBeUndefined();
  });

  it('数字开头的 $500 / $3d 永不匹配', () => {
    expect(resolveAlias('$500 元', aliases)).toBeUndefined();
    expect(resolveAlias('$3d 打印', aliases)).toBeUndefined();
  });

  it('单次展开不递归（展开结果含 $other 不再二次展开）', () => {
    const recursive: AliasResolveEntry[] = [
      { name: 'a', text: '$b 的内容' },
      { name: 'b', text: 'B' },
    ];
    expect(resolveAlias('$a', recursive)).toBe('$b 的内容');
  });

  it('全词精确匹配：$fixx 不匹配 fix', () => {
    expect(resolveAlias('$fixx', aliases)).toBeUndefined();
    expect(resolveAlias('$fix extra', aliases)).toBe('请修复刚才提到的报错并解释原因 extra');
  });

  it('展开结果以 / 开头时保留 / 前缀', () => {
    expect(resolveAlias('$cd2', aliases)).toBe('/cd /home/user/project');
  });

  it('展开结果以 ! 开头时是用户自定义行为（文本保留）', () => {
    expect(resolveAlias('$sh', aliases)).toBe('!ls -la');
  });

  it('裸 $ 或 $ 后无合法名称不匹配', () => {
    expect(resolveAlias('$', aliases)).toBeUndefined();
    expect(resolveAlias('$ 空格开头', aliases)).toBeUndefined();
    expect(resolveAlias('price is $5', aliases)).toBeUndefined();
  });
});
