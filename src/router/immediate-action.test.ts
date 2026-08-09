import { describe, it, expect } from 'vitest';
import { isImmediateAction } from './index.js';

/**
 * Tests for isImmediateAction function (§9.19).
 *
 * This function determines which card actions bypass the serial queue
 * and execute immediately via enqueue({ immediate: true }).
 *
 * Immediate actions (return true):
 * - Control operations that don't spawn Claude: new-session, stop, ls.file,
 *   ws.remove, resume.use, help.*, ws.use,
 *   queue.cancel, queue.immediate, queue.diagnose, order.delete
 *
 * Non-immediate actions (return false):
 * - order.exec: WORK operation that calls forwardToClaude to spawn claude
 * - Other regular user messages (non-cardAction)
 */

describe('isImmediateAction (§9.19)', () => {
  describe('control operations that should return true (immediate)', () => {
    // §9.19: new-session - 只清 sessionId
    it('new-session should return true', () => {
      expect(isImmediateAction('new-session')).toBe(true);
    });

    // §9.19: stop - 中止当前运行
    it('stop should return true', () => {
      expect(isImmediateAction('stop')).toBe(true);
    });

    // §9.19: ls.file - 只发送文件
    it('ls.file should return true', () => {
      expect(isImmediateAction('ls.file')).toBe(true);
    });

    // §9.19: ws.remove - 只删除 workspace 别名
    it('ws.remove should return true', () => {
      expect(isImmediateAction('ws.remove')).toBe(true);
    });

    // §9.19: resume.use - 只设置 sessionId
    it('resume.use should return true', () => {
      expect(isImmediateAction('resume.use')).toBe(true);
    });

    // §9.19: help.* - help 按钮执行只读命令
    it('help.status should return true', () => {
      expect(isImmediateAction('help.status')).toBe(true);
    });

    it('help.ps should return true', () => {
      expect(isImmediateAction('help.ps')).toBe(true);
    });

    it('help.stop should return true', () => {
      expect(isImmediateAction('help.stop')).toBe(true);
    });

    // Existing workspace switch commands (§9.6)
    it('ws.use should return true', () => {
      expect(isImmediateAction('ws.use')).toBe(true);
    });

    // Queue management commands (§9.6)
    it('queue.cancel should return true', () => {
      expect(isImmediateAction('queue.cancel')).toBe(true);
    });

    it('queue.immediate should return true', () => {
      expect(isImmediateAction('queue.immediate')).toBe(true);
    });

    it('queue.diagnose should return true', () => {
      expect(isImmediateAction('queue.diagnose')).toBe(true);
    });

    // §9.19: order.delete - 只删除指令，不涉及 Claude 执行
    it('order.delete should return true', () => {
      expect(isImmediateAction('order.delete')).toBe(true);
    });
  });

  describe('work operations that should return false (enqueue)', () => {
    // Note: order.exec is no longer routed through isImmediateAction —
    // index.ts intercepts it at the enqueue boundary (resolveOrderExecForQueue)
    // before this dispatcher is consulted. It is therefore not asserted here.

    // Unknown commands should return false (will be enqueued normally)
    it('unknown command should return false', () => {
      expect(isImmediateAction('bogus')).toBe(false);
    });

    it('empty string should return false', () => {
      expect(isImmediateAction('')).toBe(false);
    });
  });
});
