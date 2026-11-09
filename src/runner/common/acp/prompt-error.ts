/**
 * ACP prompt-response error text.
 *
 * ACP's PromptResponse only carries a coarse `stopReason`; the real provider
 * error is out-of-band. CodeBuddy reports every non-special failure as
 * `stopReason:'refusal'` and puts the real error in
 * `_meta['codebuddy.ai/errorMessage']` (JSON `{code,message,data}`); the ACP
 * schema also allows a top-level `error` variant.
 *
 * Rule: surface the upstream message verbatim when present; otherwise state
 * only what is known (the stopReason). Never invent a cause — a wrong cause is
 * worse than "unknown", because it sends the user down the wrong path.
 */
import type { SessionPromptResult } from './protocol-types.js';

/**
 * stopReasons whose meaning is defined by the protocol itself. `refusal` is
 * deliberately absent: some servers use it as a catch-all for provider errors
 * (CodeBuddy does), so interpreting it would reintroduce the guess.
 */
const STOP_REASON_HINTS: Record<string, string> = {
  max_tokens: '输出达到模型 token 上限',
  max_turn_requests: '达到单轮请求次数上限',
};

export interface PromptErrorDetail {
  /** Upstream-provided message (verbatim), when the server forwarded one. */
  upstream?: string;
  /** User-facing text: upstream verbatim, else a neutral stopReason statement. */
  text: string;
}

/** Resolve the user-facing error text for a failed prompt response. */
export function describePromptError(result: SessionPromptResult): PromptErrorDetail {
  const upstream = upstreamPromptError(result);
  return {
    upstream,
    text: upstream ?? fallbackPromptErrorText(result.stopReason),
  };
}

/** Extract the server-provided error message from the prompt response. */
export function upstreamPromptError(result: SessionPromptResult): string | undefined {
  const direct = errorMessageOf(result.error) ?? errorMessageOf(result.errorMessage);
  if (direct) return direct;

  const meta = asRecord(result._meta);
  if (!meta) return undefined;
  return (
    errorMessageOf(meta['codebuddy.ai/errorMessage']) ??
    errorMessageOf(meta.errorMessage) ??
    errorMessageOf(meta.error)
  );
}

function fallbackPromptErrorText(stopReason: string): string {
  const hint = STOP_REASON_HINTS[stopReason];
  return hint
    ? `${hint}（stopReason: ${stopReason}）`
    : `Agent 结束但未说明原因（stopReason: ${stopReason}）`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse JSON-looking strings; leave plain text untouched. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * Normalize an error value to a readable message. Accepts a plain string, a
 * JSON string, or an object shaped like `{code, message, data:{message|details}}`.
 */
function errorMessageOf(value: unknown): string | undefined {
  const parsed = parseMaybeJson(value);
  const direct = nonEmptyString(parsed);
  if (direct) return direct;

  const rec = asRecord(parsed);
  if (!rec) return undefined;
  const data = asRecord(rec.data);
  return (
    nonEmptyString(rec.message) ??
    nonEmptyString(rec.details) ??
    nonEmptyString(rec.errorMessage) ??
    nonEmptyString(data?.message) ??
    nonEmptyString(data?.details) ??
    codeLabel(rec.code)
  );
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function codeLabel(code: unknown): string | undefined {
  if (typeof code === 'string' && code.trim()) return `错误码 ${code.trim()}`;
  if (typeof code === 'number' && Number.isFinite(code)) return `错误码 ${code}`;
  return undefined;
}
