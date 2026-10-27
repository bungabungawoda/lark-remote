/**
 * Split an authoritative final answer into plain-text messages without losing
 * any content. Feishu cards have a hard size budget; a long answer must spill
 * rather than being silently truncated inside the progress card.
 */
const FINAL_ANSWER_CHUNK_BYTES = 20_000;

export function splitFinalAnswer(
  text: string,
  maxBytes: number = FINAL_ANSWER_CHUNK_BYTES,
): string[] {
  if (!text || maxBytes <= 0) return text ? [text] : [];

  const chunks: string[] = [];
  let rest = text;
  let remainingBytes = Buffer.byteLength(rest, 'utf8');
  while (remainingBytes > maxBytes) {
    let bytes = 0;
    let end = 0;
    let lastNewline = 0;
    for (const char of rest) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (bytes + charBytes > maxBytes) break;
      bytes += charBytes;
      end += char.length;
      if (char === '\n') lastNewline = end;
    }
    if (end === 0) {
      // A caller can choose a byte limit smaller than one codepoint. Keep one
      // codepoint per chunk rather than looping forever with a zero-length cut.
      const first = Array.from(rest)[0];
      chunks.push(first);
      rest = rest.slice(first.length);
      remainingBytes -= Buffer.byteLength(first, 'utf8');
      continue;
    }
    // Prefer a paragraph/line boundary when it does not waste most of a chunk.
    const cut = lastNewline > 0 && lastNewline >= Math.floor(end * 0.6) ? lastNewline : end;
    const chunk = rest.slice(0, cut);
    chunks.push(chunk);
    rest = rest.slice(cut);
    remainingBytes -= Buffer.byteLength(chunk, 'utf8');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
