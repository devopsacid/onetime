import { KEY_PATTERN, MAX_SECRET_BYTES, V2_BUCKETS } from "../shared/limits";
import { fromBase64Url, toBase64Url } from "./base64url";
import { pad, unpad } from "./padding";
import { normalizePassphrase, validatePassphrase } from "./passphrase";

/**
 * Which blob format this build writes. Deploy 1 reads both formats and writes format 1;
 * deploy 2 flips it to 2 (docs/plans/blob-v2.md). Passphrases need format 2.
 */
export const WRITE_FORMAT: 1 | 2 = 1;

/** The part of a link the crypto needs. */
export interface LinkKey {
  key: string;
  format: 1 | 2;
  passphrase: boolean;
}

/** The derived AES-GCM key (a CryptoKey; spelled this way because the Worker tsconfig has no DOM types). */
export type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export class SecretTooLargeError extends Error {}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const V2_HEADER_BYTES = 2;
const V2_FIXED_BYTES = V2_HEADER_BYTES + IV_BYTES + TAG_BYTES;
const V2_BLOB_SIZES: readonly number[] = V2_BUCKETS.map((bucket) => bucket + V2_FIXED_BYTES);
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

export function createCodec(opts: { pbkdf2Iterations?: number; writeFormat?: 1 | 2 } = {}) {
  const iterations = opts.pbkdf2Iterations ?? PBKDF2_ITERATIONS;
  const writeFormat = opts.writeFormat ?? WRITE_FORMAT;

  /** The slow step (PBKDF2 when a passphrase is used). Makes no network request. */
  async function deriveKey(link: LinkKey, passphrase?: string): Promise<AesKey> {
    if (!KEY_PATTERN.test(link.key)) throw new Error("Invalid key");
    if (link.passphrase !== (passphrase !== undefined)) throw new Error("Passphrase does not match the link");
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

  /** Throws if the key is wrong, the blob was changed, or it does not fit the link. */
  async function openBlob(blob: Uint8Array<ArrayBuffer>, aesKey: AesKey, link: LinkKey): Promise<string> {
    let plain: Uint8Array<ArrayBuffer>;
    if (link.format === 1) {
      if (blob.length < IV_BYTES + TAG_BYTES) throw failed();
      plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, IV_BYTES) }, aesKey, blob.subarray(IV_BYTES)),
      );
    } else {
      if (!V2_BLOB_SIZES.includes(blob.length)) throw failed();
      if (blob[0] !== 2 || blob[1] !== (link.passphrase ? 1 : 0)) throw failed();
      const inner = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: blob.subarray(V2_HEADER_BYTES, V2_HEADER_BYTES + IV_BYTES), additionalData: blob.subarray(0, V2_HEADER_BYTES) },
          aesKey,
          blob.subarray(V2_HEADER_BYTES + IV_BYTES),
        ),
      );
      try {
        plain = unpad(inner);
      } catch {
        throw failed();
      }
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
    } catch {
      throw failed();
    }
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
  ): Promise<{ blob: Uint8Array<ArrayBuffer>; key: string; format: 1 | 2; passphrase: boolean }> {
    const plain = new TextEncoder().encode(text);
    if (plain.byteLength > MAX_SECRET_BYTES) throw new SecretTooLargeError();
    if (passphrase !== undefined && writeFormat !== 2) throw new Error("A passphrase needs format 2");

    const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const link: LinkKey = { key, format: writeFormat, passphrase: passphrase !== undefined };
    const aesKey = await deriveKey(link, passphrase);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

    if (writeFormat === 1) {
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plain);
      const blob = new Uint8Array(IV_BYTES + cipher.byteLength);
      blob.set(iv, 0);
      blob.set(new Uint8Array(cipher), IV_BYTES);
      return { blob, key, format: 1, passphrase: false };
    }
    const header = new Uint8Array([2, link.passphrase ? 1 : 0]);
    const inner = pad(plain);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, aesKey, inner));
    const blob = new Uint8Array(V2_HEADER_BYTES + IV_BYTES + cipher.byteLength);
    blob.set(header, 0);
    blob.set(iv, V2_HEADER_BYTES);
    blob.set(cipher, V2_HEADER_BYTES + IV_BYTES);
    return { blob, key, format: 2, passphrase: link.passphrase };
  }

  return { encryptSecret, deriveKey, openBlob, decryptSecret };
}

export const { encryptSecret, deriveKey, openBlob, decryptSecret } = createCodec();
