import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY_PATTERN, MAX_SECRET_BYTES } from "../src/shared/limits";
import { fromBase64Url, toBase64Url } from "../src/web/base64url";
import { SecretTooLargeError, WRITE_FORMAT, createCodec, decryptSecret, encryptSecret } from "../src/web/crypto";
import { CHARSETS, generatePassword, generateToken, generateUuid, randomInt } from "../src/web/generate";
import { buildLink, parseFragment } from "../src/web/link";
import { ApiError, createSecret } from "../src/web/api";
import { lowerTtlSelection, pickTtlOption } from "../src/web/ttl";

describe("base64url", () => {
  it("round-trips every byte value without padding or URL-unsafe characters", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(text)).toEqual(bytes);
  });
});

describe("crypto", () => {
  const v1 = (key: string) => ({ key, format: 1 as const, passphrase: false });
  const v2 = (key: string, passphrase = false) => ({ key, format: 2 as const, passphrase });
  // workerd refuses high PBKDF2 iteration counts; the real 600,000 path is proven in test/node/crypto-v2.test.ts.
  const codec = createCodec({ writeFormat: 2, pbkdf2Iterations: 1000 });

  it("round-trips unicode text", async () => {
    const text = "pässwörd 🔑\nline two";
    const { blob, key, format } = await encryptSecret(text);
    expect(key).toMatch(KEY_PATTERN);
    expect(format).toBe(WRITE_FORMAT);
    expect(await decryptSecret(blob, v1(key))).toBe(text);
  });

  it("does not leave the plaintext in the blob", async () => {
    const { blob } = await encryptSecret("hunter2-hunter2-hunter2");
    expect(new TextDecoder().decode(blob)).not.toContain("hunter2");
  });

  it("uses a new key and IV each time", async () => {
    const a = await encryptSecret("same");
    const b = await encryptSecret("same");
    expect(a.key).not.toBe(b.key);
    expect(a.blob).not.toEqual(b.blob);
  });

  it("rejects a wrong key", async () => {
    const { blob } = await encryptSecret("secret");
    const other = await encryptSecret("secret");
    await expect(decryptSecret(blob, v1(other.key))).rejects.toThrow();
  });

  it("rejects a tampered blob", async () => {
    const { blob, key } = await encryptSecret("secret");
    blob[blob.length - 1]! ^= 1;
    await expect(decryptSecret(blob, v1(key))).rejects.toThrow();
  });

  it("rejects a malformed key", async () => {
    const { blob } = await encryptSecret("secret");
    await expect(decryptSecret(blob, v1("short"))).rejects.toThrow("Invalid key");
  });

  it("enforces the size limit in bytes, not characters", async () => {
    await expect(encryptSecret("a".repeat(MAX_SECRET_BYTES))).resolves.toBeDefined();
    await expect(encryptSecret("a".repeat(MAX_SECRET_BYTES + 1))).rejects.toBeInstanceOf(SecretTooLargeError);
    await expect(encryptSecret("é".repeat(MAX_SECRET_BYTES / 2 + 1))).rejects.toBeInstanceOf(SecretTooLargeError);
  });

  it("format 2 round-trips in the Workers runtime, with and without a passphrase", async () => {
    const plain = await codec.encryptSecret("héllo");
    expect(plain.blob.length).toBe(286);
    expect(await codec.decryptSecret(plain.blob, v2(plain.key))).toBe("héllo");
    const guarded = await codec.encryptSecret("héllo", "correct horse");
    expect(await codec.decryptSecret(guarded.blob, v2(guarded.key, true), "correct horse")).toBe("héllo");
    await expect(codec.decryptSecret(guarded.blob, v2(guarded.key, true), "wrong horse!!")).rejects.toThrow();
  });
});

