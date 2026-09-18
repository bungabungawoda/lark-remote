import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_INBOUND_MEDIA_DIR_NAME, type AppConfig } from '../config/index.js';
import { atomicMoveFile } from '../persistence/atomic-write.js';
import { getLogger } from '../logger/index.js';
import { silentlyUnlink } from '../common/fs.js';
import type { InboundAttachment, MediaOutcome } from '../inbound/turn.js';
import type {
  InboundResourceKind,
  InboundMediaItem,
  InboundMediaPayload,
} from '../connector/index.js';

/**
 * 入站媒体落盘。
 *
 * 核心设计：
 * - 存储「到达即存」：每个 media 立即原子写入
 *   `<cwd>/.lark-remote-temp/<YYYYMMDDHHmm>/`，不等待合批窗口；
 * - 只负责「落盘 + 报告结果」：把落盘路径与失败原因交回装配器
 *   （`InboundTurnAssembler`），由装配器决定注入 prompt 还是发回执。
 *   时间语义统一由装配器的静默期窗口负责（2026-09-15 起取代旧的
 *   500ms 合批提示窗口 ——「现有合批窗口由 700ms 装配窗口取代」）。
 */

/** 文件名最长字节数（macOS/APFS 单组件上限 255 字节，留余量用 240）。 */
const MAX_FILE_NAME_BYTES = 240;

/** 魔数检测读取的头部字节数（png/jpg/gif/webp/mp4/ogg 签名都在前 12 字节内）。 */
const MAGIC_HEAD_BYTES = 12;

export interface InboundMediaDeps {
  /** 解析用户 cwd（bridge.resolveCwd 注入，统一三份复制点）。 */
  resolveCwd: (userId: string) => string | undefined;
  /** 读取当前配置（活引用，随 /config 保存更新，避免启动快照过期）。 */
  getConfig: () => AppConfig;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'audio/opus': 'opus',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/mp4': 'm4a',
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
 * 资源扩展名（图片/视频/语音）：优先 MIME 映射，未知时按魔数兜底；
 * 两者都无法识别时返回 undefined（调用方省略扩展名，避免错误标注格式）。
 */
export function extensionFor(
  _kind: InboundResourceKind,
  mimeType: string | undefined,
  head: Buffer,
): string | undefined {
  const normalized = mimeType?.split(';')[0]?.trim().toLowerCase();
  if (normalized && MIME_TO_EXT[normalized]) return MIME_TO_EXT[normalized];
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WAVE'
  ) {
    return 'wav';
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
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'OggS') {
    return 'opus';
  }
  // MP4/MOV 家族：ISO BMFF 在偏移 4 处写 'ftyp'。
  if (head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    return 'mp4';
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return 'bmp';
  }
  if (head.length >= 3 && head.subarray(0, 3).toString('latin1') === 'ID3') {
    return 'mp3';
  }
  // MPEG audio frame sync（0xFFE0 掩码）+ 常见 layer/bitrate 组合。
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xfe) === 0xfa) {
    return 'mp3';
  }
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '#!AMR') {
    return 'amr';
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) {
    return 'mkv';
  }
  return undefined;
}

/** 按 UTF-8 字节数截断字符串（避免截在多字节字符中间）。 */
import { truncateUtf8 } from '../common/truncate.js';

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
 * - image：`image_<HHmmss>_<n>.<ext>`（ext 按 MIME/魔数）；
 * - 其它有原名的资源（file/video/audio/sticker）：保留原名（已 sanitize）；
 * - 无原名的资源：`<kind>_<HHmmss>_<n>.<ext>`，ext 按 MIME/魔数
 *   （旧实现落成无扩展名的 `file_HHmmss_n`，mp4/opus/gif 都不可识别）。
 */
export function buildFileName(item: InboundMediaItem, index: number, receivedAt: Date): string {
  const original = item.fileName ? limitFileNameLength(sanitizeFileName(item.fileName)) : '';
  if (item.kind !== 'image' && original) return original;
  const ext = extensionFor(item.kind, item.mimeType, readFileHead(item.tempPath));
  return `${item.kind}_${timeStampHms(receivedAt)}_${index}${ext ? `.${ext}` : ''}`;
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

export class InboundMediaHandler {
  constructor(private readonly deps: InboundMediaDeps) {}

  /**
   * 落盘并返回结果（不改时间语义、不发消息）。
   * 失败/超限/无 cwd 一律进 `rejected`，由装配器决定回执文案。
   */
  async save(payload: InboundMediaPayload): Promise<MediaOutcome> {
    const cwd = this.resolveCwd(payload.userId);
    if (!cwd) {
      this.cleanupTemps(payload);
      return {
        attachments: [],
        rejected: [
          {
            kind: 'file',
            reason: '未设置工作目录，无法保存文件。请先使用 /cd <path> 或 /ws use 设置',
            sourceMsgId: payload.messageId,
          },
        ],
      };
    }

    const receivedAt = new Date();
    const dir = path.join(cwd, this.safeDirName(), timeStampDir(receivedAt));
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      // 写盘失败必须明确提示；临时文件一并清理避免泄漏。
      this.cleanupTemps(payload);
      return {
        attachments: [],
        rejected: [
          {
            kind: 'file',
            reason: `保存失败：无法创建目录 ${dir}：${(err as Error).message}`,
            sourceMsgId: payload.messageId,
          },
        ],
      };
    }

    const rejected = payload.failures.map((f) => ({
      kind: f.kind ?? 'file',
      reason: f.fileName ? `${f.fileName}: ${f.reason}` : f.reason,
      sourceMsgId: payload.messageId,
    }));
    const attachments: InboundAttachment[] = [];

    for (let i = 0; i < payload.media.length; i += 1) {
      const item = payload.media[i];
      try {
        const target = uniqueTargetPath(dir, buildFileName(item, i + 1, receivedAt));
        atomicMoveFile(item.tempPath, target);
        attachments.push({
          path: target,
          kind: item.kind,
          sourceMsgId: payload.messageId,
          originalName: item.fileName,
          durationMs: item.durationMs,
        });
      } catch (err) {
        silentlyUnlink(item.tempPath);
        const label = item.fileName
          ? sanitizeFileName(item.fileName) || item.fileName
          : `第 ${i + 1} 个`;
        rejected.push({
          kind: item.kind,
          reason: `${label}: ${(err as Error).message}`,
          sourceMsgId: payload.messageId,
        });
      }
    }

    return { attachments, rejected };
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
}
