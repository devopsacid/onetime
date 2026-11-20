import { describe, expect, it } from "vitest";
import { ApiError } from "../src/web/api";
import { createCodec } from "../src/web/crypto";
import { createLatestGuard } from "../src/web/latest";
import { openSecret, openSecretGuarded, type OpenDeps, type OpenPhase } from "../src/web/open-flow";
import { passphraseProblemText, planCreate, passphraseCreateEnabled } from "../src/web/passphrase-ui";

// workerd refuses high PBKDF2 iteration counts; the real count is proven in test/node/crypto-v2.test.ts.
const codec = createCodec({ writeFormat: 2, pbkdf2Iterations: 1000 });
const PASS = "correct horse battery";

async function setup(passphrase?: string) {
  const { blob, key, passphrase: needs } = await codec.encryptSecret("the secret", passphrase);
  const link = { id: "x".repeat(22), key, format: 2 as const, passphrase: needs, file: false };
  const calls: string[] = [];
  const deps: OpenDeps = {
    deriveKey: (l, p) => (calls.push("derive"), codec.deriveKey(l, p)),
    revealSecret: async () => (calls.push("reveal"), blob),
    openBlob: (b, k, l) => (calls.push("open"), codec.openBlob(b, k, l)),
  };
  return { link, deps, calls, blob };
}

describe("openSecret on a passphrase link", () => {
  it("derives before the reveal request, then decrypts", async () => {
    const { link, deps, calls } = await setup(PASS);
    const phases: OpenPhase[] = [];
    const outcome = await openSecret(link, PASS, deps, (p) => phases.push(p));
    expect(outcome).toEqual({ kind: "revealed", text: "the secret" });
    expect(calls).toEqual(["derive", "reveal", "open"]);
    expect(phases).toEqual(["preparing", "revealing", "revealed"]);
  });

  it("refuses an entry that fails validation without any derive or request", async () => {
    const { link, deps, calls } = await setup(PASS);
    for (const entry of ["short", "x".repeat(257), "abcdefgh\u0007ij", ""]) {
      const outcome = await openSecret(link, entry, deps);
      expect(outcome.kind).toBe("invalid");
    }
    expect(calls).toEqual([]);
  });

  it("reports a wrong passphrase as undecryptable after the reveal", async () => {
    const { link, deps, calls } = await setup(PASS);
    const outcome = await openSecret(link, "another passphrase", deps);
    expect(outcome).toEqual({ kind: "undecryptable", passphrase: true });
    expect(calls).toEqual(["derive", "reveal", "open"]);
  });

  it("maps 404 to gone and anything else to network, with no key removal signal", async () => {
    const { link, deps } = await setup(PASS);
    const phases: OpenPhase[] = [];
    const gone = await openSecret(link, PASS, { ...deps, revealSecret: async () => { throw new ApiError(404, "gone"); } }, (p) => phases.push(p));
    expect(gone).toEqual({ kind: "gone" });
    const net = await openSecret(link, PASS, { ...deps, revealSecret: async () => { throw new TypeError("offline"); } }, (p) => phases.push(p));
    expect(net.kind).toBe("network");
    expect(phases).not.toContain("revealed");
  });

  it("works for links without a passphrase and never validates an entry for them", async () => {
    const { link, deps, calls } = await setup();
    const outcome = await openSecret(link, "", deps);
    expect(outcome).toEqual({ kind: "revealed", text: "the secret" });
    expect(calls).toEqual(["derive", "reveal", "open"]);
  });

  it("reports a damaged link without a passphrase as undecryptable (passphrase: false)", async () => {
    const { link, deps } = await setup();
    const outcome = await openSecret(link, "", { ...deps, revealSecret: async () => new Uint8Array(40) });
    expect(outcome).toEqual({ kind: "undecryptable", passphrase: false });
  });
});

describe("create passphrase planning", () => {
  it("is gated on the write format", () => {
    expect(passphraseCreateEnabled(1)).toBe(false);
    expect(passphraseCreateEnabled(2)).toBe(true);
  });

  it("ignores the fields while the box is unchecked or the format is 1", () => {
    expect(planCreate({ enabled: true, checked: false, first: "x", second: "y" })).toEqual({ passphrase: undefined });
    expect(planCreate({ enabled: false, checked: true, first: PASS, second: PASS })).toEqual({ passphrase: undefined });
  });

  it("returns the entered passphrase when valid and equal", () => {
    expect(planCreate({ enabled: true, checked: true, first: PASS, second: PASS })).toEqual({ passphrase: PASS });
  });

  it("explains problems, comparing the normalised values", () => {
    expect(planCreate({ enabled: true, checked: true, first: "short", second: "short" })).toEqual({ error: passphraseProblemText("too-short") });
    expect(planCreate({ enabled: true, checked: true, first: PASS, second: PASS + "x" })).toEqual({ error: "The two passphrases differ." });
    expect(planCreate({ enabled: true, checked: true, first: ` ${PASS} `, second: PASS })).toEqual({ passphrase: ` ${PASS} ` });
    expect(passphraseProblemText("too-long")).toBe("A passphrase has 8 to 256 characters.");
    expect(passphraseProblemText("too-short")).toBe("A passphrase has 8 to 256 characters.");
    expect(passphraseProblemText("control")).toBe("A passphrase cannot contain control characters.");
  });
});

describe("openSecret on a file link before the file UI exists", () => {
  it("refuses with no key derivation and no request, so nothing can be burnt", async () => {
    const { link, deps, calls } = await setup();
    const outcome = await openSecret({ ...link, file: true }, "", deps);
    expect(outcome).toEqual({ kind: "unsupported" });
    expect(calls).toEqual([]);
  });
});

describe("openSecretGuarded: a hash change while a reveal is in flight", () => {
  it("returns the outcome as current when nothing else was routed", async () => {
    const { link, deps } = await setup();
    const guard = createLatestGuard();
    const ticket = guard.current();
    const phases: OpenPhase[] = [];
    const result = await openSecretGuarded(guard, ticket, link, "", deps, (p) => phases.push(p));
    expect(result).toEqual({ stale: false, outcome: { kind: "revealed", text: "the secret" } });
    expect(phases).toEqual(["preparing", "revealing", "revealed"]);
  });

  it("flags the outcome stale and never signals 'revealed' (so the caller never rewrites the address bar) after a new route", async () => {
    const { link, deps } = await setup();
    const guard = createLatestGuard();
    const ticket = guard.current();
    const phases: OpenPhase[] = [];
    const result = await openSecretGuarded(
      guard,
      ticket,
      link,
      "",
      { ...deps, revealSecret: async (id) => (guard.next(), deps.revealSecret(id)) }, // hashchange while the request is out
      (p) => phases.push(p),
    );
    expect(result).toEqual({ stale: true });
    expect(phases).toEqual(["preparing", "revealing"]);
  });

  it("a route that happened before the phases started also suppresses them", async () => {
    const { link, deps } = await setup();
    const guard = createLatestGuard();
    const ticket = guard.current();
    guard.next();
    const phases: OpenPhase[] = [];
    const result = await openSecretGuarded(guard, ticket, link, "", deps, (p) => phases.push(p));
    expect(result.stale).toBe(true);
    expect(phases).toEqual([]);
  });
});
