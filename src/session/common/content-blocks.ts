/**
 * Parameterized content-block extraction shared across session readers.
 *
 * Different agents (Claude, pi, …) use different field names for tool_use /
 * tool_result blocks. The {@link ContentBlockMapping} type captures those
 * differences so a single implementation can serve all readers.
 */

/** A single extracted content block for rendering. */
interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  content: string;
}

/** Maps agent-specific field names to the generic extraction logic. */
export interface ContentBlockMapping {
  /** The `type` value that identifies a tool-use block (e.g. 'tool_use' or 'toolCall'). */
  toolUseType: string;
  /** The `type` value that identifies a tool-result block (e.g. 'tool_result' or 'toolResult'). */
  toolResultType: string;
  /** Field name holding the tool input/arguments (e.g. 'input' or 'arguments'). */
  toolInputField: string;
  /** Field name holding the error flag (e.g. 'is_error' or 'isError'). */
  toolErrorField: string;
}

/**
 * Extract content blocks from a message content array.
 *
 * Handles text, thinking, tool_use, and tool_result blocks. Blank text and
 * whitespace-only tool_result content are skipped. Tool input is serialized
 * to JSON and truncated at 200 characters.
 *
 * @param content  The raw `content` value from a message (array expected;
 *                 non-array values return an empty array).
 * @param mapping  Agent-specific field-name mapping.
 * @returns Array of {@link ContentBlock} objects.
 */
export function extractContentBlocks(
  content: unknown,
  mapping: ContentBlockMapping,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (!Array.isArray(content)) return blocks;

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;

    const p = part as Record<string, unknown>;

    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
      blocks.push({ type: 'text', content: p.text.trim() });
    }

    if (p.type === 'thinking' && typeof p.thinking === 'string' && p.thinking.trim()) {
      blocks.push({ type: 'thinking', content: p.thinking.trim() });
    }

    // tool_use block (parameterized type name + input field)
    if (p.type === mapping.toolUseType && typeof p.name === 'string') {
      const rawInput = p[mapping.toolInputField] ?? {};
      const inputStr = JSON.stringify(rawInput, null, 2);
      const label = `🔧 ${p.name}`;
      let body: string;
      if (inputStr.length > 200) {
        body = inputStr.replace(/\n/g, ' ').slice(0, 197) + '...';
      } else {
        body = inputStr;
      }
      blocks.push({ type: 'tool_use', content: `${label}: ${body}` });
    }

    // tool_result block (parameterized type name + error field)
    if (p.type === mapping.toolResultType) {
      const toolContent =
        typeof p.content === 'string'
          ? p.content
          : Array.isArray(p.content)
            ? p.content
                .map((c: unknown) =>
                  typeof c === 'object' && c && 'text' in c
                    ? (c as { text: string }).text
                    : String(c),
                )
                .join('')
            : String(p.content ?? '');
      if (toolContent.trim()) {
        const isError = p[mapping.toolErrorField] === true;
        const label = isError ? '🔴 tool_result' : '🟢 tool_result';
        blocks.push({ type: 'tool_result', content: `${label}: ${toolContent.trim()}` });
      }
    }
  }

  return blocks;
}
