/**
 * stdout 分帧与解码正确性（不经真实 agent CLI：spawn seam 直接给假子进程）。
 *
 * 三条口径共用一个前提——**一帧的边界不等于一次 `data` 事件的边界**：
 * 1. 多字节字符跨 chunk 拆分时必须由 decoder 缓冲，逐 chunk `toString` 会产出
 *    不可逆的 U+FFFD（中文工具输出/助手正文变问号）。
 * 2. 行长上限量的是 **UTF-8 字节**：`line.length` 是 UTF-16 单元数，中文 1 单元
 *    = 3 字节、emoji 2 单元 = 4 字节，约 2-3× 低估。
 * 3. `onMessage` 抛错是 handler 故障，不能记成「failed to parse JSON」——
 *    那会把真实故障点掩盖成协议噪声。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { JsonlRpcTransport } from './transport.js';
import { mockLogger } from '../../../../tests/lib/logger-mock.js';

vi.mock('../../../logger/index.js', async () =>
  (await import('../../../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

const { spawned } = vi.hoisted(() => ({ spawned: [] as unknown[] }));

/** 假子进程：stdout/stderr/stdin 为可控 EventEmitter。 */
function makeFakeChild() {
  const stdin = Object.assign(new EventEmitter(), {
    write: () => true,
    end: () => {},
    destroyed: false,
  });
  return Object.assign(new EventEmitter(), {
    // 不存在的 pid：即使走到 stopper 也只拿得到 ESRCH，碰不到真进程
    pid: 424242,
    exitCode: 0,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin,
  });
}

vi.mock('../../../platform/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/spawn.js')>();
  return {
    ...actual,
    spawnProcess: () => {
      const child = makeFakeChild();
      spawned.push(child);
      return child;
    },
  };
});

type FakeChild = ReturnType<typeof makeFakeChild>;

interface Harness {
  messages: unknown[];
  closes: string[];
  child: FakeChild;
  push(chunk: Buffer): void;
  exit(): void;
}

async function startTransport(onMessage?: (msg: unknown) => void): Promise<Harness> {
  const messages: unknown[] = [];
  const closes: string[] = [];
  const transport = new JsonlRpcTransport({ binary: 'fake-agent', args: [], cwd: '/tmp' });
  // start() 在第一个 await 之前就同步接好 stdout 监听器
  void transport.start({
    onMessage: (msg) => (onMessage ? onMessage(msg) : messages.push(msg)),
    onClose: (reason) => closes.push(reason),
  });
  const child = spawned[spawned.length - 1] as FakeChild;
  return {
    messages,
    closes,
    child,
    push: (chunk) => void child.stdout.emit('data', chunk),
    exit: () => void child.emit('exit', 0, null),
  };
}

/** 第一个 UTF-8 后续字节（10xxxxxx）的下标：从它前面切开必然拆断某个多字节字符。 */
function firstContinuationByte(buf: Buffer): number {
  for (let i = 0; i < buf.length; i++) {
    if ((buf[i]! & 0xc0) === 0x80) return i;
  }
  throw new Error('fixture 里没有多字节字符');
}

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  spawned.length = 0;
});

describe('JsonlRpcTransport 分帧解码', () => {
  it('test_anchor_transport_reassembles_multibyte_split_across_chunks', async () => {
    const text = '压缩完成✅ 全部搞定';
    const line = `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text } })}\n`;
    const buf = Buffer.from(line, 'utf8');
    const cut = firstContinuationByte(buf);

    const { messages, push } = await startTransport();
    push(buf.subarray(0, cut));
    push(buf.subarray(cut));

    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: { text } }]);
    expect(JSON.stringify(messages)).not.toContain('\uFFFD');
  });

  it('切点落在行尾最后一个字符内时，同样要拼回完整消息', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 2, method: '收尾' });
    const buf = Buffer.from(line, 'utf8');
    // 从尾部找最后一个后续字节 → 拆断行尾的「尾」
    let cut = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      if ((buf[i]! & 0xc0) === 0x80) {
        cut = i;
        break;
      }
    }
    expect(cut).toBeGreaterThan(0);

    const { messages, push, exit } = await startTransport();
    push(buf.subarray(0, cut));
    push(buf.subarray(cut));
    expect(messages).toHaveLength(0); // 未成行，不该提前投递

    exit();
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 2, method: '收尾' }]);
  });

  it('行长上限按 UTF-8 字节算，不按 UTF-16 单元数', async () => {
    const huge = '中'.repeat(3_500_000); // 10.5MB 字节 > 10MB 上限
    expect(huge.length).toBeLessThan(10 * 1024 * 1024);

    const { closes, push } = await startTransport();
    push(Buffer.from(`${huge}\n`, 'utf8'));

    expect(closes).toContain('parse_error');
    expect(mockLogger.error.mock.calls.some((c) => String(c[0]).includes('line exceeds'))).toBe(
      true,
    );
  });

  it('handler 抛错记为 handler 故障，不是 parse 失败', async () => {
    const { messages, push } = await startTransport(() => {
      throw new Error('translator blew up');
    });
    push(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 3 })}\n`, 'utf8'));

    const logged = [...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls].map((c) =>
      String(c[0]),
    );
    expect(logged.some((m) => m.includes('handler'))).toBe(true);
    expect(logged.some((m) => m.includes('failed to parse JSON'))).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it('一条消息的 handler 抛错不影响后续帧', async () => {
    const seen: unknown[] = [];
    const { push } = await startTransport((msg) => {
      seen.push(msg);
      if (seen.length === 1) throw new Error('boom');
    });
    push(Buffer.from(`${JSON.stringify({ id: 1 })}\n${JSON.stringify({ id: 2 })}\n`, 'utf8'));

    expect(seen).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
