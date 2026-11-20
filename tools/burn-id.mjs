#!/usr/bin/env node
// Deletes a stored secret by id, for abuse reports (docs/plans/file-transfer.md A-11). No dependencies, Node 22+.
//
//   node tools/burn-id.mjs <origin> <id-or-link>
//
// <id-or-link> is the 22-character id, or a link or `<id>.<key>`, `<fmt>.<id>` or `<fmt>.<id>.<key>` fragment (fmt = 2, 2f, 2p, 2fp) from which only the id is taken.
// The key is never printed, logged or sent: it is dropped as soon as the id is cut out. The script sends
// POST <origin>/api/secrets/<id>/reveal, which deletes the row, and throws the answer away (it is encrypted anyway).
// Prints `deleted` (200) or `not stored` (404). Exit codes: 0 either answer, 2 usage, 5 network or server error.
// It works for the hosted site and any self-hosted instance. Never open a reported link with its key.

// Same pattern as ID_PATTERN in src/shared/limits.ts (a test keeps them equal).
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const FORMAT_PATTERN = /^2f?p?$/;

function usage(message) {
  console.error(`burn-id: ${message}`);
  console.error("usage: node tools/burn-id.mjs <origin> <id-or-link>");
  process.exit(2);
}

/** The id inside an id, a link, `<id>.<key>` or `<format>.<id>.<key>`; null if there is none. Never returns the key. */
function extractId(input) {
  let fragment = input.trim();
  if (fragment.includes("://")) {
    try {
      fragment = new URL(fragment).hash;
    } catch {
      return null;
    }
  }
  fragment = fragment.replace(/^#/, "");
  let parts = fragment.split(".");
  // A leading format marker (2, 2f, 2p, 2fp) is dropped; reporters may also have removed the key (`2f.<id>`).
  if (parts.length > 1 && FORMAT_PATTERN.test(parts[0])) parts = parts.slice(1);
  const id = parts.length === 1 || parts.length === 2 ? parts[0] : "";
  return ID_PATTERN.test(id) ? id : null;
}

const [originArg, input, ...rest] = process.argv.slice(2);
if (originArg === undefined || input === undefined || rest.length > 0) usage("expected an origin and an id or link");

let origin;
try {
  const url = new URL(originArg);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("scheme");
  origin = url.origin;
} catch {
  usage("the origin must be an https URL (http only for localhost and 127.0.0.1)");
}

const id = extractId(input);
if (id === null) usage("that is not a secret id or link");

try {
  const response = await fetch(`${origin}/api/secrets/${id}/reveal`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel().catch(() => {});
  if (response.status === 200) console.log("deleted");
  else if (response.status === 404) console.log("not stored");
  else {
    console.error(`burn-id: the server answered ${response.status}`);
    process.exit(5);
  }
} catch {
  console.error("burn-id: could not reach the server");
  process.exit(5);
}
