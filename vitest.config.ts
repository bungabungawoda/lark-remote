import { defineConfig } from 'vitest/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const classification: Record<string, string[]> = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'test-classification.json'), 'utf-8'),
);

const exclude = ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', '**/.claude/worktrees/**'];

function makeProject(name: string, includes: string[]) {
  return { test: { name, include: includes, exclude } };
}

export default defineConfig({
  test: {
    projects: Object.entries(classification).map(([name, includes]) =>
      makeProject(name, includes),
    ),
    maxWorkers: 1,
    singleFork: true,
    heap: true,
    heapLimit: 512, // MB
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
