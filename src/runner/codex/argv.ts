/**
 * Builds `codex exec` command-line arguments.
 *
 * Key design decisions:
 * - `approval_policy="never"` eliminates the approval handshake (root cause ①).
 * - Prompt goes via stdin (`-` flag) to avoid argv escaping issues.
 * - `--skip-git-repo-check`: lark-remote's cwd may not be a git repo.
 * - User's `~/.codex/config.toml` and project rules are preserved
 *   (no `--ignore-user-config` / `--ignore-rules`).
 */

interface BuildCodexExecArgsInput {
  /** Working directory for the codex process. */
  cwd: string;
  /** Model override (maps to `-m`). Omitted uses codex config.toml default. */
  model?: string;
  /** Model provider override (maps to `-c model_provider="xxx"`).
   *  Omitted uses codex config.toml default. */
  modelProvider?: string;
  /** Thread ID for session resumption (maps to `exec resume --json <threadId> -`). */
  threadId?: string;
  /** Reasoning effort level (maps to `-c model_reasoning_effort="xxx"`). */
  reasoningEffort?: string;
}

/**
 * Construct the argv array for `codex exec --json`.
 *
 * New session:
 *   `codex exec --json --sandbox danger-full-access -c approval_policy="never" ... -`
 * Resume session:
 *   `codex exec --sandbox danger-full-access ... resume --json <threadId> -`
 */
export function buildCodexExecArgs(input: BuildCodexExecArgsInput): string[] {
  const sandbox = 'danger-full-access';

  const globalFlags = [
    '--sandbox',
    sandbox,
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
    '--skip-git-repo-check',
    '-C',
    input.cwd,
    ...(input.model ? ['-m', input.model] : []),
    ...(input.modelProvider ? ['-c', `model_provider="${input.modelProvider}"`] : []),
    ...(input.reasoningEffort ? ['-c', `model_reasoning_effort="${input.reasoningEffort}"`] : []),
  ];

  if (input.threadId) {
    return ['exec', ...globalFlags, 'resume', '--json', input.threadId, '-'];
  }

  return ['exec', '--json', ...globalFlags, '-'];
}
