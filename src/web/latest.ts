/** Hands out tickets so that only the most recent async call may apply its result. */
export function createLatestGuard(): { next(): number; isCurrent(ticket: number): boolean } {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (ticket) => ticket === latest,
  };
}
