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
 * Front-omission marker emitted by the store-time tail window (`keepTailMarked`).
 * Single source of truth: the card store builds it, the card renderer parses it,
 * so the wording cannot drift between the two layers.
 */
export const FRONT_OMISSION_MARKER_RE = /^…（前 (\d+) 字符已省略）\n/;

/** Build the front-omission marker reporting how many leading chars were dropped. */
export function frontOmissionMarker(dropped: number): string {
  return `…（前 ${dropped} 字符已省略）\n`;
}

/**
 * Max byte budget for a single session `tool_result` event's content when
 * replaying an opencode session (pre-fold). Pre-folding here bounds the
 * in-memory `events[]` array and the intermediate card JSON so a single
 * pathological tool_result never inflates the replay payload to megabytes.
 */
export const TOOL_RESULT_MAX_BYTES = 4000;

/**
 * Fit a UTF-8 string into `maxBytes` by iterating Unicode codepoints, never
 * splitting a multi-byte sequence. When `fromEnd` is true, keeps the TAIL
 * (useful for logs/tails); otherwise keeps the HEAD.
 */
function fitUtf8(value: string, maxBytes: number, fromEnd = false): string {
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

/**
 * Render-time truncation that respects an existing front-omission marker.
 *
 * The storage layer keeps the TAIL of long blocks and prefixes them with a
 * front-omission marker. Head-truncating such content again would keep the
 * marker plus the OLDEST kept text and append a contradictory trailing
 * `…（已截断）`. Instead, when a marker is present and the content still
 * exceeds `maxBytes`, drop more from the FRONT (increase the omitted count)
 * and never add a tail marker. Content without a marker falls back to plain
 * head truncation (`truncateUtf8`), preserving existing behavior.
 */
export function truncateUtf8WithOmissionMarker(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const prior = FRONT_OMISSION_MARKER_RE.exec(value);
  if (!prior) return truncateUtf8(value, maxBytes);

  const priorDropped = Number(prior[1]);
  const body = value.slice(prior[0].length);
  // Marker byte length depends on the digit count of the cumulative omitted
  // number N: find the smallest N (monotonically non-decreasing) such that
  // marker(N) + the kept tail fits `maxBytes`. `kept` is a tail slice that
  // never splits a code point, so `body.length - kept.length` is exactly the
  // number of UTF-16 units dropped this pass — the same unit keepTailMarked
  // counts by.
  let dropped = priorDropped;
  for (;;) {
    const budget = maxBytes - Buffer.byteLength(frontOmissionMarker(dropped), 'utf8');
    const kept = budget > 0 ? fitUtf8(body, budget, true) : '';
    const next = priorDropped + (body.length - kept.length);
    if (next === dropped) return frontOmissionMarker(dropped) + kept;
    dropped = next;
  }
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
  // surrogate pair (must not emit a lone surrogate).
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
