import { describe, expect, it } from "vitest";
import { KEY_PATTERN, MAX_SECRET_BYTES } from "../src/shared/limits";
import { fromBase64Url, toBase64Url } from "../src/web/base64url";
import { SecretTooLargeError, decryptSecret, encryptSecret } from "../src/web/crypto";
import { CHARSETS, generatePassword, generateToken, generateUuid, randomInt } from "../src/web/generate";
import { buildLink, parseFragment } from "../src/web/link";

describe("base64url", () => {
  it("round-trips every byte value without padding or URL-unsafe characters", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(text)).toEqual(bytes);
  });
});

describe("crypto", () => {
  it("round-trips unicode text", async () => {
    const text = "pässwörd 🔑\nline two";
    const { blob, key } = await encryptSecret(text);
    expect(key).toMatch(KEY_PATTERN);
    expect(await decryptSecret(blob, key)).toBe(text);
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
    await expect(decryptSecret(blob, other.key)).rejects.toThrow();
  });

  it("rejects a tampered blob", async () => {
    const { blob, key } = await encryptSecret("secret");
    blob[blob.length - 1]! ^= 1;
    await expect(decryptSecret(blob, key)).rejects.toThrow();
  });

  it("rejects a malformed key", async () => {
    const { blob } = await encryptSecret("secret");
    await expect(decryptSecret(blob, "short")).rejects.toThrow("Invalid key");
  });

  it("enforces the size limit in bytes, not characters", async () => {
    await expect(encryptSecret("a".repeat(MAX_SECRET_BYTES))).resolves.toBeDefined();
    await expect(encryptSecret("a".repeat(MAX_SECRET_BYTES + 1))).rejects.toBeInstanceOf(SecretTooLargeError);
    await expect(encryptSecret("é".repeat(MAX_SECRET_BYTES / 2 + 1))).rejects.toBeInstanceOf(SecretTooLargeError);
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

  it("builds and parses a link, keeping id and key in the fragment", () => {
    const link = buildLink("https://example.test", { id, key });
    const url = new URL(link);
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(parseFragment(url.hash)).toEqual({ id, key });
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
    `#${id}.${key}=`,
    "#hello",
  ])("flags a damaged fragment: %s", (hash) => {
    expect(parseFragment(hash)).toBe("invalid");
  });
});
