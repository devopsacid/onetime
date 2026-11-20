import { MAX_SECRET_BYTES } from "../shared/limits";
import { lowerTtlSelection } from "./ttl";
import { ApiError, createSecret, revealSecret, secretExists } from "./api";
import { SecretTooLargeError, WRITE_FORMAT, deriveKey, encryptSecret, openBlob } from "./crypto";
import {
  PASSWORD_LENGTH,
  TOKEN_BYTES,
  generatePassword,
  generateToken,
  generateUuid,
  type CharsetName,
} from "./generate";
import { validatePassphrase } from "./passphrase";
import { createLatestGuard } from "./latest";
import { openSecretGuarded } from "./open-flow";
import { passphraseCreateEnabled, passphraseProblemText, planCreate } from "./passphrase-ui";
import { buildLink, parseFragment, type SecretLink } from "./link";
import { initThemeToggle } from "./theme-toggle";
import { purgeLegacyAnalyticsState } from "./ga-cookies";

initThemeToggle();
purgeLegacyAnalyticsState();

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const VIEWS = ["create", "created", "open", "revealed", "gone"] as const;
type View = (typeof VIEWS)[number];

function show(view: View): void {
  for (const name of VIEWS) el(`view-${name}`).hidden = name !== view;
  if (view !== "create") el(`view-${view}`).querySelector<HTMLElement>("h1")?.focus();
}

function announce(message: string): void {
  el("status").textContent = message;
}

function setError(id: string, message: string | null): void {
  const node = el(id);
  node.textContent = message ?? "";
  node.hidden = message === null;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Could not reach the server. Check your connection and try again.";
}

// ---------- Create ----------

const secretInput = el<HTMLTextAreaElement>("secret");
const ttlSelect = el<HTMLSelectElement>("ttl");
const createButton = el<HTMLButtonElement>("create-submit");
const ppEnabled = passphraseCreateEnabled(WRITE_FORMAT);
const ppUse = el<HTMLInputElement>("pp-use");
const ppFirst = el<HTMLInputElement>("pp-first");
const ppSecond = el<HTMLInputElement>("pp-second");
el("passphrase-create").hidden = !ppEnabled;
ppUse.addEventListener("change", () => {
  el("pp-fields").hidden = !ppUse.checked;
  if (ppUse.checked) ppFirst.focus();
});

function clearPassphraseFields(): void {
  ppFirst.value = "";
  ppSecond.value = "";
  openPass.value = "";
}

function updateSize(): void {
  const bytes = new TextEncoder().encode(secretInput.value).byteLength;
  el("secret-size").textContent =
    bytes > MAX_SECRET_BYTES ? `Too long: ${bytes} of ${MAX_SECRET_BYTES} bytes` : "";
}

secretInput.addEventListener("input", updateSize);

el<HTMLFormElement>("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("create-error", null);
  const text = secretInput.value;
  if (text === "") {
    setError("create-error", "Enter or generate a secret first.");
    secretInput.focus();
    return;
  }

  const plan = planCreate({ enabled: ppEnabled, checked: ppUse.checked, first: ppFirst.value, second: ppSecond.value });
  if ("error" in plan) {
    setError("create-error", plan.error);
    ppFirst.focus();
    return;
  }

  createButton.disabled = true;
  const createLabel = createButton.textContent;
  if (plan.passphrase !== undefined) {
    createButton.textContent = "Preparing…";
    announce("Preparing…");
  }
  try {
    const { blob, key, format, passphrase } = await encryptSecret(text, plan.passphrase);
    const id = await createSecret(blob, Number(ttlSelect.value));
    secretInput.value = "";
    clearPassphraseFields();
    updateSize();
    el<HTMLInputElement>("link").value = buildLink(location.origin, { id, key, format, passphrase, file: false });
    el("created-pp-hint").hidden = !passphrase;
    el("created-check-hint").hidden = !passphrase;
    el("created-ttl").textContent = ttlSelect.selectedOptions[0]?.textContent ?? "";
    show("created");
  } catch (error) {
    const picked =
      error instanceof ApiError && error.status === 409 && error.maxTtl !== undefined
        ? lowerTtlSelection(Number(ttlSelect.value), error.maxTtl, Array.from(ttlSelect.options, (option) => Number(option.value)))
        : null;
    if (picked !== null) {
      // Never resubmit silently: the sender decides.
      ttlSelect.value = String(picked);
      const label = ttlSelect.selectedOptions[0]?.textContent?.toLowerCase() ?? "1 day";
      setError(
        "create-error",
        `The service is nearly full, so links can last at most ${label} right now. Expiry is now set to ${label}: press Create one-time link again.`,
      );
      createButton.disabled = false;
      createButton.focus();
      return;
    }
    setError(
      "create-error",
      error instanceof SecretTooLargeError
        ? `The secret is too long. The limit is ${MAX_SECRET_BYTES / 1024} KB.`
        : describe(error),
    );
  } finally {
    createButton.disabled = false;
    createButton.textContent = createLabel;
  }
});

