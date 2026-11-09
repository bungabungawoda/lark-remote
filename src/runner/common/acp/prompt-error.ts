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

/**
 * Upstream authentication failure (HTTP 401 + an auth marker).
 *
 * Identity is runtime state: a re-login / region switch only changes the CLI's
 * on-disk credential truth, while the bridge keeps a catalog snapshot, a
 * long-lived ACP connection and a persisted session id. The upstream 401 is
 * the ONLY trustworthy invalidation signal — we deliberately do not read the
 * CLI's private credential store or try to fingerprint a token.
 *
 * Both halves are required: a bare `401` can be ordinary answer text about the
 * HTTP status code (or DSH's "DSH HTTP 401 for session.create"), and an auth
 * phrase without 401 is not a credential failure. False positives here would
 * silently drop a user's session, so stay conservative.
 */
const AUTH_PHRASE =
  /unauthori[sz]ed|authentication required|please use \/login|sign in to your account|invalid[ -]?token|token[ -]?expired|not authenticated/i;

export function isAuthenticationFailure(text: string | undefined): boolean {
  if (!text || !/\b401\b/.test(text)) return false;
  return AUTH_PHRASE.test(text);
}

/**
 * Classify a whole prompt response. Three accepted signals, all upstream:
 * human-readable `401 + auth phrase`, structured `code|status: 401`, or
 * `data.category: 'auth'` plus an auth phrase. The last one covers the
 * unauthenticated-ACP case (real capture 2026-11-09: `code:-32000`,
 * `message:'Authentication required'`, `data.category:'auth'`), which carries
 * no 401 anywhere. Still conservative: a bare auth category without an auth
 * phrase is not enough, because a false positive drops the user's session.
 */
export function isPromptAuthenticationFailure(result: SessionPromptResult): boolean {
  if (isAuthenticationFailure(upstreamPromptError(result))) return true;
  const meta = asRecord(result._meta);
  const candidates: unknown[] = [
    result.error,
    result.errorMessage,
    meta?.['codebuddy.ai/errorMessage'],
    meta?.errorMessage,
    meta?.error,
  ];
  return candidates.some((value) => hasAuthStatusCode(value) || hasAuthCategory(value));
}

/** `data.category:'auth'` is the upstream's own classification, not a guess. */
function hasAuthCategory(value: unknown): boolean {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return false;
  const data = asRecord(rec.data);
  if (data?.category !== 'auth') return false;
  const text = [rec.message, rec.details, data.message, data.details]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  return AUTH_PHRASE.test(text);
}

function hasAuthStatusCode(value: unknown): boolean {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return false;
  const data = asRecord(rec.data);
  return [rec.code, rec.status, data?.statusCode, data?.status].some(
    (code) => code === 401 || code === '401',
  );
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
