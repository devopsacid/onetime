import { MAX_SECRET_BYTES } from "../shared/limits";
import { ApiError, createSecret, revealSecret, secretExists } from "./api";
import { SecretTooLargeError, decryptSecret, encryptSecret } from "./crypto";
import {
  PASSWORD_LENGTH,
  TOKEN_BYTES,
  generatePassword,
  generateToken,
  generateUuid,
  type CharsetName,
} from "./generate";
import { createLatestGuard } from "./latest";
import { buildLink, parseFragment, type SecretLink } from "./link";

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

  createButton.disabled = true;
  try {
    const { blob, key } = await encryptSecret(text);
    const id = await createSecret(blob, Number(ttlSelect.value));
    secretInput.value = "";
    updateSize();
    el<HTMLInputElement>("link").value = buildLink(location.origin, { id, key });
    el("created-ttl").textContent = ttlSelect.selectedOptions[0]?.textContent ?? "";
    show("created");
  } catch (error) {
    setError(
      "create-error",
      error instanceof SecretTooLargeError
        ? `The secret is too long. The limit is ${MAX_SECRET_BYTES / 1024} KB.`
        : describe(error),
    );
  } finally {
    createButton.disabled = false;
  }
});

el("create-another").addEventListener("click", () => {
  el<HTMLInputElement>("link").value = "";
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

revealButton.addEventListener("click", async () => {
  if (!pending) return;
  const { id, key } = pending;
  setError("open-error", null);
  revealButton.disabled = true;
  try {
    const blob = await revealSecret(id);
    // The key has done its job: drop it from the address bar.
    history.replaceState(null, "", location.pathname);
    pending = null;
    try {
      el<HTMLTextAreaElement>("revealed").value = await decryptSecret(blob, key);
      show("revealed");
    } catch {
      showGone(
        "This secret could not be decrypted",
        "The link was probably changed or cut off on the way. The secret has been deleted; ask the sender for a new link.",
      );
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      showGone("This secret is no longer available", GONE_TEXT);
    } else {
      setError(
        "open-error",
        `${describe(error)} The secret may already have been deleted. You can try again; if it then shows as no longer available, ask the sender for a new link.`,
      );
    }
  } finally {
    revealButton.disabled = false;
  }
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
  setError("open-error", null);
  show("open");
}

syncGenerator();

// Keep plaintext and the key-bearing link out of the back/forward cache.
window.addEventListener("pagehide", () => {
  el<HTMLTextAreaElement>("revealed").value = "";
  el<HTMLInputElement>("link").value = "";
  secretInput.value = "";
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    updateSize();
    void route();
  }
});
window.addEventListener("hashchange", () => void route());
void route();
