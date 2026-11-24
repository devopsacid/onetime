export const DEFAULT_DAYS: number;
export const MAX_REPLY_BYTES: number;
export class StatsError extends Error {
  code: number;
}
export function parseArgs(argv: string[]): { days: number; format: "table" | "tsv" };
export function buildQuery(days: number): string;
export interface DayRow {
  day: string;
  views: number;
  created: Record<string, number>;
  revealed: Record<string, number>;
  gone: Record<string, number>;
}
export function parseReply(text: string): { day: string; event: string; label: string; n: number }[];
export function tabulate(rows: { day: string; event: string; label: string; n: number }[], days: number, now?: Date): DayRow[];
export function format(rows: DayRow[], how: "table" | "tsv"): string;
export function fetchStats(opts: { env: Record<string, string | undefined>; days: number; fetch?: typeof fetch; now?: Date }): Promise<DayRow[]>;
