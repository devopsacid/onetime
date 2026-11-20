import { FILE_BUCKETS, FILE_META_MAX, FORMAT_MAX_FILE_BYTES, KEY_PATTERN, MAX_FILE_BYTES, MAX_SECRET_BYTES, V2_BUCKETS } from "../shared/limits";
import { fromBase64Url, toBase64Url } from "./base64url";
import { decodeFilePayload, encodeFilePayload, type FileParts } from "./file-payload";
import { pad, unpad } from "./padding";
import { normalizePassphrase, validatePassphrase } from "./passphrase";

/**
 * Which blob format this build writes. Deploy 1 reads both formats and writes format 1;
 * deploy 2 flips it to 2 (docs/plans/blob-v2.md). Passphrases need format 2.
 */
export const WRITE_FORMAT: 1 | 2 = 1;

/**
 * Whether this build may create file blobs (links 2f / 2fp). Deploy F1 reads files and keeps this false;
 * deploy F2 flips it together with WRITE_FORMAT (docs/plans/file-transfer.md).
 */
export const WRITE_FILES = false;

/** The part of a link the crypto needs. */
export interface LinkKey {
  key: string;
  format: 1 | 2;
  passphrase: boolean;
  /** The blob is a file (2f, 2fp): flags bit 1, file block sizes. Needs format 2. */
  file: boolean;
}

/** What a blob holds: text, or a file whose name and type are already sanitised (see file-payload.ts). */
export type OpenedPayload = { kind: "text"; text: string } | ({ kind: "file" } & FileParts);

/** The derived AES-GCM key (a CryptoKey; spelled this way because the Worker tsconfig has no DOM types). */
export type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export class SecretTooLargeError extends Error {}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const V2_HEADER_BYTES = 2;
const V2_FIXED_BYTES = V2_HEADER_BYTES + IV_BYTES + TAG_BYTES;
const V2_BLOB_SIZES: readonly number[] = V2_BUCKETS.map((bucket) => bucket + V2_FIXED_BYTES);
const FILE_BLOB_SIZES: readonly number[] = FILE_BUCKETS.map((bucket) => bucket + V2_FIXED_BYTES);
/** Largest payload a file block may declare: the largest file of the format (readers are lenient) plus the largest meta without its 4-byte prefix. */
const MAX_FILE_PAYLOAD = FORMAT_MAX_FILE_BYTES + FILE_META_MAX - 4;
export const PBKDF2_ITERATIONS = 600_000;

const ascii = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));
const NO_SALT = new ArrayBuffer(0);

function failed(): Error {
  return new Error("Decryption failed");
}

function hkdfParams(info: string) {
  return { name: "HKDF", hash: "SHA-256", salt: NO_SALT, info: ascii(info) } as const;
}

const AES_USAGES: Array<"encrypt" | "decrypt"> = ["encrypt", "decrypt"];

