/**
 * Shared test fixtures for session/JSONL fixtures.
 *
 * `encodedProjectDir` mirrors production `src/session/claude/sessions.ts`
 * `projectDirForCwd` (cwd → dirName, lossy N-to-N), but canonicalizes via
 * realpath first so the directory name matches what Claude actually writes
 * (`/private/var/folders/...` not `/var/folders/...`). The encoding itself is
 * NOT duplicated here — it delegates to production `encodeProjectDirName`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodeProjectDirName } from '../../src/platform/path.js';

/**
 * 生产 `projectDirForCwd` 的编码部分（cwd → dirName，lossy N-to-N）。
 *
 * 直接复用生产实现 `encodeProjectDirName`：早期这里是手抄的副本，win32 上
 * 漏归一 `\` 与 `:`（生成含 `:` 的非法目录名 → mkdir ENOENT），是典型的
 * 「镜像漂移」。win32 语义（`:` 非法、`\` 同是分隔符）只此一处裁决。
 *
 * 与 `encodedProjectDir` 的唯一区别：不做 realpath 规范化。测试若已持有
 * 规范化路径、或刻意喂未经规范化的字面量 cwd（production 读到的 jsonl
 * `cwd` 字段就是那个字面量），用这份；否则用 `encodedProjectDir`。
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return encodeProjectDirName(cwd);
}

/**
 * pi 会话目录名的**中段**编码（`--<中段>--` 去掉两侧 `--`）。
 *
 * 镜像 pi 自己的落盘规则（pi session-manager：去一个前导分隔符，
 * `/ \\ :` → `-`，**保留 `_`**）。**不能**委托生产 `encodeProjectDirName`：
 * 那是 claude 的规则（`_`→`-`），而 fixture 代表的是 pi 的输出——复用会把
 * 「生产算错目录」固化成「fixture 也写进同一个错目录」，测试永远变绿
 * （pi `_` 回归就是这么漏掉的）。生产侧见 `src/session/pi/sessions.ts`。
 */
export function piEncodeCwd(cwd: string): string {
  return cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
}

export function encodedProjectDir(cwd: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }
  return encodeClaudeProjectDir(canonical);
}

/** Write a fake Claude session jsonl under <projDir>/<sid>.jsonl with an init
 * line carrying the cwd so production code can locate the file. */
export function writeSessionJsonl(projDir: string, sid: string, cwd: string, body: string): void {
  const canonicalCwd = fs.realpathSync(cwd);
  // cwd 必须走 JSON.stringify：win32 路径是 `C:\Users\...`，直接插进 JSON
  // 字面量会产生非法转义（\U），整行解析失败 → 会话永远找不到。
  const initLine = `{"type":"system","subtype":"init","session_id":${JSON.stringify(sid)},"cwd":${JSON.stringify(canonicalCwd)},"model":"opus"}`;
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), `${initLine}\n${body}\n`);
}
