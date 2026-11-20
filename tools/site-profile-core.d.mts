export const OWNER_ORIGIN: string;
export type Profile = "onetimepass" | "selfhost";
export function applyBlocks(html: string, profile: Profile): string;
export function operatorNameHtml(raw: string | undefined): string;
export function operatorContactHtml(raw: string | undefined): string;
export function parseOrigin(raw: string | undefined): string;
export function transformHtml(
  html: string,
  opts: { profile: Profile; origin: string; operatorName: string | undefined; operatorContact: string | undefined },
): string;
export function headersForSelfhost(text: string, options?: { indexable?: boolean }): string;
export function robotsForSelfhost(text: string, opts: { origin: string; indexable: boolean }): string;
export function sitemapForSelfhost(text: string, origin: string): string;
export function securityTxtExpires(now: Date): string;
export function securityTxtForPages(opts: { privacyHtml: string; now: Date }): string;
export function securityTxtForSelfhost(opts: { origin: string; contact: string | undefined; now: Date }): string | null;
