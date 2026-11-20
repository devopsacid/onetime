import { createCipheriv, createDecipheriv, hkdfSync, pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../../src/web/base64url";
import { SecretTooLargeError, WRITE_FILES, createCodec, encryptFile, type LinkKey } from "../../src/web/crypto";

// ---- An independent implementation of file blobs from docs/plans/file-transfer.md, node:crypto only, with every size hard-coded. ----

const REF_BLOCKS = [1024, 4096, 16_388, 65_924, 131_460, 262_532, 524_676, 1_048_964];
const REF_BLOBS = [1054, 4126, 16_418, 65_954, 131_490, 262_562, 524_706, 1_048_994];

const hkdf = (ikm: Uint8Array, info: string, bytes: number): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info, "ascii"), bytes));

function refKey(kLink: Buffer, passphrase?: string): Buffer {
  if (passphrase === undefined) return hkdf(kLink, "onetime v2 key", 32);
  const salt = hkdf(kLink, "onetime v2 pbkdf2 salt", 16);
  const p = pbkdf2Sync(Buffer.from(passphrase.normalize("NFKC").trim(), "utf8"), salt, 600000, 32, "sha256");
  return hkdf(Buffer.concat([kLink, p]), "onetime v2 key+passphrase", 32);
}

/** payload = N, name, T, type, content. */
function refPayload(name: Buffer, type: Buffer, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([type.length]), type, content]);
}

function refBlock(payload: Buffer, mutate?: (block: Buffer) => void): Buffer {
  const total = REF_BLOCKS.find((b) => b >= payload.length + 4)!;
  const block = Buffer.alloc(total);
  block.writeUInt32BE(payload.length, 0);
  payload.copy(block, 4);
  mutate?.(block);
  return block;
}

function refSeal(block: Buffer, kLink: Buffer, flags: number, passphrase?: string, opts: { aad?: boolean } = {}): Buffer {
  const header = Buffer.from([2, flags]);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", refKey(kLink, passphrase), iv);
  if (opts.aad !== false) cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(block), cipher.final()]);
  return Buffer.concat([header, iv, body, cipher.getAuthTag()]);
}

function refEncryptFile(
  file: { name: string; type: string; content: Buffer },
  kLink: Buffer,
  passphrase?: string,
): Buffer {
  const block = refBlock(refPayload(Buffer.from(file.name), Buffer.from(file.type), file.content));
  return refSeal(block, kLink, 2 | (passphrase === undefined ? 0 : 1), passphrase);
}

function refOpenFile(blob: Buffer, kLink: Buffer, passphrase?: string): { name: string; type: string; content: Buffer; block: number } {
  const decipher = createDecipheriv("aes-256-gcm", refKey(kLink, passphrase), blob.subarray(2, 14));
  decipher.setAAD(blob.subarray(0, 2));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  const block = Buffer.concat([decipher.update(blob.subarray(14, blob.length - 16)), decipher.final()]);
  const length = block.readUInt32BE(0);
  expect(block.subarray(4 + length).every((b) => b === 0)).toBe(true);
  const payload = block.subarray(4, 4 + length);
  const n = payload[0]!;
  const t = payload[1 + n]!;
  return {
    name: payload.subarray(1, 1 + n).toString("utf8"),
    type: payload.subarray(2 + n, 2 + n + t).toString("ascii"),
    content: payload.subarray(2 + n + t),
    block: block.length,
  };
}

