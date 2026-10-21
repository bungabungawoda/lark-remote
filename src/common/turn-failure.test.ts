import { describe, expect, it } from 'vitest';
import { isContentFilterFailure } from './turn-failure.js';

describe('isContentFilterFailure', () => {
  it('识别 DSH 透传的 content_filter 报文', () => {
    expect(
      isContentFilterFailure(
        'turn ended with reason: error: Provider finish_reason: content_filter',
      ),
    ).toBe(true);
    expect(isContentFilterFailure('Provider finish_reason: content_filter')).toBe(true);
  });

  it('容忍大小写、多余空格与引号', () => {
    expect(isContentFilterFailure('provider FINISH_REASON:  Content_Filter')).toBe(true);
    expect(isContentFilterFailure('finish_reason:"content_filter"')).toBe(true);
    expect(isContentFilterFailure("finish_reason: 'content_filter'")).toBe(true);
  });

  it('其它 finish_reason 不误判', () => {
    expect(isContentFilterFailure('Provider finish_reason: network_error')).toBe(false);
    expect(isContentFilterFailure('Provider finish_reason: length')).toBe(false);
    expect(
      isContentFilterFailure('turn ended with reason: error: DSH HTTP 401 for session.create'),
    ).toBe(false);
  });

  it('缺失或空值不抛异常', () => {
    expect(isContentFilterFailure(undefined)).toBe(false);
    expect(isContentFilterFailure('')).toBe(false);
  });

  it('不把包含 content_filter 字样的普通文本当失败原因以外的误判源', () => {
    // 关键词必须挂在 finish_reason 上，避免工具输出里出现该词就触发续跑。
    expect(isContentFilterFailure('grep 结果：content_filter 出现在代码里')).toBe(false);
  });
});
