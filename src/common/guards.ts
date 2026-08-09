/**
 * Type guards and safe value extractors for untyped (usually JSON-parsed)
 * data coming from external sources such as LSP messages, API responses,
 * or child-process stdout.
 *
 * Every function is intentionally tiny and side-effect-free so it can be
 * inlined by the bundler and reasoned about at a glance.
 */

/**
 * Returns `true` when `v` is a non-null object (including arrays).
 * Used as a prerequisite before accessing string-keyed properties.
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Narrows `v` to `Record<string, unknown>` when it is a non-null object,
 * otherwise returns `undefined`.
 */
export function recordValue(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

/**
 * Returns the string value when `v` is a `string`, otherwise `undefined`.
 */
export function stringValue(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Returns the number value when `v` is a `number`, otherwise `undefined`.
 */
export function numberValue(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * Extracts a human-readable error message from an opaque error object.
 *
 * Priority:
 *  1. `raw.message`  (string)
 *  2. `raw.error.message`  (string, when `raw.error` is a record)
 *  3. `raw.error.data.message`  (string, AI SDK wraps provider errors as {error:{data:{message}}})
 *  4. `raw.error` itself  (when it is a string)
 *  5. `fallback`
 */
export function extractErrorMessage(raw: Record<string, unknown>, fallback: string): string {
  const msg = stringValue(raw.message);
  if (msg !== undefined) return msg;

  const err = raw.error;
  if (isRecord(err)) {
    const subMsg = stringValue(err.message);
    if (subMsg !== undefined) return subMsg;
    const data = recordValue(err.data);
    if (data) {
      const dataMsg = stringValue(data.message);
      if (dataMsg !== undefined) return dataMsg;
    }
  }
  if (typeof err === 'string') return err;

  return fallback;
}
