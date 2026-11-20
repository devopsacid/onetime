// Entry for 404.html and command-line.html: only the shared header behaviour. No analytics code is imported here.
// App and self-host builds delete what an earlier version left behind; the info site keeps the consent-aware cleanup.
import { initThemeToggle } from "./theme-toggle";
import { clearLeftoverAnalyticsCookies, purgeLegacyAnalyticsState } from "./ga-cookies";

declare const __SITE__: "app" | "info" | "selfhost";

initThemeToggle();
if (__SITE__ === "info") clearLeftoverAnalyticsCookies();
else purgeLegacyAnalyticsState();