describe("generator", () => {
  it("randomInt stays in range and reaches every value", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const value = randomInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
      seen.add(value);
    }
    expect(seen.size).toBe(7);
    expect(() => randomInt(0)).toThrow(RangeError);
  });

  it("password has the requested length and one character from each set", () => {
    for (let i = 0; i < 50; i++) {
      const password = generatePassword({
        length: 8,
        sets: ["lower", "upper", "digits", "symbols"],
        avoidLookalikes: false,
      });
      expect(password).toHaveLength(8);
      for (const set of Object.values(CHARSETS)) {
        expect([...password].some((char) => set.includes(char))).toBe(true);
      }
    }
  });

  it("password uses only the chosen sets", () => {
    expect(generatePassword({ length: 64, sets: ["digits"], avoidLookalikes: false })).toMatch(/^[0-9]{64}$/);
  });

  it("skips look-alike characters when asked", () => {
    for (let i = 0; i < 20; i++) {
      const password = generatePassword({ length: 128, sets: ["lower", "upper", "digits"], avoidLookalikes: true });
      expect(password).not.toMatch(/[Il1O0o]/);
    }
  });

  it("rejects bad password options", () => {
    expect(() => generatePassword({ length: 24, sets: [], avoidLookalikes: false })).toThrow(RangeError);
    expect(() => generatePassword({ length: 7, sets: ["lower"], avoidLookalikes: false })).toThrow(RangeError);
    expect(() => generatePassword({ length: 129, sets: ["lower"], avoidLookalikes: false })).toThrow(RangeError);
    expect(() => generatePassword({ length: 12.5, sets: ["lower"], avoidLookalikes: false })).toThrow(RangeError);
  });

  it("tokens have the right size and alphabet", () => {
    expect(generateToken(32, "hex")).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken(32, "base64url")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken(32, "hex")).not.toBe(generateToken(32, "hex"));
    expect(() => generateToken(8, "hex")).toThrow(RangeError);
    expect(() => generateToken(65, "hex")).toThrow(RangeError);
  });

  it("uuid is version 4", () => {
    expect(generateUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("link", () => {
  const id = "A".repeat(22);
  const key = "b".repeat(43);

  it("builds and parses a v1 link, keeping id and key in the fragment", () => {
    const link = buildLink("https://example.test", { id, key, format: 1, passphrase: false });
    expect(link).toBe(`https://example.test/#${id}.${key}`);
    const url = new URL(link);
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(parseFragment(url.hash)).toEqual({ id, key, format: 1, passphrase: false });
  });

  it("builds and parses the two v2 forms", () => {
    const plain = buildLink("https://example.test", { id, key, format: 2, passphrase: false });
    expect(plain).toBe(`https://example.test/#2.${id}.${key}`);
    expect(parseFragment(new URL(plain).hash)).toEqual({ id, key, format: 2, passphrase: false });
    const protectedLink = buildLink("https://example.test", { id, key, format: 2, passphrase: true });
    expect(protectedLink).toBe(`https://example.test/#2p.${id}.${key}`);
    expect(parseFragment(new URL(protectedLink).hash)).toEqual({ id, key, format: 2, passphrase: true });
  });

  it("never builds a passphrase link in format 1", () => {
    expect(buildLink("https://example.test", { id, key, format: 1, passphrase: true })).toBe(`https://example.test/#${id}.${key}`);
  });

  it("accepts the fragment without the leading #", () => {
    expect(parseFragment(`2p.${id}.${key}`)).toEqual({ id, key, format: 2, passphrase: true });
  });

  it("treats an empty fragment as no link", () => {
    expect(parseFragment("")).toBeNull();
    expect(parseFragment("#")).toBeNull();
  });

  it.each([
    `#${id}`,
    `#${id}.`,
    `#${id}.${key.slice(1)}`,
    `#${id.slice(1)}.${key}`,
    `#${id}.${key}.x`,
    `#${id}.${key}.2`,
    `#${id}.${key}.2p`,
    `#3.${id}.${key}`,
    `#1.${id}.${key}`,
    `#2P.${id}.${key}`,
    `#2pp.${id}.${key}`,
    `#.${id}.${key}`,
    `#2.${id}.${key}.x`,
    `#2.${id}.${key.slice(1)}`,
    `#2p.${id}`,
    `#2.${id}.`,
    `#2.${id.slice(1)}.${key}`,
    `#${id}.${key}=`,
    "#hello",
  ])("flags a damaged fragment: %s", (hash) => {
    expect(parseFragment(hash)).toBe("invalid");
  });
});

describe("pickTtlOption", () => {
  const values = [3600, 86400, 604800];
  it("picks the largest option not above maxTtl", () => {
    expect(pickTtlOption(86400, values)).toBe(86400);
    expect(pickTtlOption(90000, values)).toBe(86400);
    expect(pickTtlOption(3600, values)).toBe(3600);
    expect(pickTtlOption(3600, [604800, 3600, 86400])).toBe(3600);
  });
  it("returns null when nothing fits", () => {
    expect(pickTtlOption(60, values)).toBeNull();
  });
});

describe("lowerTtlSelection", () => {
  const values = [3600, 86400, 604800];
  it("lowers a longer selection to the largest option that fits", () => {
    expect(lowerTtlSelection(604800, 86400, values)).toBe(86400);
    expect(lowerTtlSelection(604800, 90000, values)).toBe(86400);
    expect(lowerTtlSelection(86400, 3600, values)).toBe(3600);
  });
  it("never raises the selection: a shorter pick keeps the sender's choice", () => {
    expect(lowerTtlSelection(3600, 86400, values)).toBeNull();
    expect(lowerTtlSelection(3600, 604800, values)).toBeNull();
  });
  it("leaves an equal selection alone", () => {
    expect(lowerTtlSelection(86400, 86400, values)).toBeNull();
  });
  it("returns null when no option fits", () => {
    expect(lowerTtlSelection(3600, 60, values)).toBeNull();
  });
});

describe("ApiError.maxTtl", () => {
  afterEach(() => vi.unstubAllGlobals());
  async function failWith(body: unknown, status = 409): Promise<ApiError> {
    vi.stubGlobal("fetch", async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    try {
      await createSecret(new Uint8Array(40), 604800);
    } catch (e) {
      return e as ApiError;
    }
    throw new Error("should have failed");
  }
  it("reads a valid maxTtl", async () => {
    const e = await failWith({ error: "full", maxTtl: 86400 });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.maxTtl).toBe(86400);
  });
  it("ignores missing, string, fractional and out-of-range values and non-JSON", async () => {
    expect((await failWith({ error: "x" })).maxTtl).toBeUndefined();
    expect((await failWith({ error: "x", maxTtl: "86400" })).maxTtl).toBeUndefined();
    expect((await failWith({ error: "x", maxTtl: 1.5 })).maxTtl).toBeUndefined();
    expect((await failWith({ error: "x", maxTtl: 59 })).maxTtl).toBeUndefined();
    expect((await failWith({ error: "x", maxTtl: 604801 })).maxTtl).toBeUndefined();
    expect((await failWith("not json")).maxTtl).toBeUndefined();
  });
});

describe("interop: parsers before format 2 reject the new links before anything is revealed", () => {
  // The parsing rule of the code before format 2 (src/web/link.ts and the CLI's parseLinkInput), copied verbatim.
  function oldParseFragment(hash: string): { id: string; key: string } | "invalid" | null {
    const fragment = hash.replace(/^#/, "");
    if (fragment === "") return null;
    const [id, key, ...rest] = fragment.split(".");
    if (rest.length > 0 || !id || !key || !/^[A-Za-z0-9_-]{22}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return "invalid";
    return { id, key };
  }
  const id = "A".repeat(22);
  const key = "b".repeat(43);

  it("old readers call 2. and 2p. links invalid (nothing is burnt), and still read v1", () => {
    expect(oldParseFragment(`#2.${id}.${key}`)).toBe("invalid");
    expect(oldParseFragment(`#2p.${id}.${key}`)).toBe("invalid");
    expect(oldParseFragment(`#${id}.${key}`)).toEqual({ id, key });
  });

  it("new readers read what old writers made, and old writers' links parse identically", () => {
    expect(parseFragment(`#${id}.${key}`)).toMatchObject({ id, key, format: 1, passphrase: false });
  });
});

describe("FORMAT_PATTERN", () => {
  it("matches exactly 2 and 2p", async () => {
    const { FORMAT_PATTERN } = await import("../src/shared/limits");
    for (const ok of ["2", "2p"]) expect(FORMAT_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "1", "3", "2P", "2pp", "p2", " 2", "2\n"]) expect(FORMAT_PATTERN.test(bad)).toBe(false);
  });
});
