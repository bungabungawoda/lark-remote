import { describe, it, expect } from 'vitest';
import { isImmediateAction } from '../../../src/router/index.js';

/**
 * Anchor (A5): `resume.page` 是 isImmediateAction 白名单成员（控制操作免排队）
 *
 * 验证：`isImmediateAction('resume.page')` 返回 true——翻页回调走
 * enqueueImmediate，不进入 spawn claude 的串行队列。
 *
 * 缺失/错误会导致：`resume.page` 被当作工作操作进入串行队列，在 claude run
 * 期间被阻塞，用户点上一页/下一页假死（无响应），与 `/ls` 分页等控制操作的
 * 免排队语义不一致，违反 §4.3 回归红线。
 *
 * 依据（docs/architecture/resume-pagination-plan.md）：
 * §2.3："`resume.page` 加入 `isImmediateAction` 白名单（`index.ts:81` 附近，
 * 控制操作免排队）。"
 * §4.3："串行队列语义不变：`resume.page` 走 `enqueueImmediate`（控制操作）。"
 */

describe('isImmediateAction — resume.page (plan §2.3/§4.3)', () => {
  it('test_anchor_resume_page_is_immediate_action', () => {
    expect(isImmediateAction('resume.page')).toBe(true);
  });
});
