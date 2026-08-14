import { isNewer } from './version-check.js';

/**
 * Format an update hint string for the startup notification.
 * Returns null if no newer version is available.
 */
export function formatUpdateHint(current: string, latest: string): string | null {
  if (!isNewer(current, latest)) return null;
  return `📦 有新版本 ${latest} 可用（当前 ${current}），发送 /update 升级`;
}
