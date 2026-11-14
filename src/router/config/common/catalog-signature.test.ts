/**
 * 目录签名 + /config 刷新按钮守卫。
 *
 * 后台探测落地后要不要补刷卡片，全靠这份签名判定；判据错了会退化成两种
 * 事故：每次打开都无谓 PATCH（撞 230429），或目录变了却静默不刷（回到
 * 「无法刷新 provider / 模型列表」）。
 */
import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../../config/index.js';
import { enforceCardBudget } from '../../../card/card-budget.js';
import { expectNoV1ActionContainer } from '../../../../tests/lib/card-view.js';
import { catalogSignature } from './catalog-signature.js';
import { buildConfigCardFromTabs } from './render.js';
import type { ConfigField } from '../types.js';
import type { ConfigTab } from './render.js';

const config = AppConfigSchema.parse({ feishu: { appId: 'test', appSecret: 'test' } });

function field(overrides: Partial<ConfigField> & { key: string }): ConfigField {
  return { label: overrides.key, type: 'select', options: [], ...overrides };
}

describe('catalogSignature', () => {
  it('选项顺序与字段顺序都不影响签名', () => {
    const a = [
      field({ key: 'p', options: ['b', 'a', 'c'] }),
      field({ key: 'm', options: ['x', 'y'] }),
    ];
    const b = [
      field({ key: 'm', options: ['y', 'x'] }),
      field({ key: 'p', options: ['c', 'a', 'b'] }),
    ];
    expect(catalogSignature(a)).toBe(catalogSignature(b));
  });

  it('新增或移除一个选项会改变签名', () => {
    const base = [field({ key: 'p', options: ['a', 'b'] })];
    const grown = [field({ key: 'p', options: ['a', 'b', 'c'] })];
    expect(catalogSignature(grown)).not.toBe(catalogSignature(base));
  });

  it('显示文本变化也会改变签名（费率等注记是用户可见内容）', () => {
    const plain = [field({ key: 'm', options: ['gpt-x'] })];
    const priced = [field({ key: 'm', options: [{ value: 'gpt-x', text: 'gpt-x x0.29' }] })];
    expect(catalogSignature(priced)).not.toBe(catalogSignature(plain));
  });

  it('input / note 字段不进签名', () => {
    const base = [field({ key: 'p', options: ['a'] })];
    const withInput = [
      ...base,
      field({ key: 'idle.watchdogMinutes', type: 'input' }),
      field({ key: 'hint', type: 'note', label: '随便写点什么' }),
    ];
    expect(catalogSignature(withInput)).toBe(catalogSignature(base));
  });
});

/** 从卡片里取出顶层元素，供按钮位置与裁剪断言。 */
function bodyElements(card: object): Array<Record<string, unknown>> {
  return (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
}

function tab(fields: ConfigField[]): ConfigTab[] {
  return [{ id: 'agent', label: '🤖 测试', fields }];
}

function buttonCmd(el: Record<string, unknown>): string | undefined {
  return (el.behaviors as Array<{ value: { cmd: string } }> | undefined)?.[0]?.value.cmd;
}

/** 递归收集所有 button（刷新按钮行嵌在 column_set 里）。 */
function collectButtons(elements: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const el of elements) {
    if (el.tag === 'button') out.push(el);
    const columns = el.columns as Array<Record<string, unknown>> | undefined;
    if (columns) {
      for (const col of columns) {
        out.push(...collectButtons((col.elements ?? []) as Array<Record<string, unknown>>));
      }
    }
  }
  return out;
}

describe('/config 刷新按钮', () => {
  it('刷新按钮行收在 agent 配置区最底部（分隔线之前），右列 weight 3 与控件列对齐', () => {
    const card = buildConfigCardFromTabs(
      tab([
        field({ key: 'agents.pi.provider', options: ['a'] }),
        field({ key: 'agents.pi.model', options: ['m1'] }),
        field({ key: 'agents.pi.thinking', options: ['low'] }),
      ]),
      config,
    );
    const elements = bodyElements(card);
    const hrIndex = elements.findIndex((el) => el.tag === 'hr');
    // 第一个分区的最后一个元素就是刷新按钮行（思考级别之后）
    const row = elements[hrIndex - 1]!;
    expect(row.tag).toBe('column_set');
    const columns = row.columns as Array<{
      weight?: number;
      elements: Array<Record<string, unknown>>;
    }>;
    expect(columns[0]!.weight).toBe(2);
    expect(columns[1]!.weight).toBe(3);
    expect(buttonCmd(columns[1]!.elements[0]!)).toBe('config.refresh');
    // 按钮行不紧跟模型下拉，而是整个配置区（含思考级别）之后
    const thinkingIndex = elements.findIndex((el) =>
      JSON.stringify(el).includes('agents.pi.thinking'),
    );
    expect(elements.indexOf(row)).toBeGreaterThan(thinkingIndex);
    // 保存按钮仍在末尾
    const allButtons = collectButtons(elements);
    expect(buttonCmd(allButtons[allButtons.length - 1]!)).toBe('config.save');
    expectNoV1ActionContainer(card);
  });

  it('没有模型字段的 agent：刷新按钮行同样收在配置区末尾', () => {
    const card = buildConfigCardFromTabs(
      [
        {
          id: 'agent',
          label: '🤖 测试',
          fields: [field({ key: 'agents.x.host', options: ['h'] })],
        },
        { id: 'idle', label: '⏱️ 空闲', fields: [] },
      ],
      config,
    );
    const elements = bodyElements(card);
    const hrIndex = elements.findIndex((el) => el.tag === 'hr');
    expect(elements[hrIndex - 1]!.tag).toBe('column_set');
    expect(collectButtons(elements).map(buttonCmd)).toContain('config.refresh');
  });

  it('大目录裁剪后刷新与保存按钮仍在，用户仍能发起刷新', () => {
    const fields = [
      field({ key: 'm', options: Array.from({ length: 150 }, (_, i) => `model-${i}`) }),
    ];
    const built = buildConfigCardFromTabs(tab(fields), config);
    const { card } = enforceCardBudget(built);
    const cmds = collectButtons(bodyElements(card)).map(buttonCmd);
    expect(cmds).toContain('config.refresh');
    expect(cmds).toContain('config.save');
    expectNoV1ActionContainer(card);
  });

  it('目录非空且不含当前值：追加显式「已失效」选项，空目录不凭空造清单', () => {
    const nonEmpty = buildConfigCardFromTabs(
      tab([{ ...field({ key: 'p', options: ['a', 'b'] }), currentValue: 'gone' }]),
      config,
    );
    const selectRow = bodyElements(nonEmpty).find((el) => el.tag === 'column_set') as {
      columns: Array<{ elements: Array<{ options?: Array<{ value: string }> }> }>;
    };
    const control = selectRow.columns[1]!.elements[0]!;
    expect(control.options!.map((opt) => opt.value)).toEqual(['gone', 'a', 'b']);

    const empty = buildConfigCardFromTabs(
      tab([{ ...field({ key: 'p', options: [] }), currentValue: 'high' }]),
      config,
    );
    const emptyRow = bodyElements(empty).find((el) => el.tag === 'column_set') as {
      columns: Array<{ elements: Array<{ options?: Array<{ value: string }> }> }>;
    };
    expect(emptyRow.columns[1]!.elements[0]!.options).toEqual([]);
  });
});
