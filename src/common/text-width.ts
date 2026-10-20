/**
 * 文本的**显示宽度**工具（半角 1 / 全角与 emoji 2）。
 *
 * 为什么单列一个模块：卡片标题、状态行、resume 卡片标题都要按"手机上能放几行"
 * 来收敛，而卡片层（`src/card/`）与会话读取层（`src/session/`）都要用——放在
 * 任何一侧都会让另一侧反向依赖。
 */

/**
 * 按**显示宽度**截断（半角 1 / 全角与 emoji 2）。
 *
 * markdown 的 `**` 与 emoji 都要按视觉宽度算：只按字符数截断时，一行 34 个
 * CJK 就是 34 个字宽，手机上必然折行。
 */
export function truncateToDisplayWidth(text: string, maxUnits: number): string {
  if (displayWidth(text) <= maxUnits) return text;
  let used = 0;
  let out = '';
  for (const ch of text) {
    const w = charWidth(ch);
    // 预留 1 个单位给省略号
    if (used + w > maxUnits - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** 字符串的显示宽度（半角 1 / 全角与 emoji 2）。 */
export function displayWidth(text: string): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch);
  return total;
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  // CJK 统一表意文字、假名、全角标点、常见 emoji 都按两个半角算。
  if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a)) return 2;
  if (code >= 0x2e80 && code <= 0xa4cf) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe30 && code <= 0xfe6f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  if (code >= 0x1f300 && code <= 0x1faff) return 2;
  if (code >= 0x2600 && code <= 0x27bf) return 2;
  return 1;
}

/**
 * 中间省略截断：保留开头与结尾，只在中间打 `…`。
 *
 * 标题里的路径/URL 必须保留**结尾**才有信息量（`/mnt/data/.../notes/
 * 2026-10-19-vision-remaining.md` 里真正有用的是文件名），尾部省略会把文件名
 * 整个切掉；纯尾部截断只适合"开头即结论"的句子（命令）。
 */
export function truncateMiddleToDisplayWidth(text: string, maxUnits: number): string {
  if (displayWidth(text) <= maxUnits) return text;
  const budget = Math.max(1, maxUnits - 1); // 给省略号留 1 个单位
  const headBudget = Math.ceil(budget / 2);
  const tailBudget = budget - headBudget;
  let head = '';
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > headBudget) break;
    head += ch;
    used += w;
  }
  let tail = '';
  used = 0;
  const chars = [...text];
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = charWidth(chars[i]);
    if (used + w > tailBudget) break;
    tail = chars[i] + tail;
    used += w;
  }
  return `${head}…${tail}`;
}
