import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_INBOUND_MEDIA_DIR_NAME, type AppConfig } from '../config/index.js';
import { atomicMoveFile } from '../persistence/atomic-write.js';
import { getLogger } from '../logger/index.js';
import { silentlyUnlink } from '../common/fs.js';
import type {
  InboundMediaFailure,
  InboundMediaItem,
  InboundMediaPayload,
} from '../connector/index.js';

/**
 * 入站媒体落盘。
 *
 * 核心设计：
 * - 存储"到达即存"：每个 media 立即原子写入
 *   `<cwd>/.lark-remote-temp/<YYYYMMDDHHmm>/`，不等待合批窗口；
 * - 合批只影响提示：500ms 窗口内同一 (userId, chatId, replyTo) 的保存结果
 *   合并成一条"已保存 N 个文件"提示；
 * - 文本消息到达时由 Bridge.flushMediaNotifications 立即冲刷批次
 *   （"先图后文字时文字到达先冲刷批次"），避免提示被后续消息淹没。
 */

/** 合批窗口（毫秒）。同一窗口内到达的保存提示合并为一条。 */
const DEFAULT_BATCH_WINDOW_MS = 500;

/** 单条提示最多列出的文件数；超出折叠为 "… 等 N 个文件"。 */
const MAX_PATHS_IN_NOTIFICATION = 10;

/** 文件名最长字节数（macOS/APFS 单组件上限 255 字节，留余量用 240）。 */
const MAX_FILE_NAME_BYTES = 240;

/** 魔数检测读取的头部字节数（png/jpg/gif/webp 签名都在前 12 字节内）。 */
const MAGIC_HEAD_BYTES = 12;

export interface InboundMediaDeps {
  /** 解析用户 cwd（bridge.resolveCwd 注入，统一三份复制点）。 */
  resolveCwd: (userId: string) => string | undefined;
  /** 读取当前配置（活引用，随 /config 保存更新，避免启动快照过期）。 */
  getConfig: () => AppConfig;
  /** 发送提示消息（bridge.sendResult 包装）。 */
  send(ctx: { userId: string; chatId: string; messageId: string }, text: string): Promise<boolean>;
}

