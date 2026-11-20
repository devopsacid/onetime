import { createCipheriv, createDecipheriv, hkdfSync, pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../../src/web/base64url";
import {
  SecretTooLargeError,
  WRITE_FORMAT,
  createCodec,
  decryptSecret,
  deriveKey,
  encryptSecret,
  openBlob,
  type LinkKey,
} from "../../src/web/crypto";

// The v2 sizes are hard-coded here on purpose: if src/shared/limits.ts drifts, these tests must notice.
const REF_BLOCKS = [256, 1024, 4096, 16388]; // blob sizes 286, 1054, 4126, 16418
const MAX_TEXT = 16384;

// ---- An independent implementation of format 2, straight from docs/plans/blob-v2.md, using node:crypto only. ----

const hkdf = (ikm: Uint8Array, info: string, bytes: number): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info, "ascii"), bytes));

function refKey(kLink: Buffer, passphrase?: string): Buffer {
  if (passphrase === undefined) return hkdf(kLink, "onetime v2 key", 32);
  const salt = hkdf(kLink, "onetime v2 pbkdf2 salt", 16);
  const p = pbkdf2Sync(Buffer.from(passphrase.normalize("NFKC").trim(), "utf8"), salt, 600000, 32, "sha256");
  return hkdf(Buffer.concat([kLink, p]), "onetime v2 key+passphrase", 32);
}

function refEncrypt(secret: string, kLink: Buffer, passphrase?: string, iv = randomBytes(12)): Buffer {
  const bytes = Buffer.from(secret, "utf8");
  const bucket = REF_BLOCKS.find((b) => b >= bytes.length + 4)!;
  const inner = Buffer.alloc(bucket);
  inner.writeUInt32BE(bytes.length, 0);
  bytes.copy(inner, 4);
  const header = Buffer.from([2, passphrase === undefined ? 0 : 1]);
  const cipher = createCipheriv("aes-256-gcm", refKey(kLink, passphrase), iv);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(inner), cipher.final()]);
  return Buffer.concat([header, iv, body, cipher.getAuthTag()]);
}

function refDecrypt(blob: Buffer, kLink: Buffer, passphrase?: string): string {
  const decipher = createDecipheriv("aes-256-gcm", refKey(kLink, passphrase), blob.subarray(2, 14));
  decipher.setAAD(blob.subarray(0, 2));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  const inner = Buffer.concat([decipher.update(blob.subarray(14, blob.length - 16)), decipher.final()]);
  const length = inner.readUInt32BE(0);
  expect(inner.subarray(4 + length).every((b) => b === 0)).toBe(true);
  return inner.subarray(4, 4 + length).toString("utf8");
}

const asBlob = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);
const link2 = (key: string, passphrase = false): LinkKey => ({ key, format: 2, passphrase, file: false });
const PASS = "correct horse battery";

const codec = createCodec({ writeFormat: 2 });

describe("format 2 against an independent node:crypto implementation (real 600,000 iterations)", () => {
  it("opens blobs built by the reference, without a passphrase", async () => {
    const kLink = randomBytes(32);
    const blob = refEncrypt("pässwörd 🔑\nline two", kLink);
    expect(await codec.decryptSecret(asBlob(blob), link2(toBase64Url(kLink)))).toBe("pässwörd 🔑\nline two");
  });

  it("opens blobs built by the reference, with a passphrase", async () => {
    const kLink = randomBytes(32);
    const blob = refEncrypt("token-123", kLink, PASS);
    expect(await codec.decryptSecret(asBlob(blob), link2(toBase64Url(kLink), true), PASS)).toBe("token-123");
  });

  it("the reference opens blobs made by encryptSecret, without a passphrase", async () => {
    const made = await codec.encryptSecret("héllo wörld");
    expect(made).toMatchObject({ format: 2, passphrase: false });
    expect(made.blob.length).toBe(286);
    expect(made.blob[0]).toBe(2);
    expect(made.blob[1]).toBe(0);
    expect(refDecrypt(Buffer.from(made.blob), Buffer.from(fromBase64Url(made.key)))).toBe("héllo wörld");
  });

  it("the reference opens blobs made by encryptSecret, with a passphrase", async () => {
    const made = await codec.encryptSecret("héllo wörld", PASS);
    expect(made).toMatchObject({ format: 2, passphrase: true });
    expect(made.blob[1]).toBe(1);
    expect(refDecrypt(Buffer.from(made.blob), Buffer.from(fromBase64Url(made.key)), PASS)).toBe("héllo wörld");
  });

  it("normalises the passphrase the same way as the reference (NFKC, trimmed)", async () => {
    const kLink = randomBytes(32);
    const blob = refEncrypt("x", kLink, "ｐａｓｓｗｏｒｄ１２");
    expect(await codec.decryptSecret(asBlob(blob), link2(toBase64Url(kLink), true), "  password12 ")).toBe("x");
  });

  it("uses the four sizes, and the exact blob lengths 286, 1054, 4126 and 16418", async () => {
    const sizes = new Map<number, number>();
    for (const length of [0, 252, 253, 1020, 1021, 4092, 4093, MAX_TEXT]) {
      const made = await codec.encryptSecret("a".repeat(length));
      sizes.set(length, made.blob.length);
      expect(await codec.decryptSecret(made.blob, link2(made.key))).toBe("a".repeat(length));
    }
    expect([...sizes.values()]).toEqual([286, 286, 1054, 1054, 4126, 4126, 16418, 16418]);
    expect(sizes.get(MAX_TEXT)).toBe(16418);
  });

  it("refuses a secret above the limit, counted in bytes", async () => {
    await expect(codec.encryptSecret("é".repeat(MAX_TEXT / 2 + 1))).rejects.toBeInstanceOf(SecretTooLargeError);
  });

  it("draws a new key, IV and ciphertext every time", async () => {
    const a = await codec.encryptSecret("same");
    const b = await codec.encryptSecret("same");
    expect(a.key).not.toBe(b.key);
    expect(Buffer.from(a.blob.subarray(2, 14)).equals(Buffer.from(b.blob.subarray(2, 14)))).toBe(false);
  });

  it("does not leave the plaintext in the blob", async () => {
    const { blob } = await codec.encryptSecret("hunter2-hunter2-hunter2");
    expect(Buffer.from(blob).includes("hunter2")).toBe(false);
  });
});

