import fs from 'node:fs';
import path from 'node:path';
import { scanJsonlLines } from '../common/jsonl.js';
import { sortByRecencyDesc } from '../common/recency.js';
import { extractContentBlocks, type ContentBlockMapping } from '../common/content-blocks.js';
import { pathKey } from '../../platform/path.js';
import { currentPlatform } from '../../platform/select.js';
import { getLogger } from '../../logger/index.js';

// ─── Types ──────────────────────────────────────────────────

export interface SessionIndexEntry {
  sessionId: string;
  path: string;
  fingerprint: string;
  mtimeMs: number;
  summary: string;
  /** 用户可见会话命名（qoder `custom-title`，见 ParsedSession.title）；claude 文件无此行 → undefined。 */
  title?: string;
  /**
   * cwd 判等键集合（PathKit.pathKey 归一形态，win32/darwin 大小写+分隔符
   * 不敏感）：索引的 byCwd 倒排与 cwdSet.has 查询都按这个形态比对。注意与
   * {@link parseSessionJsonl} 返回的 raw cwdSet 区分——后者保持 JSONL 原样，
   * 归一只发生在索引边界（见 normalizeCwdSet）。
   */
  cwdSet: Set<string>;
}

export interface SessionIndexOptions {
  /** Minimum interval between refresh scans (ms). Default 5000. */
  refreshIntervalMs?: number;
  /**
   * 平台注入（测试用）；默认当前宿主。cwd 判等键（pathKey）按它取归一口径，
   * win32 语义（大小写 + `\`/`/` 分隔符不敏感）可在任意宿主上单测。
   */
  platform?: NodeJS.Platform;
}

// ─── Claude content block mapping (shared with sessions.ts) ─

/** Claude-specific field-name mapping for content block extraction. */
export const CLAUDE_MAPPING: ContentBlockMapping = {
  toolUseType: 'tool_use',
  toolResultType: 'tool_result',
  toolInputField: 'input',
  toolErrorField: 'is_error',
};

/**
 * Detect Claude CLI sub-agent completion notification text.
 * Claude CLI injects a `type:"user"` record with string content starting
 * with `<task-notification>` when a sub-agent (Agent tool) finishes.
 * These must be excluded from displayTitle/summary — they are machine
 * injections, not real user input. Primary criterion: extracted text
 * starts with `<task-notification` (works for both string and array
 * content since `extractText` is called first). Secondary (optional):
 * `origin.kind === 'task-notification'` (not all CLI versions write it).
 */
export function isTaskNotificationText(text: string): boolean {
  return text.trimStart().startsWith('<task-notification');
}

/**
 * Extract first text from a user message.
 * Used by parseSessionJsonl and sessions.ts readSessionContent.
 */
export function extractText(content: unknown): string | null {
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  const blocks = extractContentBlocks(content, CLAUDE_MAPPING);
  const textBlock = blocks.find((b) => b.type === 'text');
  if (textBlock) return textBlock.content;
  return null;
}

/**
 * 用户可见标题行 → 标题文本。qoder 的 `custom-title`（-n / rename 落盘）复用
 * claude 内核，claude 自身只有 `ai-title`；行类型与字段名只在这里定义，两个
 * 消费点（`parseSessionJsonl` / `sessions.collectAiTitle`）都走本函数。
 * 显式命名会 trim；自动摘要（`ai-title`）保留原值。
 */
export function titleFromRow(obj: Record<string, unknown>): string | undefined {
  if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle) {
    return obj.aiTitle as string;
  }
  if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
    const t = (obj.customTitle as string).trim();
    if (t) return t;
  }
  return undefined;
}

// ─── parseSessionJsonl ──────────────────────────────────────

export interface ParsedSession {
  cwdSet: Set<string>;
  summary: string;
  /**
   * 用户可见的会话命名行（qoder 的 `custom-title`，`-n` / rename 落盘；
   * claude 文件没有此行 → undefined）。取最后一次命名（可重命名）。
   */
  title?: string;
}

/**
 * Unified parser: single streaming scan of a JSONL file producing both
 * the complete set of cwd values AND the first real user message summary.
 * Replaces the split readCwdFromJsonl (first-cwd) + fileContainsCwd (any-cwd).
 */
