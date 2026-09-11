/**
 * resolveExecutable —— 可执行文件发现。
 *
 * 职责收窄为「探测/诊断」：报告 agent 装在哪、装没装（可用性探测 probe.ts、
 * 自更新安装源检测 update/install.ts）。**执行**统一走 platform/spawn.ts 的
 * cross-spawn 包装（PATHEXT 解析 + .cmd 经 cmd.exe 受控执行），本模块不再
 * 解析 .cmd/.bat 垫片内容——垫片格式是 npm/pnpm 的上游实现细节（历史变过、
 * pnpm 生成形态不同），手写解析器等于耦合该细节（v2 §4.2）。
 *
 * posix：PATH 目录顺序 + X_OK（现状语义迁移）。
 * win32：PATH 目录顺序 × PATHEXT(.exe/.cmd/.bat) 解析，.cmd 命中即报告垫片
 * 路径本身（执行时由 cross-spawn 处理），结果按 (platform, pathEnv, name) 缓存。
 *
 * 分隔符/join 全部跟随注入 platform（win32 为 `;` + path.win32.join），
 * 不读宿主 path——posix 宿主模拟 win32 的测试才保真。
 */
import fs from 'node:fs';
import path from 'node:path';
import { currentPlatform, isWin32 } from './select.js';
import type { LaunchSpec } from './types.js';

export type { LaunchSpec } from './types.js';

const DEFAULT_PATHEXT = ['.exe', '.bat', '.cmd'] as const;

/**
 * 缓存 TTL：probe 层（runner/probe.ts）5 分钟，本层更短——bridge 运行期间
 * 用户新装/卸载 agent（典型场景：按 /config 不可用提示去安装）后，最迟
 * TTL 过期即可被重新探测到，不必重启。null（未找到）结果同样过期重查。
 */
const RESOLVE_CACHE_TTL_MS = 60_000;

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  /** PATH 环境变量注入（测试用）；默认 process.env.PATH */
  pathEnv?: string;
  /** PATHEXT 注入（测试用）；win32 默认 .exe/.bat/.cmd（Windows 默认相对顺序） */
  pathExt?: readonly string[];
}

interface CacheEntry {
  spec: LaunchSpec | null;
  ts: number;
}

const resolveCache = new Map<string, CacheEntry>();

export function clearResolveCache(): void {
  resolveCache.clear();
}

/** 过期条目惰性清除；命中返回 spec，未命中/过期返回 undefined。 */
function cacheGet(key: string): LaunchSpec | null | undefined {
  const entry = resolveCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts >= RESOLVE_CACHE_TTL_MS) {
    resolveCache.delete(key);
    return undefined;
  }
  return entry.spec;
}

function listPathDirs(pathEnv: string, platform: NodeJS.Platform): string[] {
  const delimiter = isWin32(platform) ? ';' : ':';
  return pathEnv.split(delimiter).filter((dir) => dir.length > 0);
}

/**
 * win32 join：真实 win32 宿主产出原生反斜杠路径；posix 宿主模拟 win32 的
 * 测试里 dir 是 posix 风格路径，win32 join 会把分隔符归一成 `\` 而宿主 fs
 * 读不到——回退正斜杠形态再探测一次（Windows fs 本身两种分隔符都认）。
 */
function existsWin32(file: string): string | null {
  if (fs.existsSync(file)) return file;
  const posixForm = file.replaceAll('\\', '/');
  if (posixForm !== file && fs.existsSync(posixForm)) return posixForm;
  return null;
}

function resolveWin32(
  name: string,
  pathEnv: string,
  pathExt: readonly string[],
): LaunchSpec | null {
  const hasExtension = /\.[A-Za-z0-9]+$/.test(name);
  for (const dir of listPathDirs(pathEnv, 'win32')) {
    const candidates = hasExtension ? [name] : pathExt.map((ext) => name + ext);
    for (const candidate of candidates) {
      const found = existsWin32(path.win32.join(dir, candidate));
      // .cmd/.bat 垫片命中即报告垫片路径本身；执行语义由 cross-spawn 负责
      if (found) return { kind: 'direct', file: found };
    }
  }
  return null;
}

function resolvePosix(name: string, pathEnv: string): LaunchSpec | null {
  for (const dir of listPathDirs(pathEnv, 'linux')) {
    // 与 win32 分支对称：join 必须跟随注入 platform，而非宿主 path。
    // 宿主是 win32 时用 path.join 会把 `/tmp/a` + `agent` 拼成 `\tmp\a\agent`，
    // posix 语义测试在 Windows 宿主上必然落空。
    const file = path.posix.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return { kind: 'direct', file };
    } catch {
      // 不是可执行文件（或不存在）→ 尝试下一个 PATH 目录
    }
  }
  return null;
}

export function resolveExecutable(name: string, opts?: ResolveOptions): LaunchSpec | null {
  // 空名守卫：posix 的 path.join(dir, '') = 目录本身，而目录有 X_OK——
  // 不挡住会把第一个 PATH 目录误报为「可执行」（dsh 空 binary 之类的假阳性）
  const trimmed = name.trim();
  if (!trimmed) return null;
  const platform = opts?.platform ?? currentPlatform;
  const pathEnv = opts?.pathEnv ?? process.env.PATH ?? '';
  const pathExt = opts?.pathExt ?? DEFAULT_PATHEXT;
  const key = JSON.stringify([platform, pathEnv, [...pathExt].join(';'), trimmed]);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const spec = isWin32(platform)
    ? resolveWin32(trimmed, pathEnv, pathExt)
    : resolvePosix(trimmed, pathEnv);
  resolveCache.set(key, { spec, ts: Date.now() });
  return spec;
}
