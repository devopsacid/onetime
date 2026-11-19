/** The one origin whose visitors may be counted. A fork or a preview deployment never loads analytics. */
export const ANALYTICS_ORIGIN = "https://onetimepass.pages.dev";

export function analyticsAllowedHere(origin: string): boolean {
  return origin === ANALYTICS_ORIGIN;
}
