import { FORMAT_MAX_BLOB_BYTES, MAX_FILE_BYTES, MAX_SECRET_BYTES } from "../shared/limits";
import { lowerTtlSelection } from "./ttl";
import { ApiError, createSecret, revealSecret, secretExists } from "./api";
import { SecretTooLargeError, WRITE_FILES, WRITE_FORMAT, deriveKey, encryptFile, encryptSecret, openPayload } from "./crypto";
import { createDownload, type Download } from "./download";
import { FILE_TTL_VALUES, checkFileSize, describeFile, fileCreateError, progressPercent, uploadLabel } from "./file-flow";
import { formatBytes } from "./filename";
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

const VIEWS = ["create", "created", "open", "revealed", "file", "gone"] as const;
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
const ppTextEnabled = passphraseCreateEnabled(WRITE_FORMAT);
const ppUse = el<HTMLInputElement>("pp-use");
const ppFirst = el<HTMLInputElement>("pp-first");
const ppSecond = el<HTMLInputElement>("pp-second");
const fileInput = el<HTMLInputElement>("file-input");
const cancelButton = el<HTMLButtonElement>("create-cancel");
const modeRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
const textTtl = new Map<string, string>();

function currentMode(): "text" | "file" {
  return WRITE_FILES && modeRadios.find((radio) => radio.checked)?.value === "file" ? "file" : "text";
}

function syncMode(): void {
  const file = currentMode() === "file";
  el("text-field").hidden = file;
  el("generator").hidden = file;
  el("file-field").hidden = !file;
  el("passphrase-create").hidden = !(file || ppTextEnabled);
  for (const option of ttlSelect.options) {
    const allowed = !file || FILE_TTL_VALUES.includes(Number(option.value));
    option.disabled = !allowed;
    option.hidden = !allowed;
  }
  if (file) {
    textTtl.set("value", ttlSelect.value);
    if (!FILE_TTL_VALUES.includes(Number(ttlSelect.value))) ttlSelect.value = "86400";
  } else if (textTtl.has("value")) {
    ttlSelect.value = textTtl.get("value")!;
  }
  setError("create-error", null);
}

if (WRITE_FILES) {
  el("mode-switch").hidden = false;
  for (const radio of modeRadios) radio.addEventListener("change", syncMode);
}
syncMode();

function resetFileInput(): void {
  fileInput.value = "";
  el("file-summary").textContent = "";
}

function chosenFile(): File | null {
  return fileInput.files?.[0] ?? null;
}

function updateFileSummary(): void {
  const file = chosenFile();
  el("file-summary").textContent = file ? `${file.name} (${formatBytes(file.size)})` : "";
  const problem = file ? checkFileSize(file.size) : null;
  if (problem) setError("create-error", problem);
  else setError("create-error", null);
}
fileInput.addEventListener("change", updateFileSummary);

if (WRITE_FILES) {
  const card = el("create-form");
  card.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    card.classList.add("is-dragging");
  });
  card.addEventListener("dragleave", () => card.classList.remove("is-dragging"));
  card.addEventListener("drop", (event) => {
    event.preventDefault();
    card.classList.remove("is-dragging");
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    const radio = modeRadios.find((r) => r.value === "file");
    if (radio) radio.checked = true;
    syncMode();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    updateFileSummary();
  });
}
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

let uploadAbort: AbortController | null = null;
cancelButton.addEventListener("click", () => uploadAbort?.abort());

