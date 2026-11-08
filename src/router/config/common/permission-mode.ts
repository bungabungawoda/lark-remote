import type { ConfigField, SelectOption } from '../types.js';

/**
 * 权限模式下拉：两个 builder 只有 key 与枚举清单不同，控件形态一致。
 * 放在 common 以免各自拆出的 per-field helper 长成逐字重复。
 */
export function permissionModeField(
  key: string,
  options: SelectOption[],
  current: string,
): ConfigField {
  return {
    key,
    label: '权限模式',
    type: 'select',
    options,
    currentValue: current,
  };
}
