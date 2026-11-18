/** Theme decisions without the DOM, so they can be unit-tested. `public/theme-init.js` mirrors `parseStoredTheme`. */

export type Theme = "light" | "dark";

/** localStorage key; keep in sync with public/theme-init.js. */
export const THEME_STORAGE_KEY = "theme";

/** Accepts only the two known values; anything else (null, junk, old formats) means "no choice made". */
export function parseStoredTheme(value: string | null | undefined): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/** An explicit choice wins; otherwise follow the system setting. */
export function resolveTheme(stored: string | null | undefined, systemPrefersDark: boolean): Theme {
  return parseStoredTheme(stored) ?? (systemPrefersDark ? "dark" : "light");
}

export function otherTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/** Accessible name of the toggle: says what pressing it does. */
export function toggleLabel(current: Theme): string {
  return `Switch to ${otherTheme(current)} theme`;
}