export function parseSessionJsonl(filePath: string): ParsedSession {
  const cwdSet = new Set<string>();
  let summary = '(无摘要)';
  let foundSummary = false;
  let title: string | undefined;

  const ok = scanJsonlLines(filePath, (line) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }

    // Collect cwd values
    if (typeof obj.cwd === 'string' && obj.cwd) {
      cwdSet.add(obj.cwd);
    }

    // 索引只收用户显式命名（custom-title，last wins）；claude 的 ai-title 是
    // 自动摘要，由 readSessionContent.aiTitle 消费，不进 /resume 列表标题。
    if (obj.type === 'custom-title') {
      const t = titleFromRow(obj);
      if (t) title = t;
    }

    // Find first real user message for summary (same logic as summarizeSession).
    // 过滤谓词与 scalarScan 的 lastUserMessage 同源：isMeta（/clear 等命令回显
    // 与项目规则注入）和 isCompactSummary（压缩摘要）不是用户说的话，当列表
    // 标题会误导（codex 修过同型缺陷：注入文本被当成「最近输入」）。
    if (
      !foundSummary &&
      obj.type === 'user' &&
      !obj.isCompactSummary &&
      !obj.isMeta &&
      !!obj.message
    ) {
      const msg = obj.message as Record<string, unknown>;
      if (msg.content) {
        const text = extractText(msg.content);
        if (text && !isTaskNotificationText(text)) {
          summary = text;
          foundSummary = true;
        }
      }
    }
  });

  // If file couldn't be opened, return empty result
  if (!ok) {
    getLogger().debug(`[session-index] unreadable session file ${filePath}, treating as empty`);
    return { cwdSet: new Set(), summary: '(无摘要)' };
  }

  return { cwdSet, summary, title };
}

// ─── buildFingerprint ───────────────────────────────────────

/**
 * Build a fingerprint string from file stat metadata.
 * Uses `size + mtimeNs + ctimeNs + dev + ino` (bigint stat).
 * `size`/`mtime` are required; the rest are best-effort.
 */
export function buildFingerprint(filePath: string): string {
  let st: fs.BigIntStats;
  try {
    st = fs.statSync(filePath, { bigint: true });
  } catch (err) {
    // ENOENT = 文件在扫描间隙被删除（正常竞态）。其余（EACCES/EBUSY…）留痕，
    // 否则该会话会静默从 /resume 列表里消失。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger().warn(
        `[session-index] cannot stat ${filePath}: ${(err as Error)?.message ?? String(err)}`,
      );
    }
    return '';
  }
  const parts: string[] = [String(st.size), String(st.mtimeNs)];
  // ctimeNs, dev, ino: include if available
  try {
    parts.push(String(st.ctimeNs));
  } catch {
    /* skip */
  }
  try {
    parts.push(String(st.dev));
  } catch {
    /* skip */
  }
  try {
    parts.push(String(st.ino));
  } catch {
    /* skip */
  }
  return parts.join('|');
}

// ─── SessionIndex ───────────────────────────────────────────

/**
 * raw cwd → pathKey 判等键。只允许在「解析结果进入索引」的边界调用：
 * JSONL 里的 cwd 形态（大小写/分隔符/尾斜杠）由写方决定，与查询侧
 * pathKey(cwd) 不保证逐字符一致（win32 尤甚），索引键控必须两侧同口径归一。
 */
function normalizeCwdSet(raw: Set<string>, platform: NodeJS.Platform): Set<string> {
  const out = new Set<string>();
  for (const cwd of raw) out.add(pathKey(cwd, { platform }));
  return out;
}

/**
 * In-memory session index with three query views:
 *   byPath:      path → entry
 *   bySessionId: sessionId → Set<path>
 *   byCwd:       cwd → Set<path>
 *
 * Build once, refresh on demand (throttled). Single-file parse failure
 * doesn't affect other files; readdir failure preserves old index.
 */
export class SessionIndex {
  private readonly projectsDir: string;
  private readonly refreshIntervalMs: number;
  private readonly platform: NodeJS.Platform;

  private readonly byPath = new Map<string, SessionIndexEntry>();
  private readonly bySessionId = new Map<string, Set<string>>();
  private readonly byCwd = new Map<string, Set<string>>();

  private lastRefreshAt = 0;
  private built = false;
  private scanError?: unknown;

  constructor(projectsDir: string, opts: SessionIndexOptions = {}) {
    this.projectsDir = projectsDir;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 5000;
    this.platform = opts.platform ?? currentPlatform;
  }

  /** Whether a full scan has ever completed successfully (readdir succeeded). */
  get isBuilt(): boolean {
    return this.built;
  }

  /**
   * 最近一次全量扫描的非 ENOENT 失败（undefined = 上次扫描正常）。
   * list 路径用它把「读不到」与「真的没有」区分开。
   */
  get lastScanError(): unknown {
    return this.scanError;
  }

