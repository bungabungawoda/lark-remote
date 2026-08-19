import { describe, it, expect } from 'vitest';
import type { CardActionEvent } from '@larksuite/channel';
import { buildCardActionFullValue } from './card-action-payload.js';

/**
 * Entry-layer payload assembly contract（2026-08-18 线上 P0：AskUserQuestion
 * 选项按钮点击报「缺少问题答案参数」——button 回调的 behavior value 里写好的
 * `option` 被 action.action.option（button 无此字段，恒 undefined）覆盖丢失，
 * router 参数校验拒绝，bridge 从未被调用）。
 */
function buttonEvent(value: Record<string, unknown>): CardActionEvent {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    operator: { openId: 'ou-1' },
    action: { value, tag: 'button' },
  };
}

describe('buildCardActionFullValue', () => {
  it('preserves behavior-value option/formValue for button callbacks (AskUserQuestion P0)', () => {
    const value = {
      cmd: 'approval.answer',
      requestId: 7,
      questionIndex: 0,
      option: 'Red',
      nonce: 'n1',
    };
    const full = buildCardActionFullValue(value, buttonEvent(value));
    expect(full.option).toBe('Red');
    expect(full.questionIndex).toBe(0);
    expect(full.nonce).toBe('n1');
  });

  it('prefers component out-of-band option/formValue when present (select/form)', () => {
    const full = buildCardActionFullValue(
      { cmd: 'config.set', key: 'claude.model' },
      {
        messageId: 'msg-2',
        chatId: 'chat-2',
        operator: { openId: 'ou-2' },
        action: {
          value: { cmd: 'config.set', key: 'claude.model' },
          tag: 'select_static',
          option: 'haiku',
          formValue: { field: 'x' },
        },
      },
    );
    expect(full.option).toBe('haiku');
    expect(full.formValue).toEqual({ field: 'x' });
  });

  it('reads multi-select options and input_value from the raw event (SDK normalizer drops them)', () => {
    const full = buildCardActionFullValue(
      { cmd: 'approval.answerCustom', requestId: 9, questionIndex: 0, nonce: 'n2' },
      {
        messageId: 'msg-3',
        chatId: 'chat-3',
        operator: { openId: 'ou-3' },
        action: { value: { cmd: 'approval.answerCustom' }, tag: 'input' },
        raw: {
          action: {
            input_value: '自定义答案',
            options: ['Cheese', 'Bacon'],
          },
        },
      },
    );
    expect(full.inputValue).toBe('自定义答案');
    expect(full.options).toEqual(['Cheese', 'Bacon']);
  });
});
