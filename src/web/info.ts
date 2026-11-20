// Entry for the info pages (how-it-works, privacy): header behaviour plus opt-in analytics.
// __SITE__ is "info" only in the info build, so analytics.ts and the GA ID are tree-shaken out of the app and self-host builds.
import { initAnalytics } from "./analytics";
import { initThemeToggle } from "./theme-toggle";

declare const __SITE__: "app" | "info" | "selfhost";

initThemeToggle();
if (__SITE__ === "info") initAnalytics();
