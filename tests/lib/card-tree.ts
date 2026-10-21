/**
 * CardKit 2.0 卡片结构检查单源。
 *
 * 这些 helper 只做「遍历 JSON 树、按 tag/behaviors 取值」，不依赖具体卡片
 * 渲染类型——避免每个锚点各自手抄一份遍历逻辑（此前 5 个 codex-catalog /
 * reasoning 文件 + 5 个 resume 文件逐字同构）。
 */

export type CardElementValue = {
  cmd?: string;
  agent?: string;
  offset?: number;
  pageSize?: number;
  sessionId?: string;
  key?: string;
};

export type CardElement = {
  tag?: string;
  text?: { content?: string };
  columns?: Array<{ elements?: CardElement[] }>;
  behaviors?: Array<{ value?: CardElementValue }>;
  options?: Array<{ value?: string; selected?: boolean }>;
  name?: string;
  default_value?: string;
  initial_option?: string;
  disabled?: boolean;
};

export type Card = { body?: { elements?: CardElement[] } };

/**
 * 提取 config.* 回调里出现的字段 key（config.set / config.toggle / config.input
 * 共用同一 key 字段）。JSON 正则避免依赖 behaviors 在树里的具体嵌套层级，
 * 同时兼容 cmd/key 两种键序。
 */
export function extractConfigFieldKeys(card: object): string[] {
  const keys = new Set<string>();
  const json = JSON.stringify(card);

  // Pattern 1: "cmd":"config.set","key":"<key>"
  const regex = /"cmd"\s*:\s*"config\.\w+"\s*,\s*"key"\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(json)) !== null) {
    keys.add(match[1]);
  }
  // Pattern 2: "key":"<key>","cmd":"config.set" (reverse order)
  const regex2 = /"key"\s*:\s*"([^"]+)"\s*,\s*"cmd"\s*:\s*"config\.\w+"/g;
  while ((match = regex2.exec(json)) !== null) {
    keys.add(match[1]);
  }
  return Array.from(keys);
}

/** 展开 body.elements 及 column/column_set 的 columns[].elements。 */
export function flattenElements(card: Card): CardElement[] {
  const out: CardElement[] = [];
  const walk = (els: CardElement[] | undefined) => {
    for (const el of els ?? []) {
      out.push(el);
      walk(el.columns?.flatMap((c) => c.elements ?? []));
    }
  };
  walk(card?.body?.elements);
  return out;
}

/** 找第一个文本包含 needle 的 div。 */
export function findDivWithText(elements: CardElement[], needle: string): CardElement | undefined {
  return elements.find((el) => el.tag === 'div' && (el.text?.content ?? '').includes(needle));
}

/** 卡片 header 标题（队列/状态卡断言高频使用）。 */
export function cardHeaderTitle(card: object): string {
  const header = (card as { header?: { title?: { content?: string } } }).header;
  return header?.title?.content ?? '';
}

/** 卡片 body（含 column_set 嵌套）里的全部文本行。 */
export function cardTexts(card: Card): string[] {
  return flattenElements(card)
    .map((el) => el.text?.content)
    .filter((content): content is string => typeof content === 'string');
}

/** 卡片 body（含 column_set 嵌套）里的全部按钮。 */
export function cardButtons(card: Card): CardElement[] {
  return flattenElements(card).filter((el) => el.tag === 'button');
}

/** 按回调 key 取 select_static 的选项值列表（CardKit 2.0）。
 * 命中即返回该字段的 options，不再深入其子树。
 */
export function extractSelectOptions(card: object, key: string): string[] {
  const values: string[] = [];
  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }
    const record = obj as Record<string, unknown>;
    if (record.tag === 'select_static') {
      const behaviors = record.behaviors as Array<{ value?: { key?: string } }> | undefined;
      const behavior = behaviors?.find((b) => b.value?.key === key);
      if (behavior) {
        const options = record.options as Array<{ value?: string }> | undefined;
        for (const opt of options ?? []) {
          if (typeof opt.value === 'string') values.push(opt.value);
        }
        return;
      }
    }
    for (const value of Object.values(record)) {
      traverse(value);
    }
  }
  traverse(card);
  return values;
}

export interface SelectFieldInfo {
  key: string;
  options: string[];
  initialOption?: string;
}

