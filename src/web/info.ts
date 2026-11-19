// Entry for the info pages (how-it-works, command-line, privacy): header behaviour plus opt-in analytics.
// The self-host build defines __GA_ENABLED__ as false, so analytics.ts and the GA ID are tree-shaken out.
import { initAnalytics } from "./analytics";
import { initThemeToggle } from "./theme-toggle";

declare const __GA_ENABLED__: boolean;

initThemeToggle();
if (__GA_ENABLED__) initAnalytics();
