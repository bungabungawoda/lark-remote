/**
 * Shared config card rendering logic.
 *
 * Builds CardKit 2.0 elements for config fields (select dropdown, input, note).
 * Used by all agent config builders and the shared tabs (idle, logging).
 *
 * 控件形态只有 `ConfigField.type` 里那三种，且每种在本文件都有对应 builder：
 * 渲染端与处理端（router 的 `config.set` / `config.input`）必须一一对应，
 * 「渲染得出按钮、点了没人处理」是禁止状态（守卫见 config-card-controls.test.ts）。
 */

import { getConfigValue, type AppConfig } from '../../../config/index.js';
import { cardButton } from '../../../card/card-shared.js';
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

    if (field.type === 'select' && field.options) {
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

/** 配置项统一行：左 label（2 份宽）+ 右控件（3 份宽）。 */
function fieldRow(label: string, control: object): object {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 2,
        vertical_align: 'center',
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: label } }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        vertical_align: 'center',
        elements: [control],
      },
    ],
  };
}

/** 选中值：优先 field.currentValue（卡片显示覆盖值），否则取 config 值。 */
function resolveSelectedValue(field: ConfigField, currentValue: unknown): string | undefined {
  const value = field.currentValue != null ? field.currentValue : currentValue;
  return value == null ? undefined : String(value);
}

function buildSelectElement(field: ConfigField, currentValue: unknown): object {
  const selectedValue = resolveSelectedValue(field, currentValue);
  const options = field.options!.map((opt) => ({
    text: { tag: 'plain_text', content: optionText(opt) },
    value: optionValue(opt),
  }));
  // 目录刷新后草稿里的值可能已不在新清单里。不静默改草稿（保存会写入用户
  // 没选过的值），也别让 initial_option 指向一个不存在的选项；把当前值作为
  // 显式标注的兜底选项留在下拉里，由用户决定要不要重选。
  // 目录为空表示「没探到清单」，此时不能拿一个孤立的当前值冒充清单本身：
  // 空下拉要继续走 builder 的 default 语义（codex 档位目录为空时即如此）。
  if (selectedValue && options.length > 0 && !options.some((opt) => opt.value === selectedValue)) {
    options.unshift({
      text: { tag: 'plain_text', content: `${selectedValue}（当前，已失效）` },
      value: selectedValue,
    });
  }
  return fieldRow(field.label, {
    tag: 'select_static',
    placeholder: { tag: 'plain_text', content: '请选择' },
    options,
    initial_option: selectedValue,
    behaviors: [{ type: 'callback', value: { cmd: 'config.set', key: field.key } }],
  });
}

function optionText(opt: string | { text: string }): string {
  return typeof opt === 'string' ? opt : opt.text;
}

function optionValue(opt: string | { value: string }): string {
  return typeof opt === 'string' ? opt : opt.value;
}

function buildInputElement(field: ConfigField, currentValue: unknown): object {
  // 优先使用 field.currentValue（允许覆盖 displayConfig 中的值）
  const currentStr =
    field.currentValue != null
      ? String(field.currentValue)
      : currentValue == null
        ? ''
        : String(currentValue);
  return fieldRow(field.label, {
    tag: 'input',
    name: field.key,
    placeholder: { tag: 'plain_text', content: '请输入值' },
    default_value: currentStr,
    behaviors: [{ type: 'callback', value: { cmd: 'config.input', key: field.key } }],
  });
}

/**
 * 刷新按钮行：与表单行同构（左列 weight 2 + 右列 weight 3），与上方控件列
 * 左右对齐、同宽。裸 `body` 级 button 占满整行。左列放一个空格 `plain_text`
 * 占位，不用空 `lark_md`（空内容未验证过）。
 */
function refreshButtonRow(): object {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 2,
        vertical_align: 'center',
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: ' ' } }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        vertical_align: 'center',
        elements: [cardButton('🔄 刷新模型', { cmd: 'config.refresh' }, { type: 'default' })],
      },
    ],
  };
}

/** Build the full CardKit 2.0 card from tabs. */
export function buildConfigCardFromTabs(tabs: ConfigTab[], displayConfig: AppConfig): object {
  const elements: object[] = [];
  tabs.forEach((tab, tabIndex) => {
    // Section header - bold markdown
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${tab.label}**` } });
    // Section fields
    elements.push(...buildFieldElements(tab.fields, displayConfig));
    // 刷新按钮行收在第一个 tab（当前 agent 配置区）的最底部、分区分隔线之前：
    // 刷新重取的是该 agent 的 provider / 模型清单，语义上属于整个配置区，
    // 不锚定某个字段。交互控件直挂 column/body 的 elements：CardKit 2.0
    // 不允许 V1 `action` 容器（200861）。
    if (tabIndex === 0) {
      elements.push(refreshButtonRow());
    }
    elements.push({ tag: 'hr' });
  });

  elements.push(cardButton('💾 保存所有修改', { cmd: 'config.save' }, { type: 'primary' }));

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '⚙️ 系统配置' }, template: 'blue' as const },
    body: { elements },
  };
}
