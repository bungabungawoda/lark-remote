/**
 * src/index.ts 装配线的源码级守卫（单文件收口）。
 *
 * 这些契约都发生在 main() 的不可注入接线处（进程级异常处理器、ConfigDir 派生
 * 路径、agent 工厂闭包），无法用行为测试覆盖，只能钉源码形态。此前这类静态断言
 * 散落在三个守卫文件里，本轮集中到这里（`src/order/orders-path.test.ts` 仍从
 * 行为侧守着 ordersPath 那一条），让「静态守卫一共守着哪几条契约」一眼可数。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const indexSource = fs.readFileSync(path.join(import.meta.dirname, '../../src/index.ts'), 'utf-8');

describe('index.ts 全局异常处理器', () => {
  it('注册 uncaughtException 处理器', () => {
    expect(indexSource).toMatch(/process\.on\(['"]uncaughtException['"]/);
  });

  it('注册 unhandledRejection 处理器', () => {
    expect(indexSource).toMatch(/process\.on\(['"]unhandledRejection['"]/);
  });
});

describe('index.ts CommandRouter 的 ordersPath', () => {
  it('ordersPath 必须由 configDir 派生（缺省会回落到 ~/.lark-remote/orders.json）', () => {
    expect(
      indexSource,
      'index.ts must pass ordersPath: path.join(configDir, "orders.json") to CommandRouter',
    ).toMatch(/ordersPath\s*:\s*path\.join\s*\(\s*configDir\s*,\s*["']orders\.json["']\s*\)/);
  });
});

describe('index.ts agent 工厂的 cwd 透传', () => {
  it('claude / pi 两个 spawn 型工厂各传一次 cwd: ws；opencode / kimi 走 ACP 注册', () => {
    // pid 文件必须按 cwd 隔离，否则 cwd B 的 killOrphan 会误杀 cwd A 的 run。
    const occurrences = indexSource.match(/cwd:\s*ws/g) ?? [];
    expect(occurrences).toHaveLength(2);
    expect(indexSource).toMatch(/register\('opencode'[\s\S]*?new OpencodeAcpRunner\(/);
    expect(indexSource).toMatch(/register\('kimi'[\s\S]*?new KimiAcpRunner\(/);
  });
});