const asBlob = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);
const fileLink = (key: string, passphrase = false): LinkKey => ({ key, format: 2, passphrase, file: true });
const textLink = (key: string, passphrase = false): LinkKey => ({ key, format: 2, passphrase, file: false });
const PASS = "correct horse battery";
const codec = createCodec({ writeFormat: 2, writeFiles: true });
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe("file blobs against an independent node:crypto implementation", () => {
  it("opens a file blob built by the reference, without a passphrase", async () => {
    const kLink = randomBytes(32);
    const content = randomBytes(2000);
    const blob = refEncryptFile({ name: "résumé.pdf", type: "application/pdf", content }, kLink);
    expect(blob.length).toBe(4126);
    expect(blob[1]).toBe(2);
    const opened = await codec.openPayload(asBlob(blob), await codec.deriveKey(fileLink(toBase64Url(kLink))), fileLink(toBase64Url(kLink)));
    expect(opened.kind).toBe("file");
    if (opened.kind !== "file") return;
    expect(opened.name).toBe("résumé.pdf");
    expect(opened.type).toBe("application/pdf");
    expect(sameBytes(opened.bytes, content)).toBe(true);
  });

  it("opens a file blob built by the reference, with a passphrase (real 600,000 iterations)", async () => {
    const kLink = randomBytes(32);
    const blob = refEncryptFile({ name: "t.txt", type: "", content: Buffer.from("hello") }, kLink, PASS);
    expect(blob[1]).toBe(3);
    const link = fileLink(toBase64Url(kLink), true);
    const opened = await codec.openPayload(asBlob(blob), await codec.deriveKey(link, PASS), link);
    expect(opened).toMatchObject({ kind: "file", name: "t.txt", type: "" });
  });

  it("the reference opens what encryptFile makes, with and without a passphrase", async () => {
    const content = randomBytes(700);
    for (const passphrase of [undefined, PASS]) {
      const made = await codec.encryptFile({ name: "data.bin", type: "application/octet-stream", bytes: new Uint8Array(content) }, passphrase);
      expect(made).toMatchObject({ format: 2, passphrase: passphrase !== undefined, file: true });
      expect(made.blob[0]).toBe(2);
      expect(made.blob[1]).toBe(passphrase === undefined ? 2 : 3);
      const out = refOpenFile(Buffer.from(made.blob), Buffer.from(fromBase64Url(made.key)), passphrase);
      expect(out).toMatchObject({ name: "data.bin", type: "application/octet-stream" });
      expect(out.content.equals(content)).toBe(true);
    }
  });

  it("uses the eight blob sizes, with hard-coded boundaries (meta: 5-byte name, no type)", async () => {
    // payload = 1 + 5 + 1 + 0 + content = content + 7; the block needs payload + 4.
    const cases: Array<[number, number]> = [
      [1, 1054],
      [1013, 1054],
      [1014, 4126],
      [4085, 4126],
      [4086, 16_418],
      [16_377, 16_418],
      [16_378, 65_954],
      [65_913, 65_954],
      [65_914, 131_490],
      [131_449, 131_490],
      [131_450, 262_562],
      [262_521, 262_562],
      [262_522, 524_706],
      [524_665, 524_706],
      [524_666, 1_048_994],
      [1_048_576, 1_048_994],
    ];
    for (const [size, blobSize] of cases) {
      const bytes = new Uint8Array(size).fill(7);
      const made = await codec.encryptFile({ name: "a.bin", type: "", bytes });
      expect(made.blob.length, `content ${size}`).toBe(blobSize);
      expect(REF_BLOBS).toContain(made.blob.length);
    }
  }, 120_000);

  it("round trips a 1 MiB file through encryptFile and openPayload", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(65_536));
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i += bytes.length) big.set(bytes, i);
    const made = await codec.encryptFile({ name: "big.dat", type: "", bytes: big });
    expect(made.blob.length).toBe(1_048_994);
    const link = fileLink(made.key);
    const opened = await codec.openPayload(made.blob, await codec.deriveKey(link), link);
    expect(opened.kind === "file" && sameBytes(opened.bytes, big)).toBe(true);
  }, 120_000);

  it("stores the sanitised name, and no name or type appears in the blob", async () => {
    const made = await codec.encryptFile({ name: "../../etc/passwd", type: "Text/Plain; charset=utf-8", bytes: new Uint8Array([1, 2, 3]) });
    const out = refOpenFile(Buffer.from(made.blob), Buffer.from(fromBase64Url(made.key)));
    expect(out.name).toBe("passwd");
    expect(out.type).toBe("text/plain");
    expect(Buffer.from(made.blob).includes("passwd")).toBe(false);
  });
});

