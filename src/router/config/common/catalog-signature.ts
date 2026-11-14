/**
 * 目录签名：判断「后台探测后要不要把新清单刷回已发出的 /config 卡」。
 *
 * 判据取 `buildFields()` 产出的字段描述符，而不是渲染后的卡片 JSON：
 * - 只编码 select 的 options，CLI 输出顺序、对象里的时间戳/计数都不进来，
 *   顺序抖动不会造成假变化；
 * - 在 `enforceCardBudget` 裁剪**之前**取，选项被裁掉也不影响判定；
 * - 显示文本也进签名（CodeBuddy 的模型名带积分费率，费率变了用户看到的
 *   就是另一份清单，该刷）。
 *
 * 探测结果与签名一致时一次 PATCH 都不发：稳态下省掉最多 5 张卡的网络写，
 * 也避开飞书单消息更新频限（230429）。
 */
import type { ConfigField } from '../types.js';

/** 把 string / {text,value} 两种选项形态归一成可比较的字符串。 */
function optionKey(option: string | { text: string; value: string }): string {
  return typeof option === 'string'
    ? `${option}\u0000${option}`
    : `${option.value}\u0000${option.text}`;
}

/** 计算一次目录签名。相同的用户可见清单恒返回相同字符串。 */
export function catalogSignature(fields: readonly ConfigField[]): string {
  const selects = fields
    .filter((field) => field.type === 'select' && field.options !== undefined)
    .map((field) => ({
      key: field.key,
      options: field.options!.map(optionKey).sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return JSON.stringify(selects);
}
