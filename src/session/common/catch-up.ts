/**
 * Find the index of the last line in a JSONL line array whose parsed object
 * satisfies the given predicate.
 *
 * Invalid JSON, empty, and whitespace-only lines are silently skipped.
 *
 * @param lines          Array of raw JSONL line strings.
 * @param isUserMessage  Predicate that receives the parsed object and returns
 *                       true for lines considered "user" messages.
 * @returns The array index of the last matching line, or -1 if none match.
 */
export function findLastUserIndex(
  lines: string[],
  isUserMessage: (obj: Record<string, unknown>) => boolean,
): number {
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (isUserMessage(obj)) {
      lastIdx = i;
    }
  }
  return lastIdx;
}