export function createCodec(opts: { pbkdf2Iterations?: number; writeFormat?: 1 | 2; writeFiles?: boolean } = {}) {
  const iterations = opts.pbkdf2Iterations ?? PBKDF2_ITERATIONS;
  const writeFormat = opts.writeFormat ?? WRITE_FORMAT;
  const writeFiles = opts.writeFiles ?? WRITE_FILES;

  /** The slow step (PBKDF2 when a passphrase is used). Makes no network request. */
  async function deriveKey(link: LinkKey, passphrase?: string): Promise<AesKey> {
    if (!KEY_PATTERN.test(link.key)) throw new Error("Invalid key");
    if (link.passphrase !== (passphrase !== undefined)) throw new Error("Passphrase does not match the link");
    if (link.file && link.format !== 2) throw new Error("Format 1 has no files");
    const kLink = fromBase64Url(link.key);
    try {
      if (link.format === 1) {
        if (link.passphrase) throw new Error("Format 1 has no passphrase");
        return await crypto.subtle.importKey("raw", kLink, "AES-GCM", false, AES_USAGES);
      }
      const hkdfKey = (ikm: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey", "deriveBits"]);
      const aes = { name: "AES-GCM", length: 256 } as const;
      if (passphrase === undefined) {
        return await crypto.subtle.deriveKey(hkdfParams("onetime v2 key"), await hkdfKey(kLink), aes, false, AES_USAGES);
      }
      if (validatePassphrase(passphrase) !== null) throw new Error("Invalid passphrase");
      const salt = await crypto.subtle.deriveBits(hkdfParams("onetime v2 pbkdf2 salt"), await hkdfKey(kLink), 128);
      const password = new TextEncoder().encode(normalizePassphrase(passphrase));
      let p: Uint8Array<ArrayBuffer>;
      try {
        const base = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
        p = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
      } finally {
        password.fill(0);
      }
      const ikm = new Uint8Array(kLink.length + p.length);
      ikm.set(kLink, 0);
      ikm.set(p, kLink.length);
      try {
        return await crypto.subtle.deriveKey(hkdfParams("onetime v2 key+passphrase"), await hkdfKey(ikm), aes, false, AES_USAGES);
      } finally {
        p.fill(0);
        ikm.fill(0);
      }
    } finally {
      kLink.fill(0);
    }
  }

  /** The flags byte (blob byte 1) a link implies: bit 0 passphrase, bit 1 file. */
  const flagsOf = (link: LinkKey): number => (link.passphrase ? 1 : 0) | (link.file ? 2 : 0);

  /** Throws (always the same error) if the key is wrong, the blob was changed, or it does not fit the link. */
  async function openPayload(blob: Uint8Array<ArrayBuffer>, aesKey: AesKey, link: LinkKey): Promise<OpenedPayload> {
    if (link.format === 1) {
      if (link.file || blob.length < IV_BYTES + TAG_BYTES) throw failed();
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, IV_BYTES) }, aesKey, blob.subarray(IV_BYTES)),
      );
      return { kind: "text", text: decodeText(plain) };
    }
    if (!(link.file ? FILE_BLOB_SIZES : V2_BLOB_SIZES).includes(blob.length)) throw failed();
    if (blob[0] !== 2 || blob[1] !== flagsOf(link)) throw failed();
    const inner = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: blob.subarray(V2_HEADER_BYTES, V2_HEADER_BYTES + IV_BYTES), additionalData: blob.subarray(0, V2_HEADER_BYTES) },
        aesKey,
        blob.subarray(V2_HEADER_BYTES + IV_BYTES),
      ),
    );
    try {
      if (link.file) return { kind: "file", ...decodeFilePayload(unpad(inner, FILE_BUCKETS, MAX_FILE_PAYLOAD)) };
      return { kind: "text", text: decodeText(unpad(inner)) };
    } catch {
      throw failed();
    } finally {
      inner.fill(0);
    }
  }

  function decodeText(plain: Uint8Array<ArrayBuffer>): string {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
    } catch {
      throw failed();
    }
  }

  /** Text only: a file link throws, so a caller that has no file support never shows file bytes as text. */
  async function openBlob(blob: Uint8Array<ArrayBuffer>, aesKey: AesKey, link: LinkKey): Promise<string> {
    if (link.file) throw failed();
    const opened = await openPayload(blob, aesKey, link);
    if (opened.kind !== "text") throw failed();
    return opened.text;
  }

  async function decryptSecret(blob: Uint8Array<ArrayBuffer>, link: LinkKey, passphrase?: string): Promise<string> {
    return openBlob(blob, await deriveKey(link, passphrase), link);
  }

  /**
   * Encrypts with a fresh random link key. Returns the blob for the server and the key, which
   * must stay in the link. A passphrase needs format 2.
   */
  async function encryptSecret(
    text: string,
    passphrase?: string,
  ): Promise<{ blob: Uint8Array<ArrayBuffer>; key: string; format: 1 | 2; passphrase: boolean; file: false }> {
    const plain = new TextEncoder().encode(text);
    if (plain.byteLength > MAX_SECRET_BYTES) throw new SecretTooLargeError();
    if (passphrase !== undefined && writeFormat !== 2) throw new Error("A passphrase needs format 2");

    const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const link: LinkKey = { key, format: writeFormat, passphrase: passphrase !== undefined, file: false };
    const aesKey = await deriveKey(link, passphrase);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

    if (writeFormat === 1) {
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plain);
      const blob = new Uint8Array(IV_BYTES + cipher.byteLength);
      blob.set(iv, 0);
      blob.set(new Uint8Array(cipher), IV_BYTES);
      return { blob, key, format: 1, passphrase: false, file: false };
    }
    const header = new Uint8Array([2, link.passphrase ? 1 : 0]);
    const inner = pad(plain);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, aesKey, inner));
    const blob = new Uint8Array(V2_HEADER_BYTES + IV_BYTES + cipher.byteLength);
    blob.set(header, 0);
    blob.set(iv, V2_HEADER_BYTES);
    blob.set(cipher, V2_HEADER_BYTES + IV_BYTES);
    return { blob, key, format: 2, passphrase: link.passphrase, file: false };
  }

  /**
   * Encrypts a file (blob v2 with the file flag) with a fresh random link key. Needs WRITE_FILES. The caller checks the size
   * first (see MAX_FILE_BYTES); content above it throws SecretTooLargeError, empty content throws.
   */
  async function encryptFile(
    file: { name: string; type: string; bytes: Uint8Array },
    passphrase?: string,
  ): Promise<{ blob: Uint8Array<ArrayBuffer>; key: string; format: 2; passphrase: boolean; file: true }> {
    if (!writeFiles) throw new Error("Sending files is not available yet");
    if (file.bytes.byteLength === 0) throw new Error("The file is empty");
    if (file.bytes.byteLength > MAX_FILE_BYTES) throw new SecretTooLargeError();

    const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const link: LinkKey = { key, format: 2, passphrase: passphrase !== undefined, file: true };
    const aesKey = await deriveKey(link, passphrase);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const header = new Uint8Array([2, flagsOf(link)]);
    const payload = encodeFilePayload(file);
    const inner = pad(payload, FILE_BUCKETS);
    try {
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, aesKey, inner));
      const blob = new Uint8Array(V2_HEADER_BYTES + IV_BYTES + cipher.byteLength);
      blob.set(header, 0);
      blob.set(iv, V2_HEADER_BYTES);
      blob.set(cipher, V2_HEADER_BYTES + IV_BYTES);
      return { blob, key, format: 2, passphrase: link.passphrase, file: true };
    } finally {
      payload.fill(0);
      inner.fill(0);
    }
  }

  return { encryptSecret, encryptFile, deriveKey, openBlob, openPayload, decryptSecret };
}

export const { encryptSecret, encryptFile, deriveKey, openBlob, openPayload, decryptSecret } = createCodec();