interface PendingBatch {
  /** 批次代表消息（第一条），用于 replyTo。 */
  payload: InboundMediaPayload;
  saved: string[];
  errors: string[];
  timer: ReturnType<typeof setTimeout>;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 子目录时间戳：YYYYMMDDHHmm（本地时间，精确到分钟）。 */
function timeStampDir(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}`
  );
}

/** 文件名时间戳：HHmmss（本地时间）。 */
function timeStampHms(d: Date): string {
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * 文件名 sanitize：
 * path.basename 剥离目录（防 `../` 穿越），再替换控制字符与路径分隔符；
 * 空名 / `.` / `..` 视为无效（返回空串由调用方生成兜底名）。
 */
export function sanitizeFileName(name: string): string {
  const base = path.basename(name).trim();
  const chars: string[] = [];
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    // 控制字符与路径分隔符一律替换为下划线（no-control-regex 不允许字面
    // 控制字符转义出现在正则里，逐字符判断语义等价且无 lint 冲突）。
    if (code <= 0x1f || code === 0x7f || ch === '/' || ch === '\\') {
      chars.push('_');
    } else {
      chars.push(ch);
    }
  }
  const sanitized = chars.join('');
  if (sanitized === '' || sanitized === '.' || sanitized === '..') return '';
  return sanitized;
}

/**
 * image 消息扩展名：优先 MIME 映射，未知时按魔数兜底；
 * 两者都无法识别时返回 undefined（调用方省略扩展名，避免错误标注格式）。
 */
export function imageExtension(mimeType: string | undefined, head: Buffer): string | undefined {
  if (mimeType && MIME_TO_EXT[mimeType]) return MIME_TO_EXT[mimeType];
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpg';
  }
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'GIF8') {
    return 'gif';
  }
  return undefined;
}

/** 按 UTF-8 字节数截断字符串（避免截在多字节字符中间）。 */
import { truncateUtf8 } from '../common/truncate.js';
export { truncateUtf8 };

/**
 * 文件名长度限制（字节级，保留扩展名），避免 ENAMETOOLONG 整文件失败。
 * 极罕见情况（扩展名本身超限）直接截断全名。
 */
export function limitFileNameLength(name: string, maxBytes = MAX_FILE_NAME_BYTES): string {
  if (Buffer.byteLength(name, 'utf8') <= maxBytes) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const maxStemBytes = maxBytes - Buffer.byteLength(ext, 'utf8');
  if (maxStemBytes <= 0) return truncateUtf8(name, maxBytes, false, '');
  return truncateUtf8(stem, maxStemBytes, false, '') + ext;
}

/** 只读临时文件头部若干字节（魔数检测用，不把整个文件读进内存）。 */
function readFileHead(filePath: string, maxBytes = MAGIC_HEAD_BYTES): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 生成落盘文件名：
 * - file 消息：保留原始文件名（已 sanitize）；无文件名兜底 file_<HHmmss>_<n>；
 * - image 消息：image_<HHmmss>_<n>.<ext>，ext 按 MIME。
 */
export function buildFileName(item: InboundMediaItem, index: number, receivedAt: Date): string {
  if (item.type === 'file') {
    const sanitized = item.fileName ? sanitizeFileName(item.fileName) : '';
    return (
      (sanitized ? limitFileNameLength(sanitized) : '') ||
      `file_${timeStampHms(receivedAt)}_${index}`
    );
  }
  const ext = imageExtension(item.mimeType, readFileHead(item.tempPath));
  return `image_${timeStampHms(receivedAt)}_${index}${ext ? `.${ext}` : ''}`;
}

/** 同名冲突自动加序号（name-1.ext、name-2.ext…），不覆盖已有文件。 */
export function uniqueTargetPath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

function formatFailure(f: InboundMediaFailure): string {
  return f.fileName ? `${f.fileName}: ${f.reason}` : f.reason;
}

function batchKey(payload: InboundMediaPayload): string {
  return `${payload.userId}:${payload.chatId}:${payload.replyToMessageId ?? ''}`;
}

export class InboundMediaHandler {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly batchWindowMs: number;

  constructor(private readonly deps: InboundMediaDeps) {
    this.batchWindowMs = DEFAULT_BATCH_WINDOW_MS;
  }

  /** 落盘并安排/合并提示。 */
  async handle(payload: InboundMediaPayload): Promise<void> {
    const cwd = this.resolveCwd(payload.userId);
    if (!cwd) {
      this.cleanupTemps(payload);
      await this.deps.send(
        { userId: payload.userId, chatId: payload.chatId, messageId: payload.messageId },
        '⚠️ 未设置工作目录，无法保存文件。请先使用 /cd <path> 或 /ws use 设置',
      );
      return;
    }

    const receivedAt = new Date();
    const dir = path.join(cwd, this.safeDirName(), timeStampDir(receivedAt));
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      // 写盘失败必须明确提示；临时文件一并清理避免泄漏。
      this.cleanupTemps(payload);
      await this.deps.send(
        { userId: payload.userId, chatId: payload.chatId, messageId: payload.messageId },
        `⚠️ 保存失败：无法创建目录 ${dir}：${(err as Error).message}`,
      );
      return;
    }

    const errors: string[] = payload.failures.map(formatFailure);
    const saved: string[] = [];

    for (let i = 0; i < payload.media.length; i += 1) {
      const item = payload.media[i];
      try {
        const target = uniqueTargetPath(dir, buildFileName(item, i + 1, receivedAt));
        atomicMoveFile(item.tempPath, target);
        saved.push(target);
      } catch (err) {
        silentlyUnlink(item.tempPath);
        const label = item.fileName
          ? sanitizeFileName(item.fileName) || item.fileName
          : `第 ${i + 1} 个`;
        errors.push(`${label}: ${(err as Error).message}`);
      }
    }

    if (saved.length === 0) {
      await this.deps.send(
        { userId: payload.userId, chatId: payload.chatId, messageId: payload.messageId },
        `⚠️ 保存失败：${errors.join('；') || '未知错误'}`,
      );
      return;
    }

    const key = batchKey(payload);
    const existing = this.pending.get(key);
    if (existing) {
      existing.saved.push(...saved);
      existing.errors.push(...errors);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void this.flush(key), this.batchWindowMs);
      return;
    }
    const timer = setTimeout(() => void this.flush(key), this.batchWindowMs);
    this.pending.set(key, { payload, saved, errors, timer });
  }

  /** 立即冲刷某用户的全部待合批提示（文本到达时调用）。 */
  flushAll(userId: string, chatId: string): void {
    for (const key of [...this.pending.keys()]) {
      const batch = this.pending.get(key);
      if (batch && batch.payload.userId === userId && batch.payload.chatId === chatId) {
        void this.flush(key);
      }
    }
  }

  /** 冲刷全部待合批提示（/exit、/restart 干净退出前调用，避免丢最后一条提示）。 */
  async flushAllPending(): Promise<void> {
    const keys = [...this.pending.keys()];
    await Promise.all(keys.map((key) => this.flush(key)));
  }

  /**
   * dirName 配置校验：只允许单层目录名（不允许 `/`、`\`、`..`、`.`、控制字符），
   * 非法值回退默认 `.lark-remote-temp`，避免配置意外把文件写到 cwd 之外。
   */
  private safeDirName(): string {
    const name = this.deps.getConfig().inboundMedia.dirName;
    if (
      name &&
      name !== '.' &&
      name !== '..' &&
      !name.includes('/') &&
      !name.includes('\\') &&
      !hasControlChar(name)
    ) {
      return name;
    }
    getLogger().warn(
      `[media] invalid inboundMedia.dirName "${String(name)}", falling back to .lark-remote-temp`,
    );
    return DEFAULT_INBOUND_MEDIA_DIR_NAME;
  }

  /** 清理未被移动的临时文件（无 cwd / 目录创建失败等提前返回路径）。 */
  private cleanupTemps(payload: InboundMediaPayload): void {
    for (const item of payload.media) {
      silentlyUnlink(item.tempPath);
    }
  }

  private resolveCwd(userId: string): string | undefined {
    return this.deps.resolveCwd(userId);
  }

  private async flush(key: string): Promise<void> {
    const batch = this.pending.get(key);
    if (!batch) return;
    this.pending.delete(key);
    clearTimeout(batch.timer);

    const lines = batch.saved.slice(0, MAX_PATHS_IN_NOTIFICATION).map((p) => `- ${p}`);
    const overflow =
      batch.saved.length > MAX_PATHS_IN_NOTIFICATION ? `\n… 等 ${batch.saved.length} 个文件` : '';
    const failures = batch.errors.length > 0 ? `\n⚠️ ${batch.errors.join('；')}` : '';
    const text =
      `📎 已保存 ${batch.saved.length} 个文件：\n` +
      lines.join('\n') +
      overflow +
      failures +
      '\n💡 你可以直接说：请处理刚才保存的文件';

    await this.deps.send(
      {
        userId: batch.payload.userId,
        chatId: batch.payload.chatId,
        messageId: batch.payload.messageId,
      },
      text,
    );
  }
}
