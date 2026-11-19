// Entry for the info pages (how-it-works, command-line, privacy): header behaviour plus opt-in analytics.
import { initAnalytics } from "./analytics";
import { initThemeToggle } from "./theme-toggle";

initThemeToggle();
initAnalytics();