el<HTMLFormElement>("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("create-error", null);
  const mode = currentMode();
  const isFile = mode === "file";
  const file = isFile ? chosenFile() : null;
  const text = secretInput.value;
  if (isFile) {
    if (!file) {
      setError("create-error", "Choose a file first.");
      fileInput.focus();
      return;
    }
    const problem = checkFileSize(file.size);
    if (problem) {
      setError("create-error", problem);
      fileInput.focus();
      return;
    }
  } else if (text === "") {
    setError("create-error", "Enter or generate a secret first.");
    secretInput.focus();
    return;
  }

  const plan = planCreate({
    enabled: isFile ? WRITE_FILES : ppTextEnabled,
    checked: ppUse.checked,
    first: ppFirst.value,
    second: ppSecond.value,
  });
  if ("error" in plan) {
    setError("create-error", plan.error);
    ppFirst.focus();
    return;
  }

  createButton.disabled = true;
  const createLabel = createButton.textContent;
  if (isFile) {
    createButton.textContent = "Encrypting…";
    announce("Encrypting…");
  } else if (plan.passphrase !== undefined) {
    createButton.textContent = "Preparing…";
    announce("Preparing…");
  }
  const controller = new AbortController();
  uploadAbort = controller;
  try {
    let made: { blob: Uint8Array<ArrayBuffer>; key: string; format: 1 | 2; passphrase: boolean };
    let fileMade = false;
    if (file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        made = await encryptFile({ name: file.name, type: file.type, bytes }, plan.passphrase);
      } finally {
        bytes.fill(0);
      }
      fileMade = true;
      createButton.textContent = uploadLabel(file.size);
      announce(uploadLabel(file.size));
      cancelButton.hidden = false;
    } else {
      made = await encryptSecret(text, plan.passphrase);
    }
    const id = await createSecret(made.blob, Number(ttlSelect.value), controller.signal);
    secretInput.value = "";
    clearPassphraseFields();
    updateSize();
    el<HTMLInputElement>("link").value = buildLink(location.origin, { id, key: made.key, format: made.format, passphrase: made.passphrase, file: fileMade });
    el("created-pp-hint").hidden = !made.passphrase;
    el("created-check-hint").hidden = !made.passphrase;
    el("created-file").hidden = !file;
    if (file) {
      el("created-file-name").textContent = file.name;
      el("created-file-size").textContent = formatBytes(file.size);
    }
    el("created-ttl").textContent = ttlSelect.selectedOptions[0]?.textContent ?? "";
    resetFileInput();
    show("created");
  } catch (error) {
    if (controller.signal.aborted) {
      setError("create-error", "Upload cancelled. Nothing was shared.");
      announce("Upload cancelled.");
      return;
    }
    const picked =
      error instanceof ApiError && error.status === 409 && error.maxTtl !== undefined
        ? lowerTtlSelection(
            Number(ttlSelect.value),
            error.maxTtl,
            Array.from(ttlSelect.options, (option) => Number(option.value)).filter((value) => !isFile || FILE_TTL_VALUES.includes(value)),
          )
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
        ? isFile
          ? `Files can be at most ${formatBytes(MAX_FILE_BYTES)}.`
          : `The secret is too long. The limit is ${MAX_SECRET_BYTES / 1024} KB.`
        : (fileCreateError(error, isFile) ?? describe(error)),
    );
  } finally {
    uploadAbort = null;
    cancelButton.hidden = true;
    createButton.disabled = false;
    createButton.textContent = createLabel;
  }
});

