import { describe, it, expect } from 'vitest';
import { isImmediateAction } from './index.js';

/**
 * Tests for isImmediateAction function (§9.19).
 *
 * This function determines which card actions bypass the serial queue
 * and execute immediately via enqueue({ immediate: true }).
 *
 * Immediate actions (return true):
 * - Control operations that don't spawn Claude（表驱动清单与生产
 *   IMMEDIATE_ACTION_CMDS 一一对应）
 * - help.* wildcard
 *
 * Non-immediate actions (return false):
 * - order.exec: WORK operation that calls forwardToClaude to spawn claude
 *   （index.ts 在 enqueue 边界拦截，不经本分发器，故不在此断言）
 * - Other regular user messages (non-cardAction)
 */

describe('isImmediateAction (§9.19)', () => {
  describe('control operations that should return true (immediate)', () => {
    // W3.7：24 个单行 it 收敛为表驱动（用例名即命令名，语义不变）。
    it.each([
      ['new-session', '§9.19: 只清 sessionId'],
      ['stop', '§9.19: 中止当前运行'],
      ['ls.file', '§9.19: 只发送文件'],
      ['ls.refresh', '列表刷新（只读）'],
      ['ls.browse', '目录浏览（只读）'],
      ['ls.switch', '目录切换（只写 sessionId）'],
      ['ls.page', '分页（control operation）'],
      ['ws.remove', '§9.19: 只删除 workspace 别名'],
      ['resume.use', '§9.19: 只设置 sessionId'],
      ['resume.page', '分页（control operation）'],
      ['ws.use', '§9.6 workspace switch'],
      ['ws.page', 'pagination is a control operation'],
      ['ws.sort', '排序切换（control operation）'],
      ['active.page', '分页操作，只更新卡片，不 spawn agent'],
      ['queue.cancel', '§9.6 queue management'],
      ['queue.immediate', '§9.6 queue management'],
      ['queue.diagnose', '§9.6 queue management'],
      ['queue.edit', '§9.6 queue management'],
      ['queue.input', '§9.6 queue management'],
      ['order.delete', '§9.19: 只删除指令，不涉及 Claude 执行'],
      ['order.page', '分页（control operation）'],
      ['order.aliasEdit', '弹编辑卡（control operation）'],
      ['order.aliasInput', '提交别名（control operation）'],
      ['order.aliasRemove', '删除别名（control operation）'],
      ['order.textEdit', '弹编辑卡（control operation）'],
      ['order.textInput', '提交文本编辑（control operation）'],
      ['config.toggle', 'config 卡片操作（串行化见 config.save 注释）'],
      ['config.set', 'config 卡片操作'],
      ['config.input', 'config 卡片操作'],
      ['config.save', 'config 保存'],
      [
        'approval.respond',
        '审批响应必须即时触达在途 run（串行会死锁，见 IMMEDIATE_ACTION_CMDS 注释）',
      ],
      ['approval.toggle', '权限切换（同审批死锁语义）'],
      ['approval.answer', 'AskUserQuestion 即时响应'],
      ['approval.answerSubmit', 'AskUserQuestion 多选提交'],
      ['approval.answerCustom', 'AskUserQuestion 自定义答案'],
      ['approval.answerNote', 'AskUserQuestion 补充说明'],
      ['approval.planFeedback', '计划审批修改意见即时保存'],
    ])('%s should return true', (cmd) => {
      expect(isImmediateAction(cmd)).toBe(true);
    });

    // help.* wildcard: help 按钮执行只读命令
    it.each(['help.status', 'help.ps', 'help.stop'])(
      '%s should return true (help.* wildcard)',
      (cmd) => {
        expect(isImmediateAction(cmd)).toBe(true);
      },
    );
  });

  describe('work operations that should return false (enqueue)', () => {
    // Unknown commands should return false (will be enqueued normally)
    it('unknown command should return false', () => {
      expect(isImmediateAction('bogus')).toBe(false);
    });

    it('empty string should return false', () => {
      expect(isImmediateAction('')).toBe(false);
    });
  });
});
