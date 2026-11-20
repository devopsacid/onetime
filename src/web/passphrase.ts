export type PassphraseProblem = "too-short" | "too-long" | "control";

export const PASSPHRASE_MIN = 8;
export const PASSPHRASE_MAX = 256;

/** NFKC so compatibility forms typed on other keyboards match; trimmed so pasted spaces at the ends are harmless. */
export function normalizePassphrase(raw: string): string {
  return raw.normalize("NFKC").trim();
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Checks the normalised value: 8 to 256 code points, no control characters. Returns null when fine. */
export function validatePassphrase(raw: string): PassphraseProblem | null {
  const text = normalizePassphrase(raw);
  if (CONTROL.test(text)) return "control";
  const length = [...text].length;
  if (length < PASSPHRASE_MIN) return "too-short";
  if (length > PASSPHRASE_MAX) return "too-long";
  return null;
}
