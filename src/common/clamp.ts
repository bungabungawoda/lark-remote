/** Clamp `v` into [min, max]. */
export function clampInt(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
