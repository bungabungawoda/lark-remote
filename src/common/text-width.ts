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

/**
 * 显示宽度为 2 的码点区间（闭区间，Map 的键 = 下界、值 = 上界）。
 *
 * 用 Map 而非对象字面量：对象字面量的 `constructor` / `toString` 等键会命中
 * Object.prototype，查表会拿到非预期值；数字键的 Map 无此问题。顺序与原 if 链
 * 一致（所有区间都返回同一宽度，遍历早停即等价），逐字保留：
 * - [0x1100,0x115f] Hangul Jamo；U+2329 / U+232A 单独列为单码点区间；
 * - CJK 统一表意文字 / 假名 / 全角标点 / 兼容表意 / 全角 / Hangul 音节；
 * - 常见 emoji（0x1f300–0x1faff）与 Misc Symbols（0x2600–0x27bf）；
 * - Misc Technical 块（U+2300–U+23FF）：⏱⏹⏳⏸⏺ 等计时器/播放器符号在
 *   状态行里实际使用，手机端按 emoji 宽度渲染——按 1 计会系统性低估行宽，
 *   窄屏余量比设计值更小。
 */
const WIDE_CODE_POINT_RANGES = new Map<number, number>([
  [0x1100, 0x115f],
  [0x2329, 0x2329],
  [0x232a, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x2600, 0x27bf],
  [0x2300, 0x23ff],
]);

/** 码点是否落在任一「宽度 2」区间内（模块级命名函数，供 charWidth 查表）。 */
function isWideCodePoint(code: number): boolean {
  for (const [lo, hi] of WIDE_CODE_POINT_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  // CJK 统一表意文字、假名、全角标点、常见 emoji 都按两个半角算。
  return isWideCodePoint(code) ? 2 : 1;
}

/**
 * 中间省略截断：保留开头与结尾，只在中间打 `…`。
 *
 * 标题里的路径/URL 必须保留**结尾**才有信息量（`~/code/notes-app/.../notes/
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
