/** The one origin whose visitors may be counted: the info site. The app origin, forks and previews never load analytics. */
export const ANALYTICS_ORIGIN = "https://onetimepass-info.pages.dev";

export function analyticsAllowedHere(origin: string): boolean {
  return origin === ANALYTICS_ORIGIN;
}
