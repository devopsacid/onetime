// Entry for 404.html: only the shared header behaviour. No analytics code is imported here.
import { initThemeToggle } from "./theme-toggle";
import { clearLeftoverAnalyticsCookies } from "./ga-cookies";

initThemeToggle();
clearLeftoverAnalyticsCookies();
