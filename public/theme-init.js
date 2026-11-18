// Runs before first paint (synchronous, in <head>) so a stored theme choice never flashes.
// Without a stored choice no attribute is set and the CSS follows prefers-color-scheme.
// Mirrors parseStoredTheme in src/web/theme.ts.
(function () {
  try {
    var t = localStorage.getItem("theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    // Storage blocked: follow the system setting.
  }
})();