describe("format 2 failures all throw", () => {
  it("a flipped flag byte", async () => {
    const made = await codec.encryptSecret("secret");
    made.blob[1]! ^= 1;
    await expect(codec.decryptSecret(made.blob, link2(made.key))).rejects.toThrow();
    await expect(codec.decryptSecret(made.blob, link2(made.key, true), PASS)).rejects.toThrow();
  });

  it("a flipped version byte", async () => {
    const made = await codec.encryptSecret("secret");
    made.blob[0]! ^= 1;
    await expect(codec.decryptSecret(made.blob, link2(made.key))).rejects.toThrow();
  });

  it("the link's passphrase flag disagreeing with the blob, in both directions", async () => {
    const plain = await codec.encryptSecret("secret");
    await expect(codec.decryptSecret(plain.blob, link2(plain.key, true), PASS)).rejects.toThrow();
    const protectedMade = await codec.encryptSecret("secret", PASS);
    await expect(codec.decryptSecret(protectedMade.blob, link2(protectedMade.key, false))).rejects.toThrow();
  });

  it("a blob encrypted without AAD fails even when its flag byte and the link agree", async () => {
    const kLink = randomBytes(32);
    const key = toBase64Url(kLink);
    for (const passphrase of [undefined, PASS]) {
      const inner = Buffer.alloc(256);
      inner.writeUInt32BE(3, 0);
      inner.write("abc", 4);
      const header = Buffer.from([2, passphrase === undefined ? 0 : 1]);
      const iv = Buffer.alloc(12, 7);
      const cipher = createCipheriv("aes-256-gcm", refKey(kLink, passphrase), iv); // no setAAD
      const body = Buffer.concat([cipher.update(inner), cipher.final()]);
      const blob = asBlob(Buffer.concat([header, iv, body, cipher.getAuthTag()]));
      expect(blob.length).toBe(286);
      await expect(codec.decryptSecret(blob, link2(key, passphrase !== undefined), passphrase)).rejects.toThrow();
    }
  });

  it("a wrong passphrase", async () => {
    const made = await codec.encryptSecret("secret", PASS);
    await expect(codec.decryptSecret(made.blob, link2(made.key, true), "wrong horse battery")).rejects.toThrow();
  });

  it("a wrong link key", async () => {
    const made = await codec.encryptSecret("secret");
    const other = await codec.encryptSecret("secret");
    await expect(codec.decryptSecret(made.blob, link2(other.key))).rejects.toThrow();
  });

  it("a tampered ciphertext, IV or tag", async () => {
    const made = await codec.encryptSecret("secret");
    for (const at of [2, 20, made.blob.length - 1]) {
      const copy = made.blob.slice();
      copy[at]! ^= 1;
      await expect(codec.decryptSecret(copy, link2(made.key))).rejects.toThrow();
    }
  });

  it("a blob whose length is not one of the four sizes", async () => {
    const made = await codec.encryptSecret("secret");
    await expect(codec.decryptSecret(made.blob.slice(0, 285), link2(made.key))).rejects.toThrow();
    const longer = new Uint8Array(287);
    longer.set(made.blob);
    await expect(codec.decryptSecret(longer, link2(made.key))).rejects.toThrow();
  });

  it("padding or length that the reader must refuse, even when the authentication tag is valid", async () => {
    const kLink = randomBytes(32);
    const key = toBase64Url(kLink);
    const build = (mutate: (inner: Buffer) => void): Uint8Array<ArrayBuffer> => {
      const inner = Buffer.alloc(256);
      inner.writeUInt32BE(3, 0);
      inner.write("abc", 4);
      mutate(inner);
      const header = Buffer.from([2, 0]);
      const cipher = createCipheriv("aes-256-gcm", refKey(kLink), Buffer.alloc(12, 1));
      cipher.setAAD(header);
      const body = Buffer.concat([cipher.update(inner), cipher.final()]);
      return asBlob(Buffer.concat([header, Buffer.alloc(12, 1), body, cipher.getAuthTag()]));
    };
    await expect(codec.decryptSecret(build(() => {}), link2(key))).resolves.toBe("abc");
    await expect(codec.decryptSecret(build((i) => (i[100] = 1)), link2(key))).rejects.toThrow();
    await expect(codec.decryptSecret(build((i) => i.writeUInt32BE(253, 0)), link2(key))).rejects.toThrow();
    await expect(codec.decryptSecret(build((i) => i.writeUInt32BE(1, 0)), link2(key))).rejects.toThrow(); // padding not zero
    await expect(codec.decryptSecret(build((i) => i.writeUInt8(0xff, 5)), link2(key))).rejects.toThrow(); // invalid UTF-8
  });

  it("a passphrase on a link that has none, a missing passphrase, and a bad passphrase", async () => {
    const plain = await codec.encryptSecret("secret");
    await expect(codec.decryptSecret(plain.blob, link2(plain.key), PASS)).rejects.toThrow();
    const made = await codec.encryptSecret("secret", PASS);
    await expect(codec.decryptSecret(made.blob, link2(made.key, true))).rejects.toThrow();
    await expect(codec.decryptSecret(made.blob, link2(made.key, true), "short")).rejects.toThrow();
    await expect(codec.encryptSecret("secret", "short")).rejects.toThrow();
  });

  it("a malformed key", async () => {
    const made = await codec.encryptSecret("secret");
    await expect(codec.decryptSecret(made.blob, link2("short"))).rejects.toThrow("Invalid key");
  });

  it("a v2 blob under a v1 link, and a v1 blob under a v2 link", async () => {
    const v2 = await codec.encryptSecret("secret");
    await expect(codec.decryptSecret(v2.blob, { key: v2.key, format: 1, passphrase: false, file: false })).rejects.toThrow();
    const v1 = await createCodec({ writeFormat: 1 }).encryptSecret("secret");
    expect(v1.format).toBe(1);
    await expect(codec.decryptSecret(v1.blob, link2(v1.key))).rejects.toThrow();
  });
});

