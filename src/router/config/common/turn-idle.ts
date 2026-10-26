import type { ConfigField } from '../types.js';

export function turnIdleTimeoutField(key: string, currentMinutes: number): ConfigField {
  return {
    key,
    label: 'Turn 空闲超时(分钟, 0关闭)',
    type: 'input',
    currentValue: String(currentMinutes),
  };
}
