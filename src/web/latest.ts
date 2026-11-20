/** Hands out tickets so that only the most recent async call may apply its result. */
export function createLatestGuard(): { next(): number; current(): number; isCurrent(ticket: number): boolean } {
  let latest = 0;
  return {
    next: () => ++latest,
    /** The ticket in force, without issuing a new one: an async flow captures it when it starts. */
    current: () => latest,
    isCurrent: (ticket) => ticket === latest,
  };
}