describe("format 1 stays readable", () => {
  it("opens a blob made by the code before format 2", async () => {
    const blob = Uint8Array.from(Buffer.from("3w3kTomXqSBjvVNfPs23C5MtIZSmhdUjiZ/T0CeEx11lvwZKw/DQqKS3UxcLYU2JtvL/b4g=", "base64"));
    const link: LinkKey = { key: "mjqsQk6qepJVZ4Q1Fhhq72KWlBRgS1ZvTzvQfC3BQqQ", format: 1, passphrase: false, file: false };
    expect(await decryptSecret(blob, link)).toBe("fixture-secret ünï 🔑");
  });

  it("round trips and keeps the old blob size (secret + 28)", async () => {
    const v1 = createCodec({ writeFormat: 1 });
    const made = await v1.encryptSecret("abc");
    expect(made).toMatchObject({ format: 1, passphrase: false, file: false });
    expect(made.blob.length).toBe(3 + 28);
    expect(await v1.decryptSecret(made.blob, { key: made.key, format: 1, passphrase: false, file: false })).toBe("abc");
  });

  it("refuses a passphrase while writing format 1", async () => {
    await expect(createCodec({ writeFormat: 1 }).encryptSecret("abc", PASS)).rejects.toThrow();
  });

  it("a passphrase is never accepted for a format 1 link", async () => {
    const v1 = createCodec({ writeFormat: 1 });
    const made = await v1.encryptSecret("abc");
    await expect(v1.decryptSecret(made.blob, { key: made.key, format: 1, passphrase: false, file: false }, PASS)).rejects.toThrow();
  });
});

describe("module defaults and the iterations test hook", () => {
  it("writes format 2 since deploy 2, and the default exports use WRITE_FORMAT", async () => {
    expect(WRITE_FORMAT).toBe(2);
    expect((await encryptSecret("x")).format).toBe(WRITE_FORMAT);
  });

  it("a different iteration count derives a different key (so the hook cannot be set by accident)", async () => {
    const fast = createCodec({ writeFormat: 2, pbkdf2Iterations: 1000 });
    const made = await fast.encryptSecret("secret", PASS);
    expect(await fast.decryptSecret(made.blob, link2(made.key, true), PASS)).toBe("secret");
    await expect(codec.decryptSecret(made.blob, link2(made.key, true), PASS)).rejects.toThrow();
  });

  it("deriveKey then openBlob equals decryptSecret", async () => {
    const made = await codec.encryptSecret("two steps", PASS);
    const link = link2(made.key, true);
    const aes = await deriveKey(link, PASS);
    expect(aes.extractable).toBe(false);
    expect(await openBlob(made.blob, aes, link)).toBe("two steps");
  });
});
