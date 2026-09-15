import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuConnector, PATCH_MAX_RETRIES } from './index.js';
import type { AppConfig } from '../config/index.js';

/**
 * 卡片 patch 的瞬态错误重试（2026-09-15 socket-close 事故）。
 *
 * 流式卡片的 patch 由 @larksuite/channel 的 CardStreamController 经 throttle
 * 延迟触发：controller.update() 调完 throttle.note() 就 resolve，不等真正的
 * patch —— 失败是一条脱离 await 链的 detached rejection，调用方 try/catch
 * 挡不住，只能冒泡到 process.unhandledRejection。所以重试必须做在 patch 出口本身。
 */
let patchStub: ReturnType<typeof vi.fn>;

vi.mock('@larksuite/channel', () => ({
  createLarkChannel: () => ({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    send: vi.fn(),
    stream: vi.fn(),
    updateCard: vi.fn(),
    addReaction: vi.fn(),
    rawClient: {
      im: {
        v1: {
          message: {
            patch: (...args: unknown[]) => (patchStub ??= vi.fn())(...args),
          },
        },
      },
    },
  }),
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const config: AppConfig = {
  feishu: { appId: 'app-id', appSecret: 'app-secret' },
  claude: { model: 'claude-opus-4-8', effort: 'medium', stopGraceMs: 5000 },
  idle: { watchdogMinutes: 15 },
  defaultAgent: 'claude',
  logging: { level: 'info' },
};

/** axios-style socket-close failure: no HTTP response, transient code. */
function socketClosedError(): Error {
  return Object.assign(new Error('Socket is closed'), {
    isAxiosError: true,
    code: 'ERR_SOCKET_CLOSED',
  });
}

function getWrappedPatch(connector: FeishuConnector) {
  return connector.channel.rawClient.im.v1.message.patch;
}

const request = { path: { message_id: 'om_retry' }, data: { content: '{}' } };

beforeEach(() => {
  patchStub = vi.fn();
});

describe('message.patch retry on transient errors', () => {
  it('retries a socket-closed failure and returns the eventual success', async () => {
    patchStub
      .mockRejectedValueOnce(socketClosedError())
      .mockResolvedValueOnce({ code: 0, msg: 'ok' });

    const connector = new FeishuConnector(config);
    const result = await getWrappedPatch(connector)(request);

    expect(patchStub).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ code: 0, msg: 'ok' });
  }, 20_000);

  it(`gives up after ${PATCH_MAX_RETRIES} retries and rethrows the last error`, async () => {
    patchStub.mockRejectedValue(socketClosedError());

    const connector = new FeishuConnector(config);
    const patch = getWrappedPatch(connector);

    await expect(patch(request)).rejects.toMatchObject({ code: 'ERR_SOCKET_CLOSED' });
    // 1 次原始尝试 + PATCH_MAX_RETRIES 次重试
    expect(patchStub).toHaveBeenCalledTimes(PATCH_MAX_RETRIES + 1);
  }, 20_000);

  it('retries 5xx but NOT 4xx business rejections', async () => {
    patchStub
      .mockRejectedValueOnce(Object.assign(new Error('bad gateway'), { response: { status: 502 } }))
      .mockResolvedValueOnce({ code: 0, msg: 'ok' });
    const connector = new FeishuConnector(config);
    await expect(getWrappedPatch(connector)(request)).resolves.toEqual({ code: 0, msg: 'ok' });
    expect(patchStub).toHaveBeenCalledTimes(2);

    patchStub.mockReset();
    const badRequest = Object.assign(new Error('bad request'), {
      response: { status: 400, data: { code: 230027 } },
    });
    patchStub.mockRejectedValue(badRequest);
    const connector2 = new FeishuConnector(config);
    await expect(getWrappedPatch(connector2)(request)).rejects.toBe(badRequest);
    // 4xx 重试没有意义：一次就放弃
    expect(patchStub).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('does not retry a plain programming error', async () => {
    const bug = new TypeError('x is not a function');
    patchStub.mockRejectedValue(bug);

    const connector = new FeishuConnector(config);
    await expect(getWrappedPatch(connector)(request)).rejects.toBe(bug);
    expect(patchStub).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('still passes business-code responses through without retrying', async () => {
    patchStub.mockResolvedValue({ code: 11310, msg: 'too many tables' });

    const connector = new FeishuConnector(config);
    const result = await getWrappedPatch(connector)(request);

    expect(result).toEqual({ code: 11310, msg: 'too many tables' });
    expect(patchStub).toHaveBeenCalledTimes(1);
  }, 20_000);
});
