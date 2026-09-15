import { describe, expect, it } from 'vitest';
import { classifyRejection } from './error-classification.js';

describe('classifyRejection', () => {
  // ===== 既有 recoverable 用例（网络瞬态）—— 防回归 =====
  it('treats 502/503/504 as recoverable', () => {
    expect(classifyRejection({ response: { status: 502 } })).toBe('recoverable');
    expect(classifyRejection({ response: { status: 503 } })).toBe('recoverable');
    expect(classifyRejection({ response: { status: 504 } })).toBe('recoverable');
  });

  it('treats ETIMEDOUT/ECONNRESET as recoverable', () => {
    expect(classifyRejection({ code: 'ETIMEDOUT' })).toBe('recoverable');
    expect(classifyRejection({ code: 'ECONNRESET' })).toBe('recoverable');
  });

  // ===== Red：2026-09-15 socket-close 生产崩溃复现 =====
  // 卡片 patch 时对端把 socket 关掉，axios 抛 ERR_SOCKET_CLOSED（无 response）。
  // 旧分类里只有 ETIMEDOUT/ECONNRESET 算 recoverable，它落到 fatal →
  // process.exit(1)，正在跑的 codex run 陪葬（lark-remote-wx pid 17721，
  // 2026-09-15 00:09:09，随后由 pycron 看门狗在 00:10:03 拉起）。
  it('treats axios ERR_SOCKET_CLOSED (card patch socket closed) as recoverable', () => {
    const socketClosed = {
      isAxiosError: true,
      code: 'ERR_SOCKET_CLOSED',
      message: 'Socket is closed',
      cause: new Error('Socket is closed'),
    };
    expect(classifyRejection(socketClosed)).toBe('recoverable');
  });

  it('treats other transient transport codes as recoverable', () => {
    for (const code of ['EPIPE', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'ERR_NETWORK']) {
      expect(classifyRejection({ code })).toBe('recoverable');
    }
  });

  // ===== 既有 fatal 用例 —— 防过度放宽 =====
  it('treats unknown TypeError as fatal', () => {
    expect(classifyRejection(new TypeError('x is not a function'))).toBe('fatal');
  });

  it('treats HTTP 500 as recoverable', () => {
    expect(classifyRejection({ response: { status: 500 } })).toBe('recoverable');
  });

  it('treats plain HTTP 400 without feishu business code as fatal', () => {
    // 无 data.code 的 400 可能是请求构造错误（代码 bug），不该当展示层失败吞掉
    expect(classifyRejection({ response: { status: 400 } })).toBe('fatal');
  });

  // ===== Red：生产崩溃复现 =====
  // 飞书 230027（外部会话无权限）patch 失败触发 unhandledRejection 而退出。
  // 错误经 SDK throttle detach 路径逃逸到 handler，handler 把 status=400 判为
  // fatal → process.exit(1)，正在进行的 claude run 陪葬。
  // 流式 patch 是尽力而为的展示层，飞书业务拒绝不应击穿进程。
  it('treats feishu 230027 (external chat permission) patch failure as recoverable', () => {
    const feishu230027 = {
      isAxiosError: true,
      code: 'ERR_BAD_REQUEST',
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: { code: 230027, msg: 'no permission to operate external chats' },
      },
    };
    expect(classifyRejection(feishu230027)).toBe('recoverable');
  });
});
