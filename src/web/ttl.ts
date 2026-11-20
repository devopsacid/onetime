/** The largest option value not above maxTtl, or null when none fits. DOM-free so it can be tested. */
export function pickTtlOption(maxTtl: number, values: readonly number[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value <= maxTtl && (best === null || value > best)) best = value;
  }
  return best;
}
