// Google Analytics 4 for the info pages only (imported by info.ts, never by main.ts or page.ts).
// Nothing is requested before the visitor accepts: the gtag.js loader is added to the page after Accept.
import { GA_MEASUREMENT_ID } from "./analytics-config";
import { cliDownloadKind } from "./analytics-events";
import { analyticsAllowedHere } from "./analytics-origin";
import { CONSENT_STORAGE_KEY, analyticsEnabled, sanitizePageLocation, serializeConsent, type Decision } from "./consent";
import { deleteAnalyticsCookies, readConsentDecision } from "./ga-cookies";

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

const COOKIE_EXPIRES_SECONDS = 365 * 24 * 60 * 60;

/** gtag must push the `arguments` object itself, not an array. */
function gtag(..._args: unknown[]): void {
  (window.dataLayer ??= []).push(arguments);
}

let loaded = false;

function loadAnalytics(): void {
  if (loaded) return;
  loaded = true;
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  });
  gtag("consent", "update", { analytics_storage: "granted" });
  gtag("js", new Date());
  gtag("config", GA_MEASUREMENT_ID, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_expires: COOKIE_EXPIRES_SECONDS,
    page_location: sanitizePageLocation(location.href),
    page_referrer: "",
  });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
  document.head.appendChild(script);

  document.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!link) return;
    try {
      const kind = cliDownloadKind(new URL((link as HTMLAnchorElement).href, location.href).pathname);
      if (kind) gtag("event", "cli_download", { file: kind });
    } catch {
      // Not a parseable link: nothing to count.
    }
  });
}

function store(decision: Decision): void {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, serializeConsent(decision, Date.now()));
  } catch {
    // Storage blocked: the choice lasts for this page view only.
  }
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "button button-secondary";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

let banner: HTMLElement | null = null;

function closeBanner(): void {
  banner?.remove();
  banner = null;
}

function openBanner(focus: boolean): void {
  if (banner) return;
  const section = document.createElement("section");
  section.className = "consent-banner";
  section.setAttribute("role", "region");
  section.setAttribute("aria-labelledby", "consent-title");
  section.tabIndex = -1;

  const title = document.createElement("h2");
  title.id = "consent-title";
  title.textContent = "Visit statistics";
  const text = document.createElement("p");
  text.append(
    "May this page use Google Analytics to count visits? It sets cookies and sends usage data to Google (pages visited, IP address, approximate location, browser and device). Nothing is sent unless you accept. The page where secrets are created and opened never uses it. ",
  );
  const more = document.createElement("a");
  more.href = "/privacy#cookies";
  more.textContent = "Privacy and cookies";
  text.append(more, ".");

  const current = document.createElement("p");
  current.className = "consent-current";
  const choice = readConsentDecision();
  current.textContent = `Current choice: ${choice === "accepted" ? "accepted" : choice === "rejected" ? "rejected" : "not chosen"}.`;

  const actions = document.createElement("div");
  actions.className = "consent-actions";
  actions.append(
    button("Accept", () => {
      store("accepted");
      closeBanner();
      loadAnalytics();
    }),
    button("Reject", () => {
      const wasLoaded = loaded;
      store("rejected");
      deleteAnalyticsCookies();
      closeBanner();
      // A running tracker cannot be unloaded: start over without it.
      if (wasLoaded) location.reload();
    }),
  );

  section.append(title, text, current, actions);
  const header = document.querySelector(".site-header");
  if (header) header.after(section);
  else document.body.prepend(section);
  banner = section;
  if (focus) {
    const show = (): void => {
      section.scrollIntoView({ block: "start" });
      section.focus();
    };
    // The browser's own fragment scrolling after load would otherwise take the focus away again.
    if (document.readyState === "complete") show();
    else window.addEventListener("load", () => setTimeout(show, 0), { once: true });
  }
}

export function initAnalytics(): void {
  // Only on the original site's origin: a fork deployed elsewhere never loads gtag or shows the banner.
  if (!analyticsAllowedHere(location.origin)) return;
  if (!analyticsEnabled(GA_MEASUREMENT_ID)) {
    deleteAnalyticsCookies();
    return;
  }
  const decision = readConsentDecision();
  if (decision === "accepted") loadAnalytics();
  else deleteAnalyticsCookies();
  const wantsSettings = (): boolean => /^\/privacy(\.html)?$/.test(location.pathname) && location.hash === "#cookies";
  if (decision === null || wantsSettings()) openBanner(wantsSettings());
  window.addEventListener("hashchange", () => {
    if (wantsSettings()) openBanner(true);
  });

  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-cookie-settings]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openBanner(true);
    });
  }
}