el("create-another").addEventListener("click", () => {
  el<HTMLInputElement>("link").value = "";
  resetFileInput();
  ppUse.checked = false;
  el("pp-fields").hidden = true;
  show("create");
  (currentMode() === "file" ? fileInput : secretInput).focus();
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
const revealLabel = (file: boolean): string => (file ? "Reveal file" : "Reveal secret");
let download: Download | null = null;

function releaseFile(): void {
  download?.release();
  download = null;
  el("file-name").textContent = "";
}

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
  const ticket = routeGuard.current();
  const result = await openSecretGuarded(routeGuard, ticket, link, openPass.value, {
    deriveKey,
    revealSecret: (id) =>
      revealSecret(id, {
        maxBytes: FORMAT_MAX_BLOB_BYTES,
        onProgress: (loaded, total) => {
          if (!routeGuard.isCurrent(ticket)) return;
          const percent = progressPercent(loaded, total);
          revealButton.textContent = percent === null ? "Receiving…" : `Receiving… ${percent}%`;
        },
      }),
    openBlob: openPayload,
  }, (phase) => {
    if (phase === "preparing") {
      revealButton.textContent = "Preparing…";
      announce("Preparing…");
    } else if (phase === "revealing") {
      revealButton.textContent = "Receiving…";
      announce(link.file ? "Receiving the file…" : "Receiving the secret…");
    } else if (phase === "revealed") {
      // The key has done its job: drop it from the address bar.
      history.replaceState(null, "", location.pathname);
      pending = null;
    }
  });
  revealButton.textContent = revealLabel(link.file);
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
    case "file": {
      openPass.value = "";
      const info = describeFile({ name: outcome.name, type: outcome.type, size: outcome.bytes.byteLength });
      releaseFile();
      el("file-name").textContent = info.name;
      el("file-size").textContent = info.size;
      el("file-type").textContent = info.type;
      el("file-type-row").hidden = info.type === "";
      el("file-risky").hidden = !info.risky;
      download = createDownload(outcome.bytes, outcome.name, el<HTMLAnchorElement>("file-save"));
      show("file");
      announce(info.risky ? "The file is ready. It is a kind of file that can run code: open it only if you expected it." : "The file is ready to save.");
      break;
    }
    case "lost":
      openPass.value = "";
      if (outcome.file) {
        showGone(
          "The file is gone",
          "The file was deleted from the server but did not arrive complete. Ask the sender to send it again.",
        );
      } else {
        showGone(
          "The secret is gone",
          "The secret was deleted from the server but did not arrive complete. Ask the sender for a new link.",
        );
      }
      break;
    case "gone":
      openPass.value = "";
      showGone("This secret is no longer available", GONE_TEXT);
      break;
    case "undecryptable":
      openPass.value = "";
      if (outcome.passphrase) {
        showGone(
          "Wrong passphrase, or the link was changed",
          link.file
            ? "The file has been deleted. Ask the sender to send it again."
            : "The secret has been deleted. Ask the sender for a new link.",
        );
      } else if (link.file) {
        showGone("The file could not be decrypted", "The file was deleted from the server and cannot be recovered. Ask the sender to send it again.");
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

el("file-discard").addEventListener("click", () => {
  releaseFile();
  showGone("The file was discarded", "It is deleted from the server and is no longer on this page. Ask the sender to send it again if you still need it.");
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
  releaseFile();
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
  el("open-title").textContent = parsed.file
    ? parsed.passphrase
      ? "This file is protected by a passphrase"
      : "Someone sent you a file"
    : parsed.passphrase
      ? "This secret is protected by a passphrase"
      : "Someone shared a secret with you";
  el("open-lead").textContent = parsed.file
    ? "The file name and contents are encrypted. You see them after pressing Reveal. It can be downloaded only once: keep this page open until you have saved it."
    : "It can be shown only once. Make sure you are ready to copy it or save it somewhere safe.";
  revealButton.textContent = revealLabel(parsed.file);
  setError("open-error", null);
  syncReveal();
  show("open");
  if (parsed.passphrase) openPass.focus();
}

syncGenerator();

// Keep plaintext and the key-bearing link out of the back/forward cache and out of form-state restore. Some engines
// (WebKit) put field values back after Back even when pagehide cleared them, so pageshow clears again every time.
function clearSensitive(): void {
  releaseFile();
  resetFileInput();
  el<HTMLTextAreaElement>("revealed").value = "";
  el<HTMLInputElement>("link").value = "";
  secretInput.value = "";
  openPass.value = "";
  clearPassphraseFields();
}
window.addEventListener("pagehide", clearSensitive);
window.addEventListener("pageshow", (event) => {
  clearSensitive();
  if (event.persisted) {
    updateSize();
    void route();
  }
});
window.addEventListener("hashchange", () => void route());
void route();
