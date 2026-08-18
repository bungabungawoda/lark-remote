import type { AliasEntry } from './alias-store.js';

/**
 * 一次别名展开。
 *
 * - 仅匹配消息开头的 `$name`（`^$name`），`$name` 后接空格或行尾，全词精确匹配；
 * - 名称必须 `[A-Za-z_][A-Za-z0-9_]*`（数字开头的 `$500` 永不匹配）；
 * - 未知别名返回 undefined（原样透传给 agent，不报错）；
 * - 单次不递归：展开结果不再二次展开，防死循环；
 * - `!` / `/` 开头消息天然不匹配（正则要求 `$` 开头），bash 的 `$PATH` 不受影响。
 *
 * @returns 展开后的完整消息；无匹配时返回 undefined。
 */
export function resolveAlias(message: string, aliases: readonly AliasEntry[]): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)(?=$|[ \t])/.exec(message);
  if (!match) return undefined;
  const entry = aliases.find((a) => a.name === match[1]);
  if (!entry) return undefined;
  // lookahead 不消费空格：match[0] 仅含 $name，参数（含前导空格）原样拼接在别名文本后。
  return entry.text + message.slice(match[0].length);
}