  // ── Build (initial full scan) ───────────────────────────

  build(): void {
    this.fullScan();
    this.lastRefreshAt = Date.now();
  }

  // ── Refresh (throttled incremental) ─────────────────────

  refresh(): void {
    const now = Date.now();
    if (now - this.lastRefreshAt < this.refreshIntervalMs) {
      return; // throttled
    }
    this.fullScan();
    this.lastRefreshAt = now;
  }

  // ── Query: listByCwd ────────────────────────────────────

  /**
   * 该 cwd 的全部会话（newest first）。分页不在这里：`listSessions` 的
   * offset/limit 契约由 reader 用共享 `paginate()` 完成，索引只负责有序全集。
   */
  listByCwd(cwd: string): SessionIndexEntry[] {
    const paths = this.byCwd.get(pathKey(cwd, { platform: this.platform }));
    if (!paths || paths.size === 0) return [];

    // Gather entries, deduplicate by sessionId (keep mtime newest)
    const byId = new Map<string, SessionIndexEntry>();
    for (const p of paths) {
      const entry = this.byPath.get(p);
      if (!entry) continue;
      const existing = byId.get(entry.sessionId);
      if (!existing || entry.mtimeMs > existing.mtimeMs) {
        byId.set(entry.sessionId, entry);
      }
    }

    const sorted = [...byId.values()];
    sortByRecencyDesc(
      sorted,
      (s) => s.mtimeMs,
      (s) => s.sessionId,
    );
    return sorted;
  }

  // ── Query: findBySessionIdAndCwd ────────────────────────

  /**
   * Find a session entry by sessionId and cwd.
   * Re-stats the file to verify fingerprint before returning (拍板 3):
   *   - fingerprint unchanged → trust index cwdSet
   *   - fingerprint changed → re-parse that one file, update index, re-check
   * Returns undefined if not found or cwd doesn't match.
   *
   * Note: we re-stat ALL paths for the sessionId regardless of the old cwdSet,
   * because a fingerprint change may have added the target cwd to the set.
   */
  findBySessionIdAndCwd(sessionId: string, cwd: string): SessionIndexEntry | undefined {
    const paths = this.bySessionId.get(sessionId);
    if (!paths || paths.size === 0) return undefined;

    // 快照迭代：updateEntry 会对同一 path 做 delete+add（同 sessionId 有多个
    // path 时 Set 本身仍存在），直接迭代原 Set 会在指纹持续变化时反复重访
    // 同一路径、重复全量解析（活跃会话写入期间可卡死事件循环）。
    for (const p of [...paths]) {
      const entry = this.byPath.get(p);
      if (!entry) continue;

      // Re-stat to verify fingerprint (拍板 3)
      const currentFp = buildFingerprint(p);
      if (currentFp === '') {
        // File disappeared — remove from index
        this.removeEntry(p);
        continue;
      }

      if (currentFp === entry.fingerprint) {
        // Fingerprint matches → trust index
        if (entry.cwdSet.has(pathKey(cwd, { platform: this.platform }))) return entry;
        continue;
      }

      // Fingerprint changed → re-parse this single file
      const parsed = parseSessionJsonl(p);
      try {
        const st = fs.statSync(p, { bigint: true });
        const updated: SessionIndexEntry = {
          sessionId: entry.sessionId,
          path: p,
          fingerprint: currentFp,
          mtimeMs: Number(st.mtimeMs),
          summary: parsed.summary.replace(/\s+/g, ' ').trim(),
          ...(parsed.title ? { title: parsed.title } : {}),
          cwdSet: normalizeCwdSet(parsed.cwdSet, this.platform),
        };
        this.updateEntry(p, updated);
        // Re-check cwd after update
        if (updated.cwdSet.has(pathKey(cwd, { platform: this.platform }))) return updated;
      } catch {
        // File gone
        this.removeEntry(p);
      }
    }
    return undefined;
  }

  // ── Internal: full scan ─────────────────────────────────