describe("a text opened as a file, a file as text, and flag mismatches all fail", () => {
  async function fails(blob: Uint8Array<ArrayBuffer>, link: LinkKey, passphrase?: string): Promise<void> {
    await expect(
      (async () => codec.openPayload(blob, await codec.deriveKey(link, passphrase), link))(),
    ).rejects.toThrow();
  }

  it("flags 0x02 under a 2. link and 0x00 under a 2f. link", async () => {
    const kLink = randomBytes(32);
    const key = toBase64Url(kLink);
    const fileBlob = asBlob(refEncryptFile({ name: "a", type: "", content: Buffer.from("x") }, kLink));
    await fails(fileBlob, textLink(key));
    const textBlock = Buffer.alloc(256);
    textBlock.writeUInt32BE(1, 0);
    textBlock.write("x", 4);
    const textBlob = asBlob(refSeal(textBlock, kLink, 0));
    await fails(textBlob, fileLink(key));
  });

  it("flags 0x03 under 2f, 0x01 under 2fp, 0x02 under 2fp (both directions of the passphrase bit)", async () => {
    const kLink = randomBytes(32);
    const key = toBase64Url(kLink);
    const block = refBlock(refPayload(Buffer.from("a"), Buffer.alloc(0), Buffer.from("x")));
    await fails(asBlob(refSeal(block, kLink, 3)), fileLink(key));
    await fails(asBlob(refSeal(block, kLink, 2)), fileLink(key, true), PASS);
    await fails(asBlob(refSeal(block, kLink, 1)), fileLink(key, true), PASS);
  });

  it("a header flipped after sealing: the AAD no longer matches", async () => {
    const made = await codec.encryptFile({ name: "a", type: "", bytes: new Uint8Array([1]) });
    // Flip bit 1 and make the link agree with the new flag: only the AAD can catch it.
    made.blob[1] = 0;
    await fails(made.blob, textLink(made.key));
  });

  it("a flipped bit in the IV, the ciphertext and the tag", async () => {
    const made = await codec.encryptFile({ name: "a", type: "", bytes: new Uint8Array([1]) });
    for (const at of [2, 20, 500, made.blob.length - 1]) {
      const copy = made.blob.slice();
      copy[at]! ^= 1;
      await fails(copy, fileLink(made.key));
    }
  });

  it("a blob sealed without AAD, flag and link agreeing", async () => {
    const kLink = randomBytes(32);
    const block = refBlock(refPayload(Buffer.from("a"), Buffer.alloc(0), Buffer.from("x")));
    await fails(asBlob(refSeal(block, kLink, 2, undefined, { aad: false })), fileLink(toBase64Url(kLink)));
  });

  it("a blob length that is not one of the eight sizes", async () => {
    const made = await codec.encryptFile({ name: "a", type: "", bytes: new Uint8Array([1]) });
    await fails(made.blob.slice(0, made.blob.length - 1), fileLink(made.key));
    const longer = new Uint8Array(made.blob.length + 1);
    longer.set(made.blob);
    await fails(longer, fileLink(made.key));
    // A 286-byte text-sized blob is not a file size either.
    const kLink = randomBytes(32);
    const small = Buffer.alloc(256);
    small.writeUInt32BE(1, 0);
    small.write("a", 4);
    await fails(asBlob(refSeal(small, kLink, 2)), fileLink(toBase64Url(kLink)));
  });

  it("a text link never opens a file-sized blob, and openBlob (text) refuses a file link", async () => {
    const kLink = randomBytes(32);
    const key = toBase64Url(kLink);
    const big = refBlock(refPayload(Buffer.from("a"), Buffer.alloc(0), randomBytes(70_000)));
    await fails(asBlob(refSeal(big, kLink, 0)), textLink(key));
    const made = await codec.encryptFile({ name: "a", type: "", bytes: new Uint8Array([1]) });
    const link = fileLink(made.key);
    await expect(codec.openBlob(made.blob, await codec.deriveKey(link), link)).rejects.toThrow();
  });

  it("payloads the reader must refuse even with a valid tag", async () => {
    const kLink = randomBytes(32);
    const key = toBase64Url(kLink);
    const ok = (content = Buffer.from("x")) => refPayload(Buffer.from("a.txt"), Buffer.alloc(0), content);
    const seal = (payload: Buffer, mutate?: (b: Buffer) => void) => asBlob(refSeal(refBlock(payload, mutate), kLink, 2));
    const open = async (blob: Uint8Array<ArrayBuffer>) => codec.openPayload(blob, await codec.deriveKey(fileLink(key)), fileLink(key));
    await expect(open(seal(ok()))).resolves.toMatchObject({ kind: "file", name: "a.txt" });
    await expect(open(seal(refPayload(Buffer.alloc(0), Buffer.alloc(0), Buffer.from("x"))))).rejects.toThrow(); // N = 0
    await expect(open(seal(refPayload(Buffer.from([0x61, 0xff]), Buffer.alloc(0), Buffer.from("x"))))).rejects.toThrow(); // bad UTF-8
    await expect(open(seal(refPayload(Buffer.from("a"), Buffer.alloc(0), Buffer.alloc(0))))).rejects.toThrow(); // empty content
    await expect(open(seal(ok(), (b) => (b[b.length - 1] = 1)))).rejects.toThrow(); // nonzero padding
    await expect(open(seal(ok(), (b) => b.writeUInt32BE(b.length, 0)))).rejects.toThrow(); // length overruns the block
    await expect(open(seal(refPayload(Buffer.from("a"), Buffer.alloc(128, 0x61), Buffer.from("x"))))).rejects.toThrow(); // T = 128
  });

  it("a file link in format 1 is refused before any key is derived", async () => {
    await expect(codec.deriveKey({ key: toBase64Url(randomBytes(32)), format: 1, passphrase: false, file: true })).rejects.toThrow();
  });
});

