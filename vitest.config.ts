import { defineConfig } from 'vitest/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import os from 'node:os';

const classification: Record<string, string[]> = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'test-classification.json'), 'utf-8'),
);

const exclude = ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', '**/.claude/worktrees/**'];

// Windows 上 spawn 子进程 + 首次模块加载在受限环境可达 7-10s，默认 5s
// 会把一批 spawn 型用例误判为超时（posix 上无感，富余只是吃不到）。
const WIN_SPAWN_TIMEOUT = 20_000;

// 每个 worker 的 V8 老生代堆上限（MB）。Vitest 4 只有顶层 execArgv 真正下发到
// worker；旧配置里的 `heap` / `heapLimit` 不是 vitest 选项，一直被静默忽略。
const WORKER_HEAP_MB = Number(process.env.VITEST_WORKER_HEAP_MB ?? 512);

// 并行度上限：Windows 上并发 spawn 子进程会抖动，worker 太多反而更慢。
// 用 threads pool（避免为每份用例 fork 一个 node 进程——Windows fork 启动极慢），
// worker 数控制在「CPU 数 - 1」且最多 8 个。
// 内存预算 = WORKER_HEAP_MB × maxWorkers（默认 512MB × 8 = 4GB 上限）。
// 机器内存紧张时用 VITEST_WORKER_HEAP_MB / VITEST_MAX_WORKERS 调低。
const maxWorkers = Math.max(
  1,
  Math.min(Number(process.env.VITEST_MAX_WORKERS ?? os.cpus().length - 1), 8),
);

function makeProject(name: string, includes: string[]) {
  const isLive = name === 'live';
  return {
    test: {
      name,
      include: includes,
      exclude,
      testTimeout: WIN_SPAWN_TIMEOUT,
      hookTimeout: WIN_SPAWN_TIMEOUT,
      // live 套件命中真实飞书 API 且共享 ~/.lark-remote-test，必须串行，否则会
      // 互相踩配置目录、触发真实副作用。注意 Vitest 4 已无 `singleFork`/`minWorkers`
      // （旧配置里的 singleFork 是空操作），串行靠 maxWorkers:1 + fileParallelism:false。
      ...(isLive ? { maxWorkers: 1, fileParallelism: false } : {}),
    },
  };
}

export default defineConfig({
  test: {
    projects: Object.entries(classification).map(([name, includes]) => makeProject(name, includes)),
    // 关键优化：threads pool + 多 worker 并行，取代原先 maxWorkers:1 的纯串行。
    pool: 'threads',
    maxWorkers,
    // 真正生效的内存上限：每个 worker 的 V8 堆封顶，避免多 worker 并行时打爆内存。
    execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
