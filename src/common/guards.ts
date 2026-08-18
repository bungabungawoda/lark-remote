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
 * Returns the string value when `v` is a `string`, otherwise `undefined`.
 */
export function stringValue(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
