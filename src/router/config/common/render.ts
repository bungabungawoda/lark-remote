/**
 * Shared config card rendering logic.
 *
 * Builds CardKit 2.0 elements for config fields (boolean toggle, select dropdown, input).
 * Used by all agent config builders and the shared tabs (idle, output, logging).
 */

import { getConfigValue, type AppConfig } from '../../../config/index.js';
import type { ConfigField } from '../types.js';

/** A tab/section in the config card. */
export interface ConfigTab {
  id: string;
  label: string;
  fields: ConfigField[];
}

/** Build CardKit 2.0 elements for a list of config fields. */
function buildFieldElements(fields: ConfigField[], displayConfig: AppConfig): object[] {
  const elements: object[] = [];
  for (const field of fields) {
    // Get current value from displayConfig for dynamic fields
    const currentValue = getConfigValue(displayConfig, field.key);

    if (field.type === 'boolean') {
      // For boolean, use field.currentValue if set, otherwise use config value
      const isOn =
        field.currentValue !== undefined ? field.currentValue === true : currentValue === true;
      elements.push(buildBooleanElement(field, isOn));
    } else if (field.type === 'select' && field.options) {
      elements.push(buildSelectElement(field, currentValue));
    } else if (field.type === 'note') {
      // 纯说明行：无 config.* 回调，只渲染 label 为 markdown 文本。
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: field.label } });
    } else {
      elements.push(buildInputElement(field, currentValue));
    }
  }
  return elements;
}

function buildBooleanElement(field: ConfigField, isOn: boolean): object {
  const displayVal = isOn ? '✅ 已开启' : '⚪ 已关闭';
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 2,
        vertical_align: 'center',
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: field.label } }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: displayVal },
            type: isOn ? 'primary' : 'default',
            behaviors: [{ type: 'callback', value: { cmd: 'config.toggle', key: field.key } }],
          },
        ],
      },
    ],
  };
}

function buildSelectElement(field: ConfigField, currentValue: unknown): object {
  // 优先使用 field.currentValue（卡片显示用覆盖值），否则使用 config 中的值
  const selectedValue =
    field.currentValue != null
      ? String(field.currentValue)
      : currentValue == null
        ? undefined
        : String(currentValue);
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 2,
        vertical_align: 'center',
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: field.label } }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        vertical_align: 'center',
        elements: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: '请选择' },
            options: field.options!.map((opt) => {
              const text = typeof opt === 'string' ? opt : opt.text;
              const value = typeof opt === 'string' ? opt : opt.value;
              return { text: { tag: 'plain_text', content: text }, value };
            }),
            initial_option: selectedValue,
            behaviors: [{ type: 'callback', value: { cmd: 'config.set', key: field.key } }],
          },
        ],
      },
    ],
  };
}

function buildInputElement(field: ConfigField, currentValue: unknown): object {
  // 优先使用 field.currentValue（允许覆盖 displayConfig 中的值）
  const currentStr =
    field.currentValue != null
      ? String(field.currentValue)
      : currentValue == null
        ? ''
        : String(currentValue);
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 2,
        vertical_align: 'center',
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: field.label } }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        vertical_align: 'center',
        elements: [
          {
            tag: 'input',
            name: field.key,
            placeholder: { tag: 'plain_text', content: '请输入值' },
            default_value: currentStr,
            behaviors: [{ type: 'callback', value: { cmd: 'config.input', key: field.key } }],
          },
        ],
      },
    ],
  };
}

/** Build the full CardKit 2.0 card from tabs. */
export function buildConfigCardFromTabs(tabs: ConfigTab[], displayConfig: AppConfig): object {
  const elements: object[] = [];
  for (const tab of tabs) {
    const fieldElements = buildFieldElements(tab.fields, displayConfig);
    // Section header - bold markdown
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${tab.label}**` } });
    // Section fields
    elements.push(...fieldElements);
    elements.push({ tag: 'hr' });
  }

  // 底部保存按钮
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '💾 保存所有修改' },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { cmd: 'config.save' } }],
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '⚙️ 系统配置' }, template: 'blue' as const },
    body: { elements },
  };
}
