import type { SessionContent } from '../session-contract.js';

/** Whether a reader found any persisted trace for the requested session. */
export function hasSessionContent(
  content: Pick<SessionContent, 'events' | 'usage' | 'aiTitle' | 'recap' | 'displayTitle'>,
): boolean {
  return (
    content.events.length > 0 ||
    content.usage !== undefined ||
    content.aiTitle !== undefined ||
    content.recap !== undefined ||
    content.displayTitle !== undefined
  );
}
