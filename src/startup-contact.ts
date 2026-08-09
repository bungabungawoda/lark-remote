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

export class StartupContactStore {
  constructor(private readonly filePath: string) {}

  save(contact: StartupContact): void {
    atomicWriteJson(this.filePath, contact);
  }

  getContact(): StartupContact | undefined {
    const parsed = loadJsonFile<Partial<StartupContact> | undefined>(this.filePath, undefined);
    if (!parsed) return undefined;
    const contact: StartupContact = {};
    if (typeof parsed.chatId === 'string' && parsed.chatId.length > 0)
      contact.chatId = parsed.chatId;
    if (typeof parsed.userId === 'string' && parsed.userId.length > 0)
      contact.userId = parsed.userId;
    return contact.chatId || contact.userId ? contact : undefined;
  }
}

export function formatStartupHello(now = new Date(), pid = process.pid): string {
  const startedAt = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  return `lark-remote 已启动\n启动时间：${startedAt}\n进程号：${pid}`;
}

export async function sendStartupHello(
  connector: StartupHelloChannel,
  store: StartupContactStore,
): Promise<void> {
  const contact = store.getContact();
  const recipient = contact?.chatId ?? contact?.userId;
  if (!recipient) {
    getLogger().info('[startup] no known p2p recipient for hello message');
    return;
  }

  try {
    await connector.sendWithRetry(recipient, { text: formatStartupHello() });
    getLogger().info('[startup] hello message sent');
  } catch (err) {
    getLogger().warn('[startup] hello message failed:', err);
  }
}
