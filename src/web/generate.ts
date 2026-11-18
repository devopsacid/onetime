import { toBase64Url } from "./base64url";

export const CHARSETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!#$%&*+-=?@^_~",
} as const;

export type CharsetName = keyof typeof CHARSETS;

const LOOKALIKES = /[Il1O0o]/g;

export const PASSWORD_LENGTH = { min: 8, max: 128, default: 24 };
export const TOKEN_BYTES = { min: 16, max: 64, default: 32 };

/** Uniform integer in [0, max) from the system CSPRNG; rejection sampling avoids modulo bias. */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max < 1 || max > 2 ** 32) throw new RangeError("max out of range");
  const limit = Math.floor(2 ** 32 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0]!;
    if (value < limit) return value % max;
  }
}

export interface PasswordOptions {
  length: number;
  sets: CharsetName[];
  avoidLookalikes: boolean;
}

/** Random password that contains at least one character from every chosen set. */
export function generatePassword({ length, sets, avoidLookalikes }: PasswordOptions): string {
  if (sets.length === 0) throw new RangeError("Choose at least one character set");
  if (!Number.isInteger(length) || length < PASSWORD_LENGTH.min || length > PASSWORD_LENGTH.max) {
    throw new RangeError("Length out of range");
  }
  const pools = sets.map((name) => (avoidLookalikes ? CHARSETS[name].replace(LOOKALIKES, "") : CHARSETS[name]));
  const alphabet = pools.join("");

  // Redraw the whole password until every set is present: this keeps all valid passwords equally likely.
  for (;;) {
    let password = "";
    for (let i = 0; i < length; i++) password += alphabet[randomInt(alphabet.length)];
    if (pools.every((pool) => [...password].some((char) => pool.includes(char)))) return password;
  }
}

export function generateToken(bytes: number, format: "hex" | "base64url"): string {
  if (!Number.isInteger(bytes) || bytes < TOKEN_BYTES.min || bytes > TOKEN_BYTES.max) {
    throw new RangeError("Size out of range");
  }
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  if (format === "base64url") return toBase64Url(raw);
  return Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateUuid(): string {
  return crypto.randomUUID();
}
