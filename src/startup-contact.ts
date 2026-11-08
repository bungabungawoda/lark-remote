import fs from 'node:fs';
import { getLogger } from './logger/index.js';
import { atomicWriteJson } from './persistence/atomic-write.js';
import { loadJsonFile } from './persistence/load-json-file.js';

interface StartupContact {
  chatId?: string;
  userId?: string;
}

interface StartupHelloChannel {
  sendWithRetry(to: string, input: { text: string }): Promise<string>;
}

/**
 * 已解析联系人的读缓存：按 (mtimeMs, size) 指纹复用。
 *
 * getContact 在每条入站消息 / 每个卡片动作的 owner 判定上都会被调用，原先每次
 * 都是 existsSync + readFileSync + JSON.parse。文件由本程序独占写入（save；
 * 外部改动 = 删文件重绑，文档约定需重启），指纹一致时直接返回缓存，把每消息
 * 成本压到一次 statSync。外部改写文件（测试/手工修复）mtime 必然变化，下一次
 * 调用自动重读，语义不变。
 */
interface ContactCache {
  mtimeMs: number;
  size: number;
  contact: StartupContact | undefined;
}

export class StartupContactStore {
  private cache: ContactCache | undefined;

  constructor(private readonly filePath: string) {}

  save(contact: StartupContact): void {
    atomicWriteJson(this.filePath, contact);
    this.cache = undefined;
  }

  getContact(): StartupContact | undefined {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      // 文件不存在（未绑定）或不可达：保持与旧实现一致的 undefined。
      // 不缓存缺失态，文件随后出现时下一次调用即可读到。
      this.cache = undefined;
      return undefined;
    }
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return this.cache.contact;
    }
    const parsed = loadJsonFile<Partial<StartupContact> | undefined>(this.filePath, undefined);
    const contact = normalizeContact(parsed);
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, contact };
    return contact;
  }
}

function normalizeContact(parsed: Partial<StartupContact> | undefined): StartupContact | undefined {
  if (!parsed) return undefined;
  const contact: StartupContact = {};
  if (typeof parsed.chatId === 'string' && parsed.chatId.length > 0) contact.chatId = parsed.chatId;
  if (typeof parsed.userId === 'string' && parsed.userId.length > 0) contact.userId = parsed.userId;
  return contact.chatId || contact.userId ? contact : undefined;
}

export function formatStartupHello(now = new Date(), pid = process.pid, dev = false): string {
  const startedAt = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  const modeTag = dev ? ' 🔧 dev' : '';
  return `lark-remote${modeTag} 已启动\n启动时间：${startedAt}\n进程号：${pid}`;
}

export async function sendStartupHello(
  connector: StartupHelloChannel,
  store: StartupContactStore,
  opts?: { dev?: boolean },
): Promise<void> {
  const contact = store.getContact();
  const recipient = contact?.chatId ?? contact?.userId;
  if (!recipient) {
    getLogger().info('[startup] no known p2p recipient for hello message');
    return;
  }

  try {
    await connector.sendWithRetry(recipient, {
      text: formatStartupHello(undefined, undefined, opts?.dev),
    });
    getLogger().info('[startup] hello message sent');
  } catch (err) {
    getLogger().warn('[startup] hello message failed:', err);
  }
}
