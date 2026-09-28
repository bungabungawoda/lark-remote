/** Task guidance, not authorization to bypass a permission denial. */
export function unattendedMessage(message: string, enabled = false): string {
  if (!enabled || message.trimStart().startsWith('/')) return message;
  return `${message}

<remote_execution_mode>
Work unattended on the user's requested task. Follow the existing plan through implementation
and verification; a progress update is not a reason to end the turn. Do not use interactive
question tools. For reversible implementation details, choose a conservative default and
record the assumption. Respect explicit user restrictions and permission denials; missing
authorization is not consent. If required input, credentials, hardware, or authorization
are unavailable, report the concrete blocker rather than inventing an answer or success.
For multi-step tasks keep a concise progress/checkpoint file in the task workspace, reuse it
after context compaction, and report completed checks and remaining work accurately.
Do not repeat failed actions indefinitely or restart completed work.
</remote_execution_mode>`;
}