describe("openPayload on text", () => {
  it("returns the text for a text link, unchanged behaviour", async () => {
    const made = await codec.encryptSecret("héllo");
    const link = textLink(made.key);
    expect(await codec.openPayload(made.blob, await codec.deriveKey(link), link)).toEqual({ kind: "text", text: "héllo" });
  });
  it("still reads format 1", async () => {
    const v1 = createCodec({ writeFormat: 1 });
    const made = await v1.encryptSecret("abc");
    const link: LinkKey = { key: made.key, format: 1, passphrase: false, file: false };
    expect(await v1.openPayload(made.blob, await v1.deriveKey(link), link)).toEqual({ kind: "text", text: "abc" });
  });
});

describe("writing files is off until deploy F2", () => {
  it("WRITE_FILES is false and the default encryptFile refuses", async () => {
    expect(WRITE_FILES).toBe(false);
    await expect(encryptFile({ name: "a", type: "", bytes: new Uint8Array([1]) })).rejects.toThrow("not available");
  });
  it("a codec with writeFiles off refuses; one with it on works", async () => {
    await expect(createCodec({ writeFormat: 2, writeFiles: false }).encryptFile({ name: "a", type: "", bytes: new Uint8Array([1]) })).rejects.toThrow();
    await expect(codec.encryptFile({ name: "a", type: "", bytes: new Uint8Array([1]) })).resolves.toBeDefined();
  });
  it("refuses empty content, content above 1 MiB and a bad passphrase", async () => {
    await expect(codec.encryptFile({ name: "a", type: "", bytes: new Uint8Array(0) })).rejects.toThrow();
    await expect(codec.encryptFile({ name: "a", type: "", bytes: new Uint8Array(1024 * 1024 + 1) })).rejects.toBeInstanceOf(SecretTooLargeError);
    await expect(codec.encryptFile({ name: "a", type: "", bytes: new Uint8Array([1]) }, "short")).rejects.toThrow();
  });
});
