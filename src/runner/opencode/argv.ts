/**
 * Builds `opencode run` command-line arguments.
 *
 * Design:
 * - `--auto` eliminates approval handshake (root cause ①).
 * - `--format json` outputs ndjson event stream.
 * - Prompt goes via stdin (verified: opencode reads from stdin).
 * - cwd is set via spawn `cwd` option (not a flag).
 * - Model format: `provider/model` (e.g. 'anthropic/claude-sonnet-4-20250514').
 */

interface BuildOpencodeRunArgsInput {
  /** Model in provider/model format (maps to -m). Omitted → opencode config default. */
  model?: string;
  /** Session ID for resumption (maps to -s). */
  sessionId?: string;
}

/**
 * Construct argv for `opencode run --format json --auto`.
 *
 * New session:
 *   opencode run --format json --auto -m <provider/model>
 *   (prompt via stdin)
 *
 * Resume session:
 *   opencode run --format json --auto -s <sessionID>
 *   (prompt via stdin)
 *
 * Note: prompt is sent via stdin, NOT argv position parameter.
 * The `--` separator is NOT needed because prompt goes via stdin.
 */
export function buildOpencodeRunArgs(input: BuildOpencodeRunArgsInput): string[] {
  const args = ['run', '--format', 'json', '--auto'];

  if (input.model) {
    args.push('-m', input.model);
  }

  if (input.sessionId) {
    args.push('-s', input.sessionId);
  }

  return args;
}
