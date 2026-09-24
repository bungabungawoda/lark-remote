/**
 * 文件系统链接 fixture helper（跨平台）。
 *
 * 背景（2026-09-21）：`fs.symlinkSync` 在 Windows 上需要
 * `SeCreateSymbolicLinkPrivilege`——未开开发者模式 / 非管理员的机器直接 `EPERM`；
 * 受限环境（实测 WorkBuddy 沙箱）更隐蔽：调用返回成功，但链接并没有落盘。
 * 这类「真·OS 原语缺失」不能靠 mock 绕开——被测对象就是链接本身。因此分两路：
 *
 * 1. **目录链接 / 悬空链接 → {@link linkDir} / {@link linkDangling}**：无特权时降级
 *    junction（实测 win32 上 dirent 语义与真符号链接**逐项一致**：`isSymbolicLink()`
 *    为 true、`isDirectory()`/`isFile()` 为 false；且 junction 建链不校验目标是否存在，
 *    指向不存在的路径时 `statSync` 照抛 `ENOENT`）。这正是「Dirent 报不出类型、必须
 *    stat 解析、且 stat 可能失败」的语义，因此这类用例在任意宿主都真跑，**不需要门控**。
 * 2. **文件链接 → {@link canLinkFiles} 能力探测门控**：没有免特权的等价物（junction
 *    只支持目录；硬链接不是 reparse point，`Dirent` 与 lstat 语义都不同），只能探测。
 *    有特权的 win32 与 posix 照常跑，无特权 win32 显式 skip。
 *
 * 链接一律「创建 + 回读校验」，不看是否抛异常：对「假成功」的环境也能得到正确结论。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmRf } from './tmp-cleanup.js';

/** 链接实际落成的东西（junction 只在无特权 win32 上出现）。 */
export type LinkKind = 'symlink' | 'junction';

/** 回读校验：只有它返回 true 才认这条链接「真的按预期建成了」。 */
type LinkVerifier = (linkPath: string) => boolean;

function isVisibleLink(linkPath: string): boolean {
  try {
    return fs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function statThrows(linkPath: string): boolean {
  try {
    fs.statSync(linkPath);
    return false;
  } catch {
    return true;
  }
}

/**
 * 建链接：先试真符号链接（posix 与有特权的 win32 行为与手写 `symlinkSync` 完全一致），
 * 失败或「假成功」时在 win32 上退回 junction。
 *
 * @throws 两种形态都建不出来时抛错——那说明环境连 junction 都不支持，用例需要门控，
 *         而不是静默降级成「条目不存在」的假绿。
 */
function createLink(target: string, linkPath: string, verify: LinkVerifier): LinkKind {
  if (isVisibleLink(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true });

  try {
    fs.symlinkSync(target, linkPath);
    if (verify(linkPath)) return 'symlink';
  } catch {
    /* 落到 junction 分支（仅 win32 可能成功） */
  }
  if (process.platform !== 'win32') {
    throw new Error(`无法创建符号链接: ${linkPath} -> ${target}`);
  }

  try {
    fs.symlinkSync(target, linkPath, 'junction');
  } catch (err) {
    throw new Error(`无法创建链接（符号链接与 junction 均失败）: ${linkPath} -> ${target}`, {
      cause: err,
    });
  }
  if (!verify(linkPath)) {
    throw new Error(`链接创建返回成功但未落盘或语义不符: ${linkPath} -> ${target}`);
  }
  return 'junction';
}

/** 建一条**目录链接**（`link_dir` → `real_dir`）。 */
export function linkDir(targetDir: string, linkPath: string): LinkKind {
  return createLink(targetDir, linkPath, (p) => {
    if (!isVisibleLink(p)) return false;
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** 建一条**悬空链接**（`dangling.bin` → 不存在的 `nowhere.bin`）。 */
export function linkDangling(targetPath: string, linkPath: string): LinkKind {
  return createLink(targetPath, linkPath, (p) => isVisibleLink(p) && statThrows(p));
}

/**
 * 建一条**文件链接**（`link_file.txt` → `target.txt`）。
 *
 * 前置条件：{@link canLinkFiles} 为 true（没门控就调用，这里会抛错——避免用例
 * 静默退化成「文件不存在」的假绿）。
 */
export function linkFile(targetFile: string, linkPath: string): void {
  createLink(targetFile, linkPath, (p) => {
    if (!isVisibleLink(p)) return false;
    try {
      return !fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

let cachedFileLinkSupport: boolean | undefined;

/**
 * 文件链接能力探测（进程内缓存）：win32 上要 `SeCreateSymbolicLinkPrivilege`
 * （开发者模式 / 管理员），posix 天然支持。
 */
export function canLinkFiles(): boolean {
  if (cachedFileLinkSupport !== undefined) return cachedFileLinkSupport;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-links-probe-'));
  try {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'hello world!');
    linkFile(target, path.join(dir, 'link.txt'));
    cachedFileLinkSupport = true;
  } catch {
    cachedFileLinkSupport = false;
  } finally {
    rmRf(dir);
  }
  return cachedFileLinkSupport;
}
