import { THEME_STORAGE_KEY, otherTheme, resolveTheme, toggleLabel, type Theme } from "./theme";

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the choice lasts for this page view only.
  }
}

/** Wires the header button. Icons are switched by CSS from data-theme, so nothing flashes before this runs. */
export function initThemeToggle(): void {
  const button = document.getElementById("theme-toggle");
  if (!button) return;
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");

  const current = (): Theme => {
    const attr = root.getAttribute("data-theme");
    return resolveTheme(attr ?? readStored(), system.matches);
  };
  const sync = (): void => {
    const label = toggleLabel(current());
    button.setAttribute("aria-label", label);
    button.title = label;
  };

  button.addEventListener("click", () => {
    const next = otherTheme(current());
    root.setAttribute("data-theme", next);
    writeStored(next);
    sync();
  });
  system.addEventListener("change", sync);
  sync();
}
