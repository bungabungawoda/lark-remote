/**
 * Two-pass scan skeleton shared by the claude / pi session readers (P2-2 +
 * P2-5/P2-6 lineage): pass 1 STREAMS the whole file once via `scanJsonlLines`
 * (no `string[]` materialized), parsing each line exactly once to collect
 * scalars (usage, tail offset, title) while retaining NO parsed objects; pass
 * 2 re-reads ONLY the tail from the recorded offset and re-parses it for
 * content events — O(tail) memory for both raw line strings and parsed
 * objects, instead of O(whole file).
 *
 * Parse ratio: ≈1.0–1.5× line count when a user message exists (streaming
 * full-file scan + tail re-parse of the usually-short post-user lines). When
 * the session has NO user message, tailOffset stays -1 and the tail IS the
 * whole file → scan(N) + tail(N) = 2.0× — the known asymptotic upper bound of
 * the two-phase design.
 */
import { scanJsonlLines, readJsonlLinesFromOffset } from './jsonl.js';
import { capEvents } from './pagination.js';
import type { AgentSessionContentEvent } from '../../runner/types.js';

/**
 * Byte offset where the tail begins: the start of the line AFTER `line`.
 * `offset` is the byte offset of `line` itself; +1 accounts for the trailing
 * '\n'.
 */
export function tailOffsetAfter(line: string, offset: number): number {
  return offset + Buffer.byteLength(line, 'utf-8') + 1;
}

/**
 * Pass 1: stream the file once, parse each line exactly once (broken lines
 * skipped), and feed the parsed object + raw line + byte offset to `handle`.
 * `handle` may mutate closure state to collect scalars and track the tail
 * offset (via tailOffsetAfter on user lines).
 */
export function scanJsonlOnce(
  filePath: string,
  handle: (obj: Record<string, unknown>, line: string, offset: number) => void,
): void {
  scanJsonlLines(filePath, (line, offset) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    handle(obj, line, offset);
  });
}

/**
 * Pass 2: re-read only the tail (lines after `tailOffset`; the whole file
 * when tailOffset is -1) and map each parsed line to content events via
 * `mapLine` (return an array — possibly empty — of events; returning null
 * skips the line entirely). `maxEvents` keeps the LAST N events
 * (`maxEvents <= 0` → [], guarding the `slice(-0)` full-array trap).
 */
export function scanTailEvents(
  filePath: string,
  tailOffset: number,
  mapLine: (obj: Record<string, unknown>) => AgentSessionContentEvent[] | null,
  maxEvents?: number,
): AgentSessionContentEvent[] {
  const tailLines = readJsonlLinesFromOffset(filePath, tailOffset >= 0 ? tailOffset : 0);
  const events: AgentSessionContentEvent[] = [];
  for (const line of tailLines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const produced = mapLine(obj);
    if (produced) events.push(...produced);
  }
  return capEvents(events, maxEvents);
}