/** 收集卡片中所有 select_static 的 key / options / initial_option。 */
export function extractSelectFields(card: object): SelectFieldInfo[] {
  const out: SelectFieldInfo[] = [];
  function traverse(obj: unknown) {
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;
    if (record.tag === 'select_static') {
      const behavior = Array.isArray(record.behaviors)
        ? (record.behaviors[0] as { value?: { key?: string } } | undefined)
        : undefined;
      const key = behavior?.value?.key ?? '';
      const options = Array.isArray(record.options)
        ? (record.options as Array<{ value: unknown }>).map((o) => String(o.value))
        : [];
      out.push({
        key,
        options,
        initialOption:
          typeof record.initial_option === 'string' ? record.initial_option : undefined,
      });
    }
    for (const value of Object.values(record)) traverse(value);
  }
  traverse(card);
  return out;
}

export interface LabeledSelectFieldInfo {
  key: string;
  label: string;
  initialOption?: string;
}

/**
 * 收集「左列标签 + 右列 select_static」成对字段（配置卡布局）。
 * 标签可能被 `**` 包裹。
 */
export function extractLabeledSelectFields(card: object): LabeledSelectFieldInfo[] {
  const results: LabeledSelectFieldInfo[] = [];

  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }

    const record = obj as Record<string, unknown>;

    if (record.tag === 'column_set' && record.columns) {
      const columns = record.columns as Array<Record<string, unknown>>;
      let label = '';

      if (columns[0]?.elements) {
        const leftElements = columns[0].elements as Array<Record<string, unknown>>;
        for (const el of leftElements) {
          if (el.tag === 'div' && (el.text as { content?: string } | undefined)?.content) {
            const content = (el.text as { content: string }).content;
            label =
              content.startsWith('**') && content.endsWith('**') ? content.slice(2, -2) : content;
            break;
          }
        }
      }

      if (columns[1]?.elements) {
        const rightElements = columns[1].elements as Array<Record<string, unknown>>;
        for (const el of rightElements) {
          if (el.tag === 'select_static' && el.behaviors) {
            const behaviors = el.behaviors as Array<{ value?: { key?: string } }>;
            const behavior = behaviors.find((b) => b.value?.key);
            const key = behavior?.value?.key || '';
            const initialOption = el.initial_option as { text?: string } | undefined;
            results.push({ key, label, initialOption: initialOption?.text });
          }
        }
      }
      return; // 已按两列成对处理，不再递归其子树
    }

    for (const value of Object.values(record)) {
      traverse(value);
    }
  }

  traverse(card);
  return results;
}

/** 按回调 key 取 select_static 的当前选中值（initial_option）。 */
export function extractSelectCurrentValue(card: object, key: string): string | undefined {
  let current: string | undefined;
  function traverse(obj: unknown) {
    if (current !== undefined || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }
    const record = obj as Record<string, unknown>;
    if (record.tag === 'select_static') {
      const behaviors = record.behaviors as Array<{ value?: { key?: string } }> | undefined;
      const behavior = behaviors?.find((b) => b.value?.key === key);
      if (behavior) {
        current = record.initial_option as string | undefined;
        return;
      }
    }
    for (const value of Object.values(record)) {
      traverse(value);
    }
  }
  traverse(card);
  return current;
}

/**
 * 提取配置卡里的输入框。标签在左列（column_set 第一列）的 div 里，输入框
 * 在右列，元素本身只带 name/default_value；标签可能被 `**` 包裹。
 */
export function extractInputFields(
  card: object,
): Array<{ key: string; label: string; defaultValue: string }> {
  const results: Array<{ key: string; label: string; defaultValue: string }> = [];

  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }

    const record = obj as Record<string, unknown>;

    if (record.tag === 'column_set' && record.columns) {
      const columns = record.columns as Array<Record<string, unknown>>;
      let label = '';

      if (columns[0]?.elements) {
        const leftElements = columns[0].elements as Array<Record<string, unknown>>;
        for (const el of leftElements) {
          if (el.tag === 'div' && (el.text as { content?: string } | undefined)?.content) {
            const content = (el.text as { content: string }).content;
            if (content.startsWith('**') && content.endsWith('**')) {
              label = content.slice(2, -2);
            } else {
              label = content;
            }
            break;
          }
        }
      }

      if (columns[1]?.elements) {
        const rightElements = columns[1].elements as Array<Record<string, unknown>>;
        for (const el of rightElements) {
          if (el.tag === 'input' && el.name) {
            results.push({
              key: el.name as string,
              label,
              defaultValue: (el.default_value as string) || '',
            });
          }
        }
      }
      return; // 已按两列成对处理，不再递归其子树
    }

    for (const value of Object.values(record)) {
      traverse(value);
    }
  }

  traverse(card);
  return results;
}
