/**
 * Characterization 钉子：DshApprovalTracker 的乱序配对 / waitForBinding 时序。
 * 纯结构拆分不得改变这里的返回顺序、绑定归属与超时/abort 语义。
 */
import { describe, it, expect } from 'vitest';
import { DshApprovalTracker } from './approval.js';

function audit(approvalId: string, callId?: string, toolName = 'Bash') {
  return { approvalId, ...(callId ? { callId } : {}), toolName };
}
function waterfall(eventId: string, callId?: string, toolName = 'Bash', clientId = 'cli-1') {
  return { eventId, clientId, ...(callId ? { callId } : {}), toolName };
}

describe('DshApprovalTracker.onWaterfall (characterization)', () => {
  it('audit 先到、waterfall 后到：按 callId 配对', () => {
    const t = new DshApprovalTracker();
    expect(t.onAuditAsked(audit('a1', 'c1'))).toBeUndefined();
    const binding = t.onWaterfall(waterfall('e1', 'c1'));
    expect(binding).toMatchObject({ audit: { approvalId: 'a1' }, waterfall: { eventId: 'e1' } });
  });

  it('waterfall 先到、audit 后到：按 callId 配对', () => {
    const t = new DshApprovalTracker();
    expect(t.onWaterfall(waterfall('e1', 'c1'))).toBeUndefined();
    const binding = t.onAuditAsked(audit('a1', 'c1'));
    expect(binding?.waterfall.eventId).toBe('e1');
  });

  it('waterfall 无 callId：按 toolName 与最老未绑定 audit 配对', () => {
    const t = new DshApprovalTracker();
    t.onAuditAsked(audit('a1', undefined, 'Bash'));
    const binding = t.onWaterfall(waterfall('e1', undefined, 'Bash'));
    expect(binding?.audit.approvalId).toBe('a1');
  });

  it('audit 无 callId、waterfall 有 callId：按 toolName 兜底配对', () => {
    const t = new DshApprovalTracker();
    t.onAuditAsked(audit('a1', undefined, 'Bash'));
    const binding = t.onWaterfall(waterfall('e1', 'c1', 'Bash'));
    expect(binding?.audit.approvalId).toBe('a1');
  });

  it('重连重投同一 eventId：不产新 binding，刷新 clientId/reason', () => {
    const t = new DshApprovalTracker();
    t.onAuditAsked(audit('a1', 'c1'));
    t.onWaterfall(waterfall('e1', 'c1'));
    const second = t.onWaterfall({
      ...waterfall('e1', 'c1', 'Bash', 'cli-2'),
      reason: 'new reason',
    });
    expect(second).toBeUndefined();
    expect(t.getBinding('a1')?.waterfall.clientId).toBe('cli-2');
    expect(t.getBinding('a1')?.waterfall.reason).toBe('new reason');
  });

  it('无匹配 audit 时返回 undefined', () => {
    const t = new DshApprovalTracker();
    expect(t.onWaterfall(waterfall('e1', 'c1', 'Other'))).toBeUndefined();
  });

  it('兜底配对的 waterfall 不再二次绑定到另一张卡', () => {
    const t = new DshApprovalTracker();
    // 无 callId 的 audit 先到；waterfall 有 callId 时按 toolName 兜底绑给 a1
    t.onAuditAsked(audit('a1', undefined, 'Bash'));
    expect(t.onWaterfall(waterfall('e1', 'c1', 'Bash'))?.audit.approvalId).toBe('a1');
    // 后续带同 callId 的 audit 不得抢已被绑定的同一 waterfall
    const b = t.onAuditAsked(audit('a2', 'c1', 'Bash'));
    expect(b).toBeUndefined();
    expect(t.getBinding('a1')?.waterfall.eventId).toBe('e1');
    expect(t.getBinding('a2')).toBeUndefined();
  });
});

describe('DshApprovalTracker.waitForBinding (characterization)', () => {
  it('已有 binding 时立即返回该 binding', async () => {
    const t = new DshApprovalTracker();
    t.onAuditAsked(audit('a1', 'c1'));
    const binding = t.onWaterfall(waterfall('e1', 'c1'));
    await expect(t.waitForBinding('a1', 1000)).resolves.toBe(binding);
  });

  it('等待窗口内 binding 到达时以 binding resolve', async () => {
    const t = new DshApprovalTracker();
    const pending = t.waitForBinding('a1', 1000);
    t.onAuditAsked(audit('a1', 'c1'));
    t.onWaterfall(waterfall('e1', 'c1'));
    await expect(pending).resolves.toMatchObject({ audit: { approvalId: 'a1' } });
  });

  it('超时以 undefined resolve', async () => {
    const t = new DshApprovalTracker();
    await expect(t.waitForBinding('a1', 5)).resolves.toBeUndefined();
  });

  it('signal 已 abort 时立即返回 undefined（不注册 waiter）', async () => {
    const t = new DshApprovalTracker();
    const c = new AbortController();
    c.abort();
    await expect(t.waitForBinding('a1', 1000, c.signal)).resolves.toBeUndefined();
  });

  it('等待中 abort 以 undefined resolve', async () => {
    const t = new DshApprovalTracker();
    const c = new AbortController();
    const pending = t.waitForBinding('a1', 1000, c.signal);
    c.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it('onDecided 在 waterfall 未到时以 undefined 唤醒 waiter', async () => {
    const t = new DshApprovalTracker();
    t.onAuditAsked(audit('a1', 'c1'));
    const pending = t.waitForBinding('a1', 1000);
    t.onDecided('a1');
    await expect(pending).resolves.toBeUndefined();
  });

  it('clear() 以 undefined 唤醒所有 waiter', async () => {
    const t = new DshApprovalTracker();
    const pending = t.waitForBinding('a1', 1000);
    t.clear();
    await expect(pending).resolves.toBeUndefined();
  });
});