el("create-another").addEventListener("click", () => {
  el<HTMLInputElement>("link").value = "";
  ppUse.checked = false;
  el("pp-fields").hidden = true;
  show("create");
  secretInput.focus();
});

// ---------- Generator ----------

const genType = el<HTMLSelectElement>("gen-type");
const genLength = el<HTMLInputElement>("gen-length");

function syncGenerator(): void {
  const type = genType.value;
  const range = type === "password" ? PASSWORD_LENGTH : TOKEN_BYTES;
  el("gen-length-field").hidden = type === "uuid";
  el("gen-sets").hidden = type !== "password";
  el("gen-length-label").textContent = type === "password" ? "Characters" : "Bytes";
  genLength.min = String(range.min);
  genLength.max = String(range.max);
  genLength.value = String(range.default);
  setError("gen-error", null);
}

function generate(): string {
  const type = genType.value;
  if (type === "uuid") return generateUuid();
  const length = Number(genLength.value);
  if (type === "hex" || type === "base64url") return generateToken(length, type);
  const sets = [...document.querySelectorAll<HTMLInputElement>('#gen-sets input[name="set"]:checked')].map(
    (box) => box.value as CharsetName,
  );
  return generatePassword({ length, sets, avoidLookalikes: el<HTMLInputElement>("gen-lookalikes").checked });
}

genType.addEventListener("change", syncGenerator);

el("gen-run").addEventListener("click", () => {
  setError("gen-error", null);
  try {
    secretInput.value = generate();
    updateSize();
    setError("create-error", null);
    announce("Generated and placed in the secret field.");
  } catch (error) {
    const range = genType.value === "password" ? PASSWORD_LENGTH : TOKEN_BYTES;
    setError(
      "gen-error",
      error instanceof RangeError && error.message.startsWith("Choose")
        ? "Choose at least one character set."
        : `Enter a whole number from ${range.min} to ${range.max}.`,
    );
  }
});

// ---------- Open ----------

let pending: SecretLink | null = null;
const revealButton = el<HTMLButtonElement>("reveal");

function showGone(title: string, text: string): void {
  el("gone-title").textContent = title;
  el("gone-text").textContent = text;
  show("gone");
}

const GONE_TEXT =
  "One-time links work a single time and expire if nobody opens them. Ask the sender for a new link.";

const openPass = el<HTMLInputElement>("open-pass");
const REVEAL_LABEL = revealButton.textContent;

function syncReveal(): void {
  revealButton.disabled = pending?.passphrase === true && validatePassphrase(openPass.value) !== null;
}
openPass.addEventListener("input", syncReveal);

