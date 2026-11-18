import { KEY_PATTERN, MAX_SECRET_BYTES } from "../shared/limits";
import { fromBase64Url, toBase64Url } from "./base64url";

const IV_BYTES = 12;

export class SecretTooLargeError extends Error {}

function importKey(raw: Uint8Array<ArrayBuffer>, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

/**
 * Encrypts with a fresh AES-256-GCM key. Returns the blob for the server
 * (IV followed by ciphertext) and the key, which must stay in the link.
 */
export async function encryptSecret(text: string): Promise<{ blob: Uint8Array<ArrayBuffer>; key: string }> {
  const plain = new TextEncoder().encode(text);
  if (plain.byteLength > MAX_SECRET_BYTES) throw new SecretTooLargeError();

  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(rawKey, "encrypt"), plain);

  const blob = new Uint8Array(IV_BYTES + cipher.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(cipher), IV_BYTES);
  return { blob, key: toBase64Url(rawKey) };
}

/** Throws if the key is wrong or the blob was changed. */
export async function decryptSecret(blob: Uint8Array<ArrayBuffer>, key: string): Promise<string> {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid key");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.subarray(0, IV_BYTES) },
    await importKey(fromBase64Url(key), "decrypt"),
    blob.subarray(IV_BYTES),
  );
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
}
