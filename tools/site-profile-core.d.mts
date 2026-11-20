export const OWNER_ORIGIN: string;
export const INFO_ORIGIN: string;
export const INFO_CSP: string;
export type Profile = "onetimepass" | "info" | "selfhost";
export function rewriteLinks(html: string, profile: "onetimepass" | "info"): string;
export function dropManifestLink(html: string): string;
export function headersForInfo(text: string): string;
export function redirectsForApp(): string;
export function redirectsForInfo(): string;
export function robotsForInfo(): string;
export function sitemapForSite(text: string, origin: string): string;
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
export function securityTxtForPages(opts: { privacyHtml: string; now: Date; origin?: string }): string;
export function securityTxtForSelfhost(opts: { origin: string; contact: string | undefined; now: Date }): string | null;
