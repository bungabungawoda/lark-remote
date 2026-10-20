export function formatTimestamp(ts: string | number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/**
 * 时钟时间 `HH:mm`（同一张卡内的次要信息用）。
 *
 * 面板标题在手机上只有约 36 个显示宽度可用：`2026-10-19 21:23` 光时间戳就吃掉
 * 一半，正文明明只需要知道"什么时候发生的"。完整的日期在会话历史/日志里。
 */
export function formatClock(ts: string | number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * `MM-DD HH:mm`（面板标题里的历史事件时间）。
 *
 * 比 `HH:mm` 多带上日期（跨天/跨周的会话不会误导），比完整 `YYYY-MM-DD HH:mm`
 * 省 7 个显示宽度——那 7 个单位在手机上正好是文件名能不能显示出来的差别。
 */
export function formatMonthDayClock(ts: string | number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd} ${formatClock(d.getTime())}`;
}
