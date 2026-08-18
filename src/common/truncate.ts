/**
 * Shared text truncation primitives.
 *
 * Centralizes the two truncation utilities previously split across the card
 * layer (`card-shared.ts` char-based `truncate` and `card/text-truncate.ts`
 * byte-safe `truncateUtf8`). Session readers import from here instead of the
 * card layer (fixing the layer inversion), and the card layer re-exports for
 * backward compatibility.
 */

/** Default truncation suffix, shared across all consumers for UX consistency. */
export const DEFAULT_TRUNCATE_SUFFIX = '…（已截断）';

/**
 * Max byte budget for a single session `tool_result` event's content when
 * replaying an opencode session (L2 pre-fold). Pre-folding here bounds the
 * in-memory `events[]` array and the intermediate card JSON so a single
 * pathological tool_result never inflates the replay payload to megabytes.
 */
export const TOOL_RESULT_MAX_BYTES = 4000;

/**
 * Fit a UTF-8 string into `maxBytes` by iterating Unicode codepoints, never
 * splitting a multi-byte sequence. When `fromEnd` is true, keeps the TAIL
 * (useful for logs/tails); otherwise keeps the HEAD.
 */
export function fitUtf8(value: string, maxBytes: number, fromEnd = false): string {
  if (fromEnd) {
    const codepoints = Array.from(value);
    let bytes = 0;
    let start = codepoints.length;
    for (let i = codepoints.length - 1; i >= 0; i--) {
      const cb = Buffer.byteLength(codepoints[i], 'utf8');
      if (bytes + cb > maxBytes) break;
      bytes += cb;
      start = i;
    }
    return codepoints.slice(start).join('');
  }
  // head 分支：惰性 for-of 迭代 + 字符串索引累计（O(1) 内存）。
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const cb = Buffer.byteLength(char, 'utf8');
    if (bytes + cb > maxBytes) break;
    bytes += cb;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * Truncate a UTF-8 string to fit within `maxBytes`, appending `suffix`
 * (default `…（已截断）`) when truncation occurs. When `fromEnd` is true, keeps
 * the tail and prepends the suffix (useful for "show the most recent N bytes").
 */
export function truncateUtf8(
  value: string,
  maxBytes: number,
  fromEnd = false,
  suffix: string = DEFAULT_TRUNCATE_SUFFIX,
): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = maxBytes - suffixBytes;
  if (budget <= 0) return suffix;
  const truncated = fitUtf8(value, budget, fromEnd);
  return fromEnd ? `${suffix}\n${truncated}` : `${truncated}${suffix}`;
}

interface TruncateOptions {
  suffix?: string; // default '…' (1 char)
  normalizeWhitespace?: boolean; // default false
}

/** Char-based truncation with optional suffix / whitespace normalization. */
export function truncate(str: string, max: number, options?: TruncateOptions): string {
  const suffix = options?.suffix ?? '…';
  const normalize = options?.normalizeWhitespace ?? false;

  let s = str;
  if (normalize) s = s.replace(/\s+/g, ' ').trim();

  if (s.length <= max) return s;

  const suffixLen = suffix.length;
  const budget = max - suffixLen;
  if (budget <= 0) return suffix;
  // Iterate by Unicode codepoint (for...of) so the cut never lands inside a
  // surrogate pair (P2-31 anchor: must not emit a lone surrogate).
  let end = 0;
  for (const ch of s) {
    if (end + ch.length > budget) break;
    end += ch.length; // 1 (BMP) or 2 (surrogate pair) — slice lands on a boundary
  }
  return s.slice(0, end) + suffix;
}

/** Char-level tail keep (used for store-time caps, e.g. bash output). */
export function keepTail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}
