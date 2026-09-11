/** W3.7：pi 配置卡字段探针（原 tests/anchor/pi 与 tests/pi 双份字符串扫描器
 * 的单源版；取 anchor 版实现——lastIndexOf 定位包裹 column_set，窗口 500）。 */
/** 从 card JSON 中提取指定 key 字段的 select 选项值 */
export function extractFieldOptions(card: object, fieldKey: string): string[] {
  const json = JSON.stringify(card);
  const keyPattern = `"key":"${fieldKey}"`;
  const keyIndex = json.indexOf(keyPattern);
  if (keyIndex === -1) return [];

  const columnSetPattern = '{"tag":"column_set"';
  const columnSetStart = json.lastIndexOf(columnSetPattern, keyIndex);
  if (columnSetStart === -1) return [];

  const searchEnd = Math.min(keyIndex + 500, json.length);
  const searchArea = json.substring(columnSetStart, searchEnd);

  const selectStart = searchArea.indexOf('"tag":"select_static"');
  if (selectStart === -1) return [];

  const optionsStart = searchArea.indexOf('"options":[', selectStart);
  if (optionsStart === -1) return [];

  let depth = 0;
  let inString = false;
  let escape = false;
  let optionsEnd = -1;
  for (let i = optionsStart + 9; i < searchArea.length; i++) {
    const c = searchArea[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '[') depth++;
    if (c === ']') {
      depth--;
      if (depth === 0) {
        optionsEnd = i;
        break;
      }
    }
  }
  if (optionsEnd === -1) return [];

  const optionsJson = searchArea.substring(optionsStart, optionsEnd + 1);
  const matches = optionsJson.matchAll(/"value"\s*:\s*"([^"]+)"/g);
  return Array.from(matches, (m) => m[1]);
}

/** 从 card JSON 中判断字段是否是 select 类型（select_static 优先于 input）。 */
export function isSelectField(card: object, fieldKey: string): boolean {
  const json = JSON.stringify(card);
  const keyIndex = json.indexOf(`"key":"${fieldKey}"`);
  if (keyIndex === -1) return false;

  // 从 key 位置往后找一个 column_set，然后检查里面的 tag
  const columnSetStart = json.indexOf('{"tag":"column_set"', keyIndex);
  if (columnSetStart === -1) return false;

  // 在这个 column_set 内找 select_static 或 input
  const selectStatic = json.indexOf('"tag":"select_static"', columnSetStart);
  const input = json.indexOf('"tag":"input"', columnSetStart);

  // 看哪个更近
  if (selectStatic !== -1 && (input === -1 || selectStatic < input)) {
    return true;
  }

  return false;
}
