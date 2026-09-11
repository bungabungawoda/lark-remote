/**
 * PathKit — 跨平台路径语义（design.md §5.1）。
 *
 * 所有 cwd 相等性判断、会话目录编码、pid 文件名后缀、spawn cwd 前统一走本模块。
 * 语义映射：
 *   canonicalPath(p): realpath(expandEnv(expandTilde(normalizeSeparators(p))))
 *   samePath(a, b):   win32/darwin 默认大小写不敏感 + 分隔符不敏感；linux 严格相等
 *   displayName(p):   path.basename（win32 原生认识 \ 与 /）
 *
 * 全部函数接受显式 `platform` 参数（默认 currentPlatform），使 win32 语义
 * 可在任意宿主的单元测试中验证。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentPlatform, isWin32 } from './select.js';

export interface PathOptions {
  platform?: NodeJS.Platform;
  /** 环境变量注入（测试用）；默认 process.env */
  env?: Record<string, string | undefined>;
  /** 家目录注入（测试用）；默认 os.homedir() */
  home?: string;
  /** 是否执行 realpath（默认 true）；不存在的路径自动跳过 */
  realpath?: boolean;
}

/** 展开开头的 ~ 或 ~/（win32 含 ~\）为家目录；其余原样返回。 */
function expandTilde(p: string, home: string, platform: NodeJS.Platform): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || (isWin32(platform) && p.startsWith('~\\'))) {
    return path.join(home, p.slice(2));
  }
  return p;
}

/** 展开 %VAR%（win32）或 $VAR / ${VAR}（posix）；未定义的变量保留字面量。 */
function expandEnv(
  p: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string {
  if (isWin32(platform)) {
    return p.replace(/%([A-Za-z0-9_]+)%/g, (match, name: string) => env[name] ?? match);
  }
  return p.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced?: string, plain?: string) => {
      const name = braced ?? plain;
      if (name === undefined) return match;
      const value = env[name];
      return value === undefined ? match : value;
    },
  );
}

/** win32 把反斜杠归一为正斜杠（Node win32 API 两者皆收）；posix 反斜杠是合法文件名字符，不动。 */
function normalizeSeparators(p: string, platform: NodeJS.Platform): string {
  return isWin32(platform) ? p.replaceAll('\\', '/') : p;
}

function resolveOptions(opts: PathOptions | undefined): {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  realpath: boolean;
} {
  const platform = opts?.platform ?? currentPlatform;
  return {
    platform,
    env: opts?.env ?? process.env,
    home: opts?.home ?? os.homedir(),
    realpath: opts?.realpath ?? true,
  };
}

export function canonicalPath(p: string, opts?: PathOptions): string {
  const { platform, env, home, realpath } = resolveOptions(opts);
  let out = expandTilde(p, home, platform);
  out = expandEnv(out, env, platform);
  out = normalizeSeparators(out, platform);
  if (!realpath) return out;
  try {
    return fs.realpathSync(out);
  } catch {
    // 路径尚不存在（如待创建的目录）：返回展开+归一化形态，不抛
    return out;
  }
}

export function samePath(a: string, b: string, opts?: PathOptions): boolean {
  const { platform } = resolveOptions(opts);
  if (platform === 'linux') return a === b;
  if (isWin32(platform)) {
    // win32：\ 与 / 都是分隔符，且路径大小写不敏感
    const norm = (p: string): string => p.replaceAll('\\', '/').replace(/\/+$/, '');
    return norm(a).toLowerCase() === norm(b).toLowerCase();
  }
  // darwin：默认按大小写不敏感处理（macOS 默认文件系统 APFS 不敏感）；
  // 反斜杠是合法文件名字符，不动。分隔符只有 /。
  // 假设标注：大小写敏感 APFS/HFS+ 卷上 /Users/A 与 /Users/a 实为两个目录，
  // 此处会判等（cwd 守卫假阳性）——影响面小（默认卷不敏感），如需精确需
  // 逐目录 stat 探测卷大小写属性，暂不做。
  // 尾部分隔符必须与 win32 同口径忽略，否则 `/cd ~/repo/` 与 `/cd ~/repo`
  // 会被判成两个目录，M2 迁移后直接表现为会话目录错配。
  const norm = (p: string): string => p.replace(/\/+$/, '');
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/**
 * cwd → 会话项目目录名（Claude/pi 的 on-disk 编码，lossy N-to-N）。
 *
 * 只可用于**定位**目录，绝不可反解回 cwd——cwd 必须从 JSONL 内容读取
 * （回归 2026-06-21 /resume & /cd 路径错乱）。
 *
 * posix：`/` → `-`（`_` 同样归一，与 Claude Code 一致）。
 * win32：`\` 与 `/` **都是**分隔符、`:` 是非法文件名字符，三者都必须归一，
 * 否则 `C:\Users\x\proj` 会原样拼进目录名，mkdir/stat 必然失败。
 * 反过来，posix 上 `:` 是**合法**文件名字符，不能动——否则既有目录定位不到。
 */
export function encodeProjectDirName(cwd: string, opts?: PathOptions): string {
  const { platform } = resolveOptions(opts);
  return isWin32(platform)
    ? cwd.replace(/[/\\:]/g, '-').replace(/_/g, '-')
    : cwd.replace(/\//g, '-').replace(/_/g, '-');
}

export function displayName(p: string, opts?: PathOptions): string {
  const { platform } = resolveOptions(opts);
  // 必须用与注入 platform 对应的 path 实现，而非宿主 `path`：宿主为 win32 时
  // `path.basename` 会把 `\` 当分隔符，posix 语义（反斜杠是合法文件名字符）
  // 就被宿主机悄悄改写。win32/posix 各用各的实现后，结果与宿主无关。
  return isWin32(platform) ? path.win32.basename(p) : path.posix.basename(p);
}
