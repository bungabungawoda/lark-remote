/**
 * 非直返 card action 的异步回执判定（clean_review §B7）。
 *
 * @entry `src/index.ts` 的 card action 分发只有两类出口：
 *   - `DIRECT_RETURN_CMDS`：同步 return 给飞书回调，toast 能弹；
 *   - 其余走 `bridge.enqueueImmediate` / `bridge.enqueue`（fire-and-forget，
 *     回调响应早已被飞书收走），handler 返回的 `CardActionResponse.toast`
 *     **无处可去**——用户点了毫无反馈。
 * 本函数是异步出口的收敛判定：返回要作为持久文本消息发出的文案，或 undefined。
 *
 * 为什么失败必须回执、成功不回执：卡片本身只承载成功态（原地刷新后列表/筛选
 * 已经是真的），失败（陈旧列表、路径已删、payload 缺失）在卡片上完全看不出来，
 * 不发消息就等于静默失败。逐次成功回执则会把聊天刷成日志。
 */
import { describe, it, expect } from 'vitest';
import { actionFeedbackText } from './card-action-feedback.js';

describe('actionFeedbackText（非直返 card action 的异步回执）', () => {
  it('error / warning toast 转发为文本消息', () => {
    expect(actionFeedbackText({ toast: { type: 'error', content: 'workspace "x" 不存在' } })).toBe(
      'workspace "x" 不存在',
    );
    expect(actionFeedbackText({ toast: { type: 'warning', content: '路径无效' } })).toBe(
      '路径无效',
    );
  });

  it('成功类 toast 不转发（原地刷新的卡片已经表达）', () => {
    for (const type of ['success', 'info', 'loading'] as const) {
      expect(
        actionFeedbackText({ toast: { type, content: '已删除 workspace "x"' } }),
      ).toBeUndefined();
    }
  });

  it('空文案不转发（不发空气泡）', () => {
    expect(actionFeedbackText({ toast: { type: 'error', content: '   ' } })).toBeUndefined();
    expect(actionFeedbackText({ toast: { type: 'error' } })).toBeUndefined();
  });

  it('无响应体、无 toast 或非法结构 → undefined（不抛）', () => {
    expect(actionFeedbackText(undefined)).toBeUndefined();
    expect(actionFeedbackText(null)).toBeUndefined();
    expect(actionFeedbackText({ card: {} })).toBeUndefined();
    expect(actionFeedbackText('nonsense')).toBeUndefined();
    expect(actionFeedbackText({ toast: 'not-an-object' })).toBeUndefined();
  });

  it('前后空白被裁掉后再转发', () => {
    expect(actionFeedbackText({ toast: { type: 'error', content: '\n  删除失败  \n' } })).toBe(
      '删除失败',
    );
  });
});
