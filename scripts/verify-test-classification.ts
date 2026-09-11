#!/usr/bin/env npx tsx
/**
 * verify-test-classification.ts
 *
 * 验证 test-classification.json 的分类映射：
 * 1. 每个 .test.ts 文件至少被一个 project 包含
 * 2. 没有文件被多个 project 包含
 * 3. 映射中的 glob 路径确实匹配到文件
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { globSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

interface Classification {
  [project: string]: string[];
}

const classification: Classification = JSON.parse(
  readFileSync(resolve(root, 'test-classification.json'), 'utf-8'),
);

/**
 * node:fs glob 在 Windows 上返回反斜杠分隔的路径（POSIX 平台才是 `/`），
 * 而本文件里的过滤规则与 test-classification.json 的模式都按 `/` 书写。
 * 统一归一化，让两端的比较在任意平台都成立。
 */
function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/**
 * node:fs glob 的 ignore 选项在 Node 25 上实测完全不生效（globSync 对
 * ignore 模式不排除任何文件），而替代选项 exclude 需要 Node >= 22.13。
 * 这里在 glob 结果上做显式过滤，跨 Node 版本行为一致：排除安装产物、
 * 构建产物与 git worktree 镜像目录。
 */
function isRepoTestFile(rel: string): boolean {
  const posix = toPosix(rel);
  const parts = posix.split('/');
  return (
    !parts.includes('node_modules') &&
    !parts.includes('dist') &&
    !parts.includes('.worktrees') &&
    !posix.startsWith('.claude/worktrees/')
  );
}

/** 归一化 glob 结果，使后续比较与 POSIX 书写的模式一致。 */
function collect(pattern: string): string[] {
  return (globSync(pattern, { cwd: root }) as string[]).map(toPosix).filter(isRepoTestFile).sort();
}

// Collect all test files on disk using node:fs glob
const allTestFiles = collect('**/*.test.ts');

// Expand classification includes into actual files
const projectFiles = new Map<string, Set<string>>();
for (const [project, includes] of Object.entries(classification)) {
  const files = new Set<string>();
  for (const pattern of includes) {
    for (const f of collect(pattern)) {
      files.add(f);
    }
  }
  projectFiles.set(project, files);
}

// Check 1: Every test file is covered by at least one project
const coveredFiles = new Set<string>();
for (const files of projectFiles.values()) {
  for (const f of files) {
    coveredFiles.add(f);
  }
}

const uncovered = allTestFiles.filter((f) => !coveredFiles.has(f));
if (uncovered.length > 0) {
  console.error('❌ UNCOVERED files (not in any project):');
  for (const f of uncovered) {
    console.error(`  ${f}`);
  }
}

// Check 2: No file appears in multiple projects
const fileToProjects = new Map<string, string[]>();
for (const [project, files] of projectFiles) {
  for (const f of files) {
    if (!fileToProjects.has(f)) fileToProjects.set(f, []);
    fileToProjects.get(f)!.push(project);
  }
}

const duplicates = [...fileToProjects.entries()].filter(([, ps]) => ps.length > 1);
if (duplicates.length > 0) {
  console.error('❌ DUPLICATE files (in multiple projects):');
  for (const [f, ps] of duplicates) {
    console.error(`  ${f} → ${ps.join(', ')}`);
  }
}

// Check 3: Patterns that match nothing
const emptyPatterns: string[] = [];
for (const [project, includes] of Object.entries(classification)) {
  for (const pattern of includes) {
    if (collect(pattern).length === 0) {
      emptyPatterns.push(`${project}: ${pattern}`);
    }
  }
}

if (emptyPatterns.length > 0) {
  console.error('⚠️  EMPTY patterns (match no files):');
  for (const p of emptyPatterns) {
    console.error(`  ${p}`);
  }
}

// Summary
const totalOnDisk = allTestFiles.length;
const totalCovered = coveredFiles.size;
console.log(`\n📊 Summary:`);
console.log(`  Total test files on disk: ${totalOnDisk}`);
console.log(`  Files covered by classification: ${totalCovered}`);
console.log(`  Uncovered: ${uncovered.length}`);
console.log(`  Duplicates: ${duplicates.length}`);
console.log(`  Empty patterns: ${emptyPatterns.length}`);

if (uncovered.length === 0 && duplicates.length === 0) {
  console.log('\n✅ All test files are covered with no duplicates.');
  process.exit(0);
} else {
  process.exit(1);
}
