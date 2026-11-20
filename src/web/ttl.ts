/** The largest option value not above maxTtl, or null when none fits. DOM-free so it can be tested. */
export function pickTtlOption(maxTtl: number, values: readonly number[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value <= maxTtl && (best === null || value > best)) best = value;
  }
  return best;
}

/**
 * What the near-full handler should select: the largest option that fits maxTtl, but only when it is
 * shorter than the current selection. Null means leave the select alone (never raise the sender's choice).
 */
export function lowerTtlSelection(current: number, maxTtl: number, values: readonly number[]): number | null {
  const picked = pickTtlOption(maxTtl, values);
  return picked !== null && picked < current ? picked : null;
}
