import { describe, it, expect, vi } from 'vitest';
import { withBusyRetry, isBusyError } from './fs.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../logger/index.js', () => ({ getLogger: () => mockLogger }));

function busyErr(code: 'EPERM' | 'EBUSY'): Error {
  return Object.assign(new Error(code), { code });
}

describe('isBusyError', () => {
  it('识别 win32 占用错误码 EPERM/EBUSY，其他错误不算占用', () => {
    expect(isBusyError(busyErr('EPERM'))).toBe(true);
    expect(isBusyError(busyErr('EBUSY'))).toBe(true);
    expect(isBusyError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isBusyError(new Error('no code'))).toBe(false);
    expect(isBusyError(null)).toBe(false);
  });
});

describe('withBusyRetry（§6 win32 句柄占用重试，仅 win32 生效）', () => {
  it('win32：占用错误按退避序列重试，中途成功返回结果', () => {
    const op = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw busyErr('EPERM');
      })
      .mockImplementationOnce(() => {
        throw busyErr('EBUSY');
      })
      .mockReturnValue('ok');
    expect(withBusyRetry(op, { platform: 'win32' })).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('win32：重试耗尽后抛最后一个错误并回调 onGiveUp（告警/保留现场用）', () => {
    const op = vi.fn<() => never>().mockImplementation(() => {
      throw busyErr('EBUSY');
    });
    const onGiveUp = vi.fn();
    expect(() => withBusyRetry(op, { platform: 'win32', onGiveUp })).toThrow('EBUSY');
    // MAX_RETRY_ATTEMPTS=5：共 5 次尝试
    expect(op).toHaveBeenCalledTimes(5);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith(expect.objectContaining({ code: 'EBUSY' }));
  });

  it('posix：占用错误不重试、立即失败（避免忙等阻塞事件循环），仍回调 onGiveUp', () => {
    const op = vi.fn<() => never>().mockImplementation(() => {
      throw busyErr('EPERM');
    });
    const onGiveUp = vi.fn();
    expect(() => withBusyRetry(op, { platform: 'linux', onGiveUp })).toThrow('EPERM');
    expect(op).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('darwin：同 posix 立即失败（门控按是否 win32）', () => {
    const op = vi.fn<() => never>().mockImplementation(() => {
      throw busyErr('EBUSY');
    });
    expect(() => withBusyRetry(op, { platform: 'darwin' })).toThrow('EBUSY');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('非占用错误两平台都立即抛出，不重试', () => {
    const op = vi.fn<() => never>().mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    expect(() => withBusyRetry(op, { platform: 'win32' })).toThrow('EACCES');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('win32 成功路径零开销（op 只调一次）', () => {
    const op = vi.fn<() => number>().mockReturnValue(42);
    expect(withBusyRetry(op, { platform: 'win32' })).toBe(42);
    expect(op).toHaveBeenCalledTimes(1);
  });
});