  private fullScan(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.projectsDir);
    } catch (err) {
      // readdir failure → preserve old index, degrade to fallback
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // projectsDir 不存在 = 全新环境（真空态），不是故障。
        this.scanError = undefined;
        return;
      }
      this.scanError = err;
      getLogger().warn(
        `[session-index] readdir ${this.projectsDir} failed, preserving old index: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
      return;
    }
    this.scanError = undefined;
    // readdir succeeded → the snapshot is authoritative for what we could read.
    this.built = true;

    const currentPaths = new Set<string>();
    // 非 ENOENT 读取失败（EACCES/EMFILE…）的 project 目录：本轮读不到不等于
    // 会话消失，末尾清理必须保留这些目录下的旧条目，否则一次瞬时故障就会让
    // /resume 静默少一整批会话。
    const unreadableDirs = new Set<string>();

    for (const entry of entries) {
      const subdir = path.join(this.projectsDir, entry);
      let st: fs.Stats;
      try {
        st = fs.statSync(subdir);
        if (!st.isDirectory()) continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadableDirs.add(subdir);
        getLogger().debug(
          `[session-index] skipped unreadable project dir ${subdir}: ${
            (err as Error)?.message ?? String(err)
          }`,
        );
        continue;
      }

      let files: string[];
      try {
        files = fs.readdirSync(subdir).filter((f) => f.endsWith('.jsonl'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadableDirs.add(subdir);
        getLogger().debug(
          `[session-index] skipped unreadable project subdir ${subdir}: ${
            (err as Error)?.message ?? String(err)
          }`,
        );
        continue;
      }

      for (const f of files) {
        const fullPath = path.join(subdir, f);
        currentPaths.add(fullPath);

        // Check fingerprint
        const fp = buildFingerprint(fullPath);
        if (fp === '') continue; // can't stat, skip

        const existing = this.byPath.get(fullPath);
        if (existing && existing.fingerprint === fp) {
          // Unchanged, keep as-is
          continue;
        }

        // New file or fingerprint changed → parse
        // Concurrent-write guard: stat before and after parse, compare fingerprints
        const fpBefore = fp;
        const parsed = parseSessionJsonl(fullPath);
        const fpAfter = buildFingerprint(fullPath);

        if (fpBefore !== fpAfter) {
          // File was modified during parse → skip this round, retry next refresh
          getLogger().info(`[session-index] concurrent write detected for ${f}, skipping`);
          continue;
        }

        try {
          const fileStat = fs.statSync(fullPath, { bigint: true });
          const sessionId = f.slice(0, -'.jsonl'.length);
          const newEntry: SessionIndexEntry = {
            sessionId,
            path: fullPath,
            fingerprint: fpAfter,
            mtimeMs: Number(fileStat.mtimeMs),
            summary: parsed.summary.replace(/\s+/g, ' ').trim(),
            ...(parsed.title ? { title: parsed.title } : {}),
            cwdSet: normalizeCwdSet(parsed.cwdSet, this.platform),
          };
          this.updateEntry(fullPath, newEntry);
        } catch (err) {
          getLogger().warn(`[session-index] skip ${f}: ${(err as Error).message}`);
        }
      }
    }

    // Remove entries for files that no longer exist（读取失败的目录除外：
    // 本轮没读到不代表文件已删除）
    for (const p of [...this.byPath.keys()]) {
      if (!currentPaths.has(p) && !unreadableDirs.has(path.dirname(p))) {
        this.removeEntry(p);
      }
    }
  }

  // ── Internal: index mutation ────────────────────────────

  private updateEntry(filePath: string, entry: SessionIndexEntry): void {
    const old = this.byPath.get(filePath);

    // Remove old entry's cross-references if it exists
    if (old) {
      this.removeCrossRefs(filePath, old);
    }

    // Set new entry
    this.byPath.set(filePath, entry);

    // bySessionId
    let idPaths = this.bySessionId.get(entry.sessionId);
    if (!idPaths) {
      idPaths = new Set();
      this.bySessionId.set(entry.sessionId, idPaths);
    }
    idPaths.add(filePath);

    // byCwd
    for (const cwd of entry.cwdSet) {
      let cwdPaths = this.byCwd.get(cwd);
      if (!cwdPaths) {
        cwdPaths = new Set();
        this.byCwd.set(cwd, cwdPaths);
      }
      cwdPaths.add(filePath);
    }
  }

  private removeEntry(filePath: string): void {
    const entry = this.byPath.get(filePath);
    if (!entry) return;
    this.removeCrossRefs(filePath, entry);
    this.byPath.delete(filePath);
  }

  private removeCrossRefs(filePath: string, entry: SessionIndexEntry): void {
    // bySessionId
    const idPaths = this.bySessionId.get(entry.sessionId);
    if (idPaths) {
      idPaths.delete(filePath);
      if (idPaths.size === 0) this.bySessionId.delete(entry.sessionId);
    }

    // byCwd
    for (const cwd of entry.cwdSet) {
      const cwdPaths = this.byCwd.get(cwd);
      if (cwdPaths) {
        cwdPaths.delete(filePath);
        if (cwdPaths.size === 0) this.byCwd.delete(cwd);
      }
    }
  }
}
