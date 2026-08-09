import { describe, expect, it } from 'vitest';
import { truncate } from '../../../src/card/card-shared.js';

/**
 * P2-31 anchor: `truncate` in `card-shared.ts` cuts by UTF-16 code unit
 * (`String.slice`), which can split a surrogate pair and emit a lone
 * surrogate. `JSON.stringify` then renders `\ud83d`, and strict JSON
 * parsers may reject the whole card payload.
 *
 * Construction: 'aaaaa' (5 BMP chars) + '😀' (U+1F600, two code units
 * \uD83D \uDE00) + 'bbbbbbbbbb'. With max=6 and no suffix, `s.slice(0, 6)`
 * yields 'aaaaa' + the high surrogate \uD83D alone — a lone surrogate
 * whose `codePointAt(0)` is 0xD83D (inside the surrogate range
 * [0xD800, 0xDFFF]).
 */
describe('anchor: card-shared truncate splits surrogate pair', () => {
  it('test_anchor_p2_31_truncate_should_not_emit_lone_surrogate', () => {
    const input = 'a'.repeat(5) + '\u{1F600}' + 'b'.repeat(10); // 'aaaaa😀bbbbbbbbbb'
    // max=6 so slice(0,6) cuts inside the emoji (5 a's + high surrogate).
    const result = truncate(input, 6, { suffix: '' });

    const chars = Array.from(result);
    const lastCp = chars[chars.length - 1].codePointAt(0)!;

    // A lone surrogate's codePointAt(0) falls in [0xD800, 0xDFFF].
    // A properly truncated string never ends on an unpaired surrogate:
    // BMP chars are < 0xD800, and complete astral chars are >= 0x10000.
    expect(
      lastCp,
      `truncate produced a lone surrogate (codePoint 0x${lastCp.toString(16)}); ` +
        `JSON.stringify => ${JSON.stringify(result)}`,
    ).toBeLessThan(0xd800);
  });
});
