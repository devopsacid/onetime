import { USAGE_KINDS } from "../shared/usage";

/**
 * Aggregate usage counters (docs/plans/usage-counters.md). The sink gets an event and a label from closed sets, never
 * anything from the request: no id, key, blob, size, address or header.
 */
export type UsageKind = (typeof USAGE_KINDS)[number] | "unknown";
export type UsageEvent = "view" | "create" | "reveal" | "gone";
/** A page name for "view", a kind for the rest. */
export type UsageLabel<E extends UsageEvent> = E extends "view" ? "app" : UsageKind;

export interface Usage {
  count<E extends UsageEvent>(event: E, label: UsageLabel<E>): void;
}

export const noUsage: Usage = { count() {} };

/** The kind from `?kind=`: exactly one of the four known values, else "unknown". Never an error. */
export function parseKind(value: string | null): UsageKind {
  return (USAGE_KINDS as readonly string[]).includes(value ?? "") ? (value as UsageKind) : "unknown";
}

/** Counts through the sink and swallows anything it throws: a counter never changes a response. */
export function safeCount<E extends UsageEvent>(usage: Usage, event: E, label: UsageLabel<E>): void {
  try {
    usage.count(event, label);
  } catch {
    // Counting is best effort.
  }
}