el<HTMLFormElement>("open-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pending || revealButton.disabled) return;
  const link = pending;
  setError("open-error", null);
  revealButton.disabled = true;
  openPass.readOnly = true;
  // A hashchange while the request is out starts a new route: its outcome must not touch the page or the address bar.
  const result = await openSecretGuarded(routeGuard, routeGuard.current(), link, openPass.value, { deriveKey, revealSecret, openBlob }, (phase) => {
    if (phase === "preparing") {
      revealButton.textContent = "Preparing…";
      announce("Preparing…");
    } else if (phase === "revealed") {
      // The key has done its job: drop it from the address bar.
      history.replaceState(null, "", location.pathname);
      pending = null;
    }
  });
  revealButton.textContent = REVEAL_LABEL;
  openPass.readOnly = false;
  if (result.stale) {
    syncReveal();
    return;
  }
  const outcome = result.outcome;
  switch (outcome.kind) {
    case "revealed":
      openPass.value = "";
      el<HTMLTextAreaElement>("revealed").value = outcome.text;
      show("revealed");
      break;
    case "unsupported":
      showGone("This page cannot open this link yet", "This link holds a file. Nothing has been used up. Try again later.");
      break;
    case "gone":
      openPass.value = "";
      showGone("This secret is no longer available", GONE_TEXT);
      break;
    case "undecryptable":
      openPass.value = "";
      if (outcome.passphrase) {
        showGone("Wrong passphrase, or the link was changed", "The secret has been deleted. Ask the sender for a new link.");
      } else {
        showGone(
          "This secret could not be decrypted",
          "The link was probably changed or cut off on the way. The secret has been deleted; ask the sender for a new link.",
        );
      }
      break;
    case "invalid":
      setError("open-error", passphraseProblemText(outcome.problem));
      openPass.focus();
      break;
    case "prepare-failed":
      setError("open-error", "Could not prepare the key. Nothing has been used up. Reload the page and try again.");
      break;
    case "network":
      // The entered passphrase stays so the user can retry without retyping.
      setError(
        "open-error",
        `${describe(outcome.error)} The secret may already have been deleted. You can try again; if it then shows as no longer available, ask the sender for a new link.`,
      );
      break;
  }
  syncReveal();
});

// ---------- Copy ----------

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  button.addEventListener("click", async () => {
    const source = el<HTMLInputElement | HTMLTextAreaElement>(button.dataset["copy"]!);
    try {
      await navigator.clipboard.writeText(source.value);
      button.textContent = "Copied";
      announce("Copied to clipboard.");
      setTimeout(() => (button.textContent = "Copy"), 2000);
    } catch {
      source.focus();
      source.select();
      announce("Copy failed. The text is selected: press Ctrl or Command and C.");
    }
  });
}

// ---------- Routing ----------

const routeGuard = createLatestGuard();

async function route(): Promise<void> {
  const ticket = routeGuard.next();
  el<HTMLTextAreaElement>("revealed").value = "";
  pending = null;
  clearPassphraseFields();
  const parsed = parseFragment(location.hash);

  if (parsed === null) {
    show("create");
    return;
  }
  if (parsed === "invalid") {
    showGone(
      "This link is incomplete",
      "Part of the link is missing or changed. Copy the whole link again, including everything after the # sign.",
    );
    return;
  }

  if (parsed.file) {
    // File links need the file UI, which this build does not have yet. No request is made, so nothing is used up.
    showGone(
      "This page cannot open this link yet",
      "This link holds a file, and this version of the page cannot receive files. Nothing has been used up. Try again later.",
    );
    return;
  }

  try {
    const exists = await secretExists(parsed.id);
    if (!routeGuard.isCurrent(ticket)) return;
    if (!exists) {
      showGone("This secret is no longer available", GONE_TEXT);
      return;
    }
  } catch {
    // Status check failed (offline?): still offer the button, the reveal call reports the real error.
  }
  if (!routeGuard.isCurrent(ticket)) return;
  pending = parsed;
  openPass.value = "";
  el("open-passphrase").hidden = !parsed.passphrase;
  el("open-title").textContent = parsed.passphrase ? "This secret is protected by a passphrase" : "Someone shared a secret with you";
  setError("open-error", null);
  syncReveal();
  show("open");
  if (parsed.passphrase) openPass.focus();
}

syncGenerator();

// Keep plaintext and the key-bearing link out of the back/forward cache.
window.addEventListener("pagehide", () => {
  el<HTMLTextAreaElement>("revealed").value = "";
  el<HTMLInputElement>("link").value = "";
  secretInput.value = "";
  clearPassphraseFields();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    updateSize();
    void route();
  }
});
window.addEventListener("hashchange", () => void route());
void route();
